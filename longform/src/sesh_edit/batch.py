"""sesh-batch: run a list of interviews (Dropbox links) through download -> sesh-edit -> preview.

    sesh-batch batch.json                    # plan every job, render the approved ones
    sesh-batch batch.json --yes              # plan and render straight through (no review stop)
    sesh-batch batch.json --approve oscar    # approve oscar's plan (after reading its review file)
    sesh-batch batch.json --approve-upscale oscar   # start oscar's x4plus run after checking the sample
    sesh-batch batch.json --status           # print the per-job state and exit

The manifest (JSON; never commit it, it holds share links):

    {"jobs": [
      {"name": "oscar", "url": "https://www.dropbox.com/scl/fi/<id>/x.mp4?rlkey=<key>&dl=0"},
      {"name": "mira", "url": "...", "args": ["--cut", "20:03-20:29", "--replace", "Waterhose=Waterhouse"],
       "upscale": true}
    ]}

Optional top-level keys: "in_dir", "out_dir" (default: ~/Videos/sesh-in + sesh-out on Windows,
~/Movies/waterhouse/in + out elsewhere). Optional job keys: "args" (extra sesh-edit flags),
"approved" (true = render without a review stop), "upscale" (true/"x4plus"/"lanczos"),
"upscale_approved", "sample_start" (s into the clean cut, default 25% in), "sample_duration".

Per job: download (Dropbox dl=0 -> dl=1, rlkey kept; resumes a partial download) ->
`sesh-edit --review` (plan + review list into <name>.review.txt) -> stop for approval, unless
approved -> render from that exact plan (`--from-decisions`, Fuse intro, no outro, captions) ->
<name>.preview.mp4 (small, for checking timing and sound) -> if the job asks for an upscale:
a ~25 s comparison sample (<name>.upscale-compare.mp4, original left, upscaled right) and a stop
for approval -> sesh-upscale + sesh-overlay -> <name>.edited.1080p.mp4.

State lives in <manifest>.status.json beside the manifest. Re-running the manifest skips what is
already done (outputs exist and were made from the same flags); a failed job is recorded and the
others carry on. Editing a job's "args" re-plans it and needs a new approval.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

STATES = ("queued", "downloading", "planning", "awaiting-review", "rendering", "previewing",
          "upscale-sample", "awaiting-upscale-approval", "upscaling", "done", "failed")
NAME_RX = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
VIDEO_EXTS = (".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi", ".mts")
JOB_KEYS = {"name", "url", "args", "approved", "upscale", "upscale_approved", "sample_start", "sample_duration"}
# flags that would break the batch's own bookkeeping
FORBIDDEN_ARGS = {"-o", "--output", "--review", "--from-decisions", "--work-dir"}


def now() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


# ---------------------------------------------------------------- manifest

def default_dirs() -> tuple[Path, Path]:
    home = Path.home()
    if sys.platform == "win32":
        return home / "Videos" / "sesh-in", home / "Videos" / "sesh-out"
    return home / "Movies" / "waterhouse" / "in", home / "Movies" / "waterhouse" / "out"


def load_manifest(path: Path) -> dict:
    """Parse and validate a manifest. Raises ValueError with a readable message."""
    try:
        m = json.loads(path.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError as e:
        raise ValueError(f"{path.name} is not valid JSON: {e}") from None
    if isinstance(m, list):
        m = {"jobs": m}
    if not isinstance(m, dict) or not isinstance(m.get("jobs"), list) or not m["jobs"]:
        raise ValueError(f'{path.name}: expected {{"jobs": [{{"name": ..., "url": ...}}, ...]}}')
    din, dout = default_dirs()
    out = {"in_dir": Path(m.get("in_dir") or din).expanduser(), "out_dir": Path(m.get("out_dir") or dout).expanduser(),
           "jobs": []}
    seen = set()
    for i, j in enumerate(m["jobs"]):
        where = f"job {i + 1}"
        if not isinstance(j, dict):
            raise ValueError(f"{where}: expected an object with name and url")
        name, url = j.get("name"), j.get("url")
        if not isinstance(name, str) or not NAME_RX.match(name):
            raise ValueError(f"{where}: name {name!r} must be letters, digits, '.', '_' or '-' (it becomes a file name)")
        where = f"job {name!r}"
        if name.lower() in seen:
            raise ValueError(f"{where}: name used twice")
        seen.add(name.lower())
        if not isinstance(url, str) or not url.strip():
            raise ValueError(f"{where}: missing url")
        unknown = set(j) - JOB_KEYS
        if unknown:
            raise ValueError(f"{where}: unknown key(s) {sorted(unknown)} (allowed: {sorted(JOB_KEYS)})")
        args = j.get("args", [])
        if isinstance(args, str):
            raise ValueError(f'{where}: "args" must be a list, e.g. ["--cut", "20:03-20:29"]')
        if not isinstance(args, list) or not all(isinstance(a, (str, int, float)) for a in args):
            raise ValueError(f'{where}: "args" must be a list of strings')
        args = [str(a) for a in args]
        bad = [a for a in args if a.split("=", 1)[0] in FORBIDDEN_ARGS]
        if bad:
            raise ValueError(f"{where}: {bad[0]} is set by sesh-batch itself; leave it out of args")
        up = j.get("upscale", False)
        if up is True:
            up = "x4plus"
        if up not in (False, None, "x4plus", "lanczos"):
            raise ValueError(f'{where}: "upscale" must be true, "x4plus" or "lanczos"')
        out["jobs"].append({
            "name": name, "url": url.strip(), "args": args, "approved": bool(j.get("approved", False)),
            "upscale": up or None, "upscale_approved": bool(j.get("upscale_approved", False)),
            "sample_start": j.get("sample_start"), "sample_duration": float(j.get("sample_duration", 25.0)),
        })
    return out


def plan_sig(job: dict) -> str:
    """Identifies the flags a plan was made with: changing them re-plans the job."""
    return hashlib.sha256(json.dumps(job["args"]).encode()).hexdigest()[:12]


def upscale_sig(job: dict) -> str:
    """The plan plus the upscale method: a new method needs a new sample and a new approval."""
    return f"{plan_sig(job)}:{job['upscale']}"


def status_path(manifest: Path) -> Path:
    return manifest.with_name(manifest.stem + ".status.json")


# ---------------------------------------------------------------- download

def dropbox_direct(url: str) -> str:
    """Dropbox share link -> direct download: dl=1, every other parameter (rlkey, st, e) kept."""
    u = urllib.parse.urlsplit(url)
    host = (u.hostname or "").lower()
    if not (host == "dropbox.com" or host.endswith(".dropbox.com")) or host.startswith("dl."):
        return url
    q = [(k, v) for k, v in urllib.parse.parse_qsl(u.query, keep_blank_values=True) if k not in ("dl", "raw")]
    q.append(("dl", "1"))
    return urllib.parse.urlunsplit((u.scheme or "https", u.netloc, u.path, urllib.parse.urlencode(q), ""))


def url_ext(url: str) -> str:
    ext = Path(urllib.parse.urlsplit(url).path).suffix.lower()
    return ext if ext in VIDEO_EXTS else ""


def find_download(in_dir: Path, name: str) -> Path | None:
    for p in sorted(in_dir.glob(f"{name}.*")):
        if p.suffix.lower() in VIDEO_EXTS and p.is_file():
            return p
    return None


def ffprobe_ok(path: Path) -> bool:
    try:
        p = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path)],
                           capture_output=True, text=True, timeout=120)
        return p.returncode == 0 and float(json.loads(p.stdout)["format"]["duration"]) > 0
    except Exception:
        return False


def _filename_ext(headers) -> str:
    cd = headers.get("Content-Disposition") or ""
    m = re.search(r"filename\*?=(?:UTF-8'')?\"?([^\";]+)", cd)
    return url_ext("/" + urllib.parse.unquote(m.group(1))) if m else ""


def download(url: str, in_dir: Path, name: str, log=print) -> Path:
    """Download into in_dir/<name>.<ext>, resuming <name>.part. Returns the path; raises on a bad file."""
    in_dir.mkdir(parents=True, exist_ok=True)
    have = find_download(in_dir, name)
    if have and have.stat().st_size > 0 and ffprobe_ok(have):
        log(f"  download: already have {have}")
        return have
    direct = dropbox_direct(url)
    if direct.startswith("file:") or Path(direct).exists():  # local file (tests, files already on the box)
        src = Path(urllib.request.url2pathname(urllib.parse.urlsplit(direct).path)) if direct.startswith("file:") \
            else Path(direct)
        dst = in_dir / f"{name}{src.suffix.lower() or '.mp4'}"
        shutil.copyfile(src, dst)
    else:
        part = in_dir / f"{name}.part"
        done = part.stat().st_size if part.exists() else 0
        req = urllib.request.Request(direct, headers={"User-Agent": "sesh-batch/1"})
        if done:
            req.add_header("Range", f"bytes={done}-")
        t0, last = time.time(), 0.0
        try:
            resp = urllib.request.urlopen(req, timeout=60)
        except urllib.error.HTTPError as e:
            if e.code == 416 and done:  # asked to resume past the end: the .part is complete or stale
                part.unlink()
                raise RuntimeError("partial download didn't match the file online; deleted it, re-run to start over") from None
            hint = " (link wrong, expired or deleted?)" if e.code in (403, 404, 410) else ""
            raise RuntimeError(f"download failed: HTTP {e.code} {e.reason}{hint}") from None
        with resp as r:
            ctype = (r.headers.get("Content-Type") or "").lower()
            if "text/html" in ctype:
                raise RuntimeError("the link returned a web page, not a video (expired link, or rlkey= missing?)")
            if "zip" in ctype:
                raise RuntimeError("the link is a folder (downloads as .zip); give a link to the video file itself")
            resumed = done and r.status == 206
            if done and not resumed:
                log("  download: server ignored the resume request; starting over")
                done = 0
            total = r.headers.get("Content-Length")
            total = int(total) + done if total else None
            ext = url_ext(direct) or _filename_ext(r.headers) or ".mp4"
            with open(part, "ab" if resumed else "wb") as f:
                got = done
                while True:
                    buf = r.read(1 << 20)
                    if not buf:
                        break
                    f.write(buf)
                    got += len(buf)
                    if time.time() - last > 15:
                        last = time.time()
                        pct = f" of {total / 1e6:.0f} MB ({100 * got / total:.0f}%)" if total else ""
                        log(f"  download: {got / 1e6:.0f} MB{pct}, {(got - done) / 1e6 / max(1e-3, last - t0):.1f} MB/s")
        if total and part.stat().st_size < total:
            raise RuntimeError(f"download stopped at {part.stat().st_size} of {total} bytes; re-run to resume")
        dst = in_dir / f"{name}{ext}"
        os.replace(part, dst)
    if dst.stat().st_size == 0 or not ffprobe_ok(dst):
        bad = dst.with_suffix(dst.suffix + ".bad")
        os.replace(dst, bad)
        raise RuntimeError(f"downloaded file is not a readable video (kept as {bad.name}); check the link")
    log(f"  download: {dst} ({dst.stat().st_size / 1e6:.0f} MB)")
    return dst


# ---------------------------------------------------------------- resume logic

def outputs(out_dir: Path, name: str) -> dict[str, Path]:
    b = out_dir / name
    return {
        "edited": Path(f"{b}.edited.mp4"), "srt": Path(f"{b}.edited.srt"), "clean": Path(f"{b}.clean.mp4"),
        "decisions": Path(f"{b}.decisions.json"), "review": Path(f"{b}.review.txt"),
        "preview": Path(f"{b}.preview.mp4"), "log": Path(f"{b}.log"), "work": Path(f"{b}.work"),
        "sample": Path(f"{b}.upscale-sample.mp4"), "compare": Path(f"{b}.upscale-compare.mp4"),
        "clean_hd": Path(f"{b}.clean.1080p.mp4"), "edited_hd": Path(f"{b}.edited.1080p.mp4"),
    }


def next_step(job: dict, st: dict, out: dict[str, Path], yes: bool = False) -> str:
    """The next thing to do for a job, from its status entry and the files on disk.

    Returns one of: plan, awaiting-review, render, preview, upscale-sample,
    awaiting-upscale-approval, upscale, done. (Download is checked separately: it needs the network.)"""
    sig = plan_sig(job)
    if not out["decisions"].exists() or st.get("planned_sig") != sig:
        return "plan"
    approved = yes or job["approved"] or st.get("approved_sig") == sig
    if not approved:
        return "awaiting-review"
    if not out["edited"].exists() or st.get("rendered_sig") != sig:
        return "render"
    if not out["preview"].exists() or st.get("preview_sig") != sig:
        return "preview"
    if not job["upscale"]:
        return "done"
    usig = upscale_sig(job)
    if out["edited_hd"].exists() and st.get("upscaled_sig") == usig:
        return "done"
    if not out["compare"].exists() or st.get("sample_sig") != usig:
        return "upscale-sample"
    if not (job["upscale_approved"] or st.get("upscale_approved_sig") == usig):
        return "awaiting-upscale-approval"
    return "upscale"


# ---------------------------------------------------------------- running tools

class Status:
    def __init__(self, path: Path, manifest: Path):
        self.path = path
        self.data = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        self.data.setdefault("jobs", {})
        self.data["manifest"] = str(manifest)

    def job(self, name: str) -> dict:
        return self.data["jobs"].setdefault(name, {"state": "queued"})

    def set(self, name: str, **kw) -> None:
        j = self.job(name)
        j.update(kw)
        j["updated"] = now()
        self.save()

    def save(self) -> None:
        self.data["updated"] = now()
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.data, indent=1), encoding="utf-8")
        os.replace(tmp, self.path)


def run_tool(cmd: list[str], log_path: Path, echo=print, capture: bool = False) -> str:
    """Run a command, teeing its output to log_path (and echo). Raises RuntimeError on failure."""
    env = dict(os.environ, PYTHONUNBUFFERED="1", PYTHONIOENCODING="utf-8")
    lines: list[str] = []
    with open(log_path, "a", encoding="utf-8") as lf:
        lf.write(f"\n[{now()}] $ {' '.join(cmd)}\n")
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8",
                             errors="replace", env=env)
        assert p.stdout is not None
        for line in p.stdout:
            lf.write(line)
            lf.flush()
            lines.append(line)
            echo("    " + line.rstrip())
        rc = p.wait()
    if rc != 0:
        tail = "".join(lines[-8:]).strip()
        raise RuntimeError(f"{Path(cmd[2] if cmd[1] == '-m' else cmd[0]).name} exited {rc}: {tail[-600:]}")
    return "".join(lines) if capture else ""


def py(module: str) -> list[str]:
    return [sys.executable, "-m", f"sesh_edit.{module}"]


def probe_duration(path: Path) -> float:
    p = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path)],
                       capture_output=True, text=True, check=True)
    return float(json.loads(p.stdout)["format"]["duration"])


def make_preview(src: Path, dst: Path, height: int, log_path: Path, echo=print) -> None:
    """Small file for checking timing and sound: low-res video, mono AAC, capped bitrate."""
    tmp = dst.with_name(dst.stem + ".tmp.mp4")
    run_tool(["ffmpeg", "-v", "error", "-y", "-i", str(src), "-vf", f"scale=-2:'min({height},ih)'",
              "-c:v", "libx264", "-preset", "veryfast", "-crf", "32", "-maxrate", "120k", "-bufsize", "240k",
              "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "48k", "-ac", "1", "-movflags", "+faststart",
              str(tmp)], log_path, echo)
    os.replace(tmp, dst)


def make_compare(orig: Path, upscaled: Path, start: float, dur: float, dst: Path, log_path: Path, echo=print) -> None:
    """Side by side at the upscale's height: the original scaled up plainly (left) vs the upscale
    (right), each the centre half of the frame, so detail can be compared at 1:1."""
    tmp = dst.with_name(dst.stem + ".tmp.mp4")
    fc = ("[0:v]scale=-2:{h}:flags=bicubic,crop=iw/2:ih:iw/4:0[a];"
          "[1:v]scale=-2:{h},crop=iw/2:ih:iw/4:0[b];[a][b]hstack=inputs=2,format=yuv420p[v]")
    h = int(subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=height",
                            "-of", "csv=p=0", str(upscaled)], capture_output=True, text=True, check=True).stdout.strip())
    run_tool(["ffmpeg", "-v", "error", "-y", "-ss", f"{start:.3f}", "-t", f"{dur:.3f}", "-i", str(orig),
              "-i", str(upscaled), "-filter_complex", fc.format(h=h), "-map", "[v]", "-map", "1:a?",
              "-shortest", "-c:v", "libx264", "-crf", "18", "-preset", "fast", "-c:a", "aac", "-b:a", "128k",
              str(tmp)], log_path, echo)
    os.replace(tmp, dst)


def upscale_args(method: str) -> list[str]:
    return ["--method", method] + (["--tile", "512", "--jobs", "1:1:2"] if method == "x4plus" else [])


# ---------------------------------------------------------------- one job

def run_job(job: dict, man: dict, status: Status, opts, echo=print) -> str:
    name = job["name"]
    st = status.job(name)
    out = outputs(man["out_dir"], name)
    sig = plan_sig(job)
    say = lambda m: echo(f"[{now()}] {name}: {m}")  # noqa: E731

    # download (always first: cheap if the file is already there)
    have = st.get("input")
    if not (have and Path(have).exists() and Path(have).stat().st_size > 0):
        status.set(name, state="downloading", error=None)
        say("downloading")
        src = download(job["url"], man["in_dir"], name, log=say)
        status.set(name, input=str(src))
    src = Path(status.job(name)["input"])

    while True:
        step = next_step(job, status.job(name), out, yes=opts.yes)
        if step == "plan":
            status.set(name, state="planning", error=None)
            say("planning (sesh-edit --review)")
            text = run_tool(py("cli") + [str(src), "-o", str(out["edited"]), "--review", *job["args"]],
                            out["log"], echo, capture=True)
            plan = text[text.find("=== PLAN ==="):] if "=== PLAN ===" in text else text
            dec = json.loads(out["decisions"].read_text(encoding="utf-8"))
            if not dec.get("intro"):
                plan += "\nWARNING: no intro in this plan (every Sessions edit should open with Fuse).\n"
            out["review"].write_text(
                f"{name}: plan from sesh-edit --review, {now()}\nflags: {' '.join(job['args']) or '(none)'}\n\n"
                + plan.strip() + "\n\nApprove with:  uv run sesh-batch <manifest> --approve " + name + "\n",
                encoding="utf-8")
            status.set(name, planned_sig=sig, review=str(out["review"]))
        elif step == "awaiting-review":
            status.set(name, state="awaiting-review")
            say(f"plan ready, waiting for approval: {out['review']}")
            return "awaiting-review"
        elif step == "render":
            status.set(name, state="rendering", error=None, approved_sig=sig)
            say("rendering (Fuse intro, captions)")
            run_tool(py("cli") + [str(out["decisions"]), "--from-decisions", str(out["decisions"]),
                                  "-o", str(out["edited"]), *job["args"]], out["log"], echo)
            status.set(name, rendered_sig=sig)
        elif step == "preview":
            status.set(name, state="previewing")
            say(f"preview ({opts.preview_height}p)")
            make_preview(out["edited"], out["preview"], opts.preview_height, out["log"], echo)
            status.set(name, preview_sig=sig, preview=str(out["preview"]),
                       preview_mb=round(out["preview"].stat().st_size / 1e6, 1))
            if opts.cleanup:
                shutil.rmtree(out["work"], ignore_errors=True)
                if not job["upscale"]:
                    out["clean"].unlink(missing_ok=True)
                say("cleaned up the work folder")
        elif step == "upscale-sample":
            status.set(name, state="upscale-sample")
            if not out["clean"].exists():
                raise RuntimeError(f"{out['clean'].name} is missing (deleted by --cleanup?); delete "
                                   f"{out['edited'].name} and re-run to render it again")
            total = probe_duration(out["clean"])
            dur = min(job["sample_duration"], total)
            start = job["sample_start"] if job["sample_start"] is not None else max(0.0, 0.25 * total)
            start = max(0.0, min(float(start), total - dur))
            say(f"upscale sample: {dur:.0f}s from {start:.0f}s ({job['upscale']})")
            work = Path(f"{out['sample']}.upscale-work")
            shutil.rmtree(work, ignore_errors=True)
            run_tool(py("upscale") + [str(out["clean"]), "-o", str(out["sample"]), "--work", str(work),
                                      *upscale_args(job["upscale"]), "--start", f"{start:.3f}",
                                      "--duration", f"{dur:.3f}"], out["log"], echo)
            shutil.rmtree(work, ignore_errors=True)
            make_compare(out["clean"], out["sample"], start, dur, out["compare"], out["log"], echo)
            status.set(name, sample_sig=upscale_sig(job), compare=str(out["compare"]))
        elif step == "awaiting-upscale-approval":
            status.set(name, state="awaiting-upscale-approval")
            say(f"upscale sample ready (left original, right upscaled): {out['compare']}")
            return "awaiting-upscale-approval"
        elif step == "upscale":
            status.set(name, state="upscaling", upscale_approved_sig=upscale_sig(job))
            say(f"full upscale ({job['upscale']}); resumable, re-run to continue if stopped")
            run_tool(py("upscale") + [str(out["clean"]), "-o", str(out["clean_hd"]),
                                      *upscale_args(job["upscale"])], out["log"], echo)
            run_tool(py("overlay") + [str(out["decisions"]), str(out["clean_hd"]), "-o", str(out["edited_hd"])],
                     out["log"], echo)
            status.set(name, upscaled_sig=upscale_sig(job), edited_hd=str(out["edited_hd"]))
            if opts.cleanup:
                shutil.rmtree(out["clean_hd"].with_suffix(".upscale-work"), ignore_errors=True)
        elif step == "done":
            status.set(name, state="done", error=None, edited=str(out["edited"]))
            say("done")
            return "done"


# ---------------------------------------------------------------- main

def preflight(need_llm: bool) -> list[str]:
    from . import intro

    problems = []
    for tool in ("ffmpeg", "ffprobe"):
        if not shutil.which(tool):
            problems.append(f"{tool} not on PATH")
    if need_llm and not shutil.which("claude"):
        problems.append("the claude CLI is not on PATH (sesh-edit's LLM steps need it, logged in)")
    if not intro.resolve(intro.DEFAULT_FILE).exists():
        problems.append("the Fuse intro is not built: run `bun run render:intro` at the repo root")
    return problems


def print_status(status: Status, man: dict) -> None:
    print(f"{'job':<20} {'state':<26} note")
    for job in man["jobs"]:
        st = status.data["jobs"].get(job["name"], {"state": "queued"})
        note = st.get("error") or {
            "awaiting-review": st.get("review"), "awaiting-upscale-approval": st.get("compare"),
            "done": st.get("preview") and f"preview {st.get('preview_mb')} MB: {st.get('preview')}",
        }.get(st["state"]) or ""
        print(f"{job['name']:<20} {st['state']:<26} {note}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="sesh-batch", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("manifest", help="batch manifest (JSON)")
    ap.add_argument("--yes", action="store_true", help="render every plan without stopping for review "
                    "(an upscale still stops after its sample)")
    ap.add_argument("--approve", action="append", default=[], metavar="NAME",
                    help="approve this job's current plan (repeatable; 'all' = every job awaiting review)")
    ap.add_argument("--approve-upscale", action="append", default=[], metavar="NAME",
                    help="start this job's full upscale after its sample (repeatable)")
    ap.add_argument("--only", action="append", default=[], metavar="NAME", help="run only these jobs")
    ap.add_argument("--status", action="store_true", help="print each job's state and exit")
    ap.add_argument("--preview-height", type=int, default=360, help="preview height (default 360)")
    ap.add_argument("--cleanup", action="store_true",
                    help="after a job's preview, delete its <name>.work/ cache (and the clean cut unless it "
                         "is upscaled). Saves disk; later re-plans then redo the transcription")
    opts = ap.parse_args(argv)
    for stream in (sys.stdout, sys.stderr):  # a Windows console can't print every character a transcript has
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")

    mpath = Path(opts.manifest).expanduser().resolve()
    try:
        man = load_manifest(mpath)
    except (OSError, ValueError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    status = Status(status_path(mpath), mpath)
    names = {j["name"] for j in man["jobs"]}
    for n in opts.approve + opts.approve_upscale + opts.only:
        if n not in names and n != "all":
            print(f"error: no job named {n!r} in {mpath.name}", file=sys.stderr)
            return 2

    # approvals are for the plan that exists now: a later change to the job's flags needs a new one
    for job in man["jobs"]:
        n, st = job["name"], status.job(job["name"])
        if (n in opts.approve or "all" in opts.approve) and st.get("planned_sig") == plan_sig(job):
            st["approved_sig"] = plan_sig(job)
        elif n in opts.approve:
            print(f"note: {n} has no plan yet (or its flags changed): it will be planned first, then wait again")
        if n in opts.approve_upscale and st.get("sample_sig") == upscale_sig(job):
            st["upscale_approved_sig"] = upscale_sig(job)
        elif n in opts.approve_upscale:
            print(f"note: {n} has no upscale sample for its current plan yet: it will make one, then wait again")
    status.save()
    if opts.status:
        print_status(status, man)
        return 0

    problems = preflight(need_llm=True)
    if problems:
        for p in problems:
            print(f"error: {p}", file=sys.stderr)
        return 2
    man["out_dir"].mkdir(parents=True, exist_ok=True)
    print(f"sesh-batch: {len(man['jobs'])} job(s) from {mpath.name}; in {man['in_dir']}, out {man['out_dir']}")
    print(f"status: {status.path}")
    results = {}
    for job in man["jobs"]:
        if opts.only and job["name"] not in opts.only:
            continue
        try:
            results[job["name"]] = run_job(job, man, status, opts)
        except KeyboardInterrupt:
            status.set(job["name"], state="failed", error="interrupted")
            raise
        except Exception as e:  # one bad job never stops the batch
            msg = f"{type(e).__name__}: {e}" if not isinstance(e, RuntimeError) else str(e)
            status.set(job["name"], state="failed", error=msg)
            print(f"[{now()}] {job['name']}: FAILED: {msg}", flush=True)
            results[job["name"]] = "failed"
    print("\n=== BATCH ===")
    print_status(status, man)
    return 1 if "failed" in results.values() else 0


if __name__ == "__main__":
    sys.exit(main())
