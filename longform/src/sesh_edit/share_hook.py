"""Share bundles from sesh-edit (#62).

After a render sesh-edit records which code and which intro made it (render_stamp(): the
repo commit, whether sesh-edit's code had unsaved changes, and the intro's fingerprint),
then calls auto_bundle(), which runs the repo's `bun scripts/share/auto.ts`: it writes
<name>.share/ next to the outputs (nothing is sent) and prints one line. Whatever goes
wrong here (no bun, not inside the repo, unsaved code, a timeout) is one logged line:
the render already succeeded and must not fail because of the bundle."""
from __future__ import annotations

import hashlib
import shutil
import subprocess
from pathlib import Path

# longform/src/sesh_edit/share_hook.py -> the repo root
REPO = Path(__file__).resolve().parents[3]
SCRIPT = REPO / "scripts" / "share" / "auto.ts"
RESULT_PREFIXES = ("Bundled for sharing", "Not bundled for sharing")
# what can't change a render (scripts/share/job.ts CODE_EXCLUDES, edit scope)
_EXCLUDES = ["*.md", "**/*.test.ts", "**/*.test.tsx", "longform/tests/**", ".github/**"]


def _sha256(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(4 << 20), b""):
            h.update(b)
    return h.hexdigest()


def intro_digest(file: Path) -> str:
    """The intro's fingerprint: its video and sidecars (.json, .flac, .wav) by name and sha256.
    Same as introDigest() in scripts/share/job.ts."""
    names = sorted({file.name, *(file.stem + e for e in (".json", ".flac", ".wav"))})
    lines = [f"{n}:{_sha256(file.parent / n)}" for n in names if (file.parent / n).exists()]
    return hashlib.sha256("\n".join(lines).encode()).hexdigest()


def code_version(cwd: Path = REPO) -> dict | None:
    """{"commit", "dirty"} for sesh-edit's code (longform/), or None outside a git checkout."""
    try:
        head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=cwd, capture_output=True, text=True, timeout=30)
        if head.returncode != 0:
            return None
        diff = subprocess.run(["git", "diff", "--name-only", "HEAD", "--", "longform",
                               *(f":(exclude){p}" for p in _EXCLUDES)], cwd=cwd, capture_output=True, text=True, timeout=30)
        return {"commit": head.stdout.strip(), "dirty": diff.returncode != 0 or bool(diff.stdout.strip())}
    except Exception:  # noqa: BLE001 - only a note in the decisions
        return None


def render_stamp(intro_file: Path | None) -> dict:
    """What decisions["render"] records for a share: the code version and the intro's fingerprint."""
    out: dict = {"code": code_version()}
    try:
        out["intro_digest"] = intro_digest(intro_file) if intro_file else None
    except OSError:
        out["intro_digest"] = None
    return out


def auto_bundle(decisions: Path, recording: str, log=print, timeout: float = 900) -> str:
    """Returns (and logs) the one line; never raises."""
    try:
        bun = shutil.which("bun")
        if not SCRIPT.exists():
            line = f"Not bundled for sharing: {SCRIPT} isn't here (sesh-edit runs outside the repo)"
        elif not bun:
            line = "Not bundled for sharing: bun isn't installed"
        else:
            r = subprocess.run([bun, str(SCRIPT), str(decisions), "--recording", str(recording)], cwd=REPO,
                               capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
            # the result line, not a warning bun printed around it
            ours = [ln.strip() for ln in (r.stdout or "").splitlines() if ln.strip().startswith(RESULT_PREFIXES)]
            line = ours[-1] if ours else f"Not bundled for sharing: no answer from the share script (exit {r.returncode})"
    except Exception as e:  # noqa: BLE001 - nothing here may fail the render
        line = f"Not bundled for sharing: {type(e).__name__}: {e}".splitlines()[0]
    log(line)
    return line
