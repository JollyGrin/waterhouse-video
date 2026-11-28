"""After a render, write or refresh the episode's local share bundle (#62).

sesh-edit calls auto_bundle() once the edit is written (not with --review, not with
--no-share). It runs the repo's `bun scripts/share/auto.ts`, which writes
<name>.share/ next to the outputs (nothing is sent) and prints one line. Whatever goes
wrong here (no bun, not inside the repo, unsaved code, a timeout) is one logged line:
the render already succeeded and must not fail because of the bundle."""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

# longform/src/sesh_edit/share_hook.py -> the repo root
REPO = Path(__file__).resolve().parents[3]
SCRIPT = REPO / "scripts" / "share" / "auto.ts"


def auto_bundle(decisions: Path, recording: str, log=print, timeout: float = 900) -> str:
    """Returns (and logs) the one line; never raises."""
    try:
        bun = shutil.which("bun")
        if not SCRIPT.exists():
            line = f"Not bundled for sharing: {SCRIPT} isn't here (sesh-edit runs outside the repo)"
        elif not bun:
            line = "Not bundled for sharing: bun isn't installed"
        else:
            r = subprocess.run([bun, str(SCRIPT), str(decisions), "--recording", str(recording)],
                               cwd=REPO, capture_output=True, text=True, timeout=timeout)
            out = [ln for ln in (r.stdout + r.stderr).splitlines() if ln.strip()]
            line = out[-1] if out else f"Not bundled for sharing: no answer from the share script (exit {r.returncode})"
    except Exception as e:  # noqa: BLE001 - nothing here may fail the render
        line = f"Not bundled for sharing: {type(e).__name__}: {e}".splitlines()[0]
    log(line)
    return line
