"""sesh-batch: manifest parsing, the Dropbox link rewrite, resume logic, downloads."""
from __future__ import annotations

import functools
import http.server
import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import urllib.parse
from pathlib import Path

import pytest

from sesh_edit import batch

# Fake links only: the repo is public and real share links must never be committed.
DBX = "https://www.dropbox.com/scl/fi/abc123/interview.mp4?rlkey=fakekey&st=xyz&dl=0"


# ---------------------------------------------------------------- dropbox rewrite

def q(url: str) -> dict:
    return dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(url).query))


def test_dropbox_dl0_becomes_dl1_and_keeps_rlkey():
    out = batch.dropbox_direct(DBX)
    assert q(out) == {"rlkey": "fakekey", "st": "xyz", "dl": "1"}
    assert urllib.parse.urlsplit(out).path == "/scl/fi/abc123/interview.mp4"
    assert out.startswith("https://www.dropbox.com/")


def test_dropbox_without_query_or_with_raw():
    assert q(batch.dropbox_direct("https://www.dropbox.com/s/abc/x.mov")) == {"dl": "1"}
    assert q(batch.dropbox_direct("https://dropbox.com/s/abc/x.mov?raw=1")) == {"dl": "1"}
    assert batch.dropbox_direct(batch.dropbox_direct(DBX)) == batch.dropbox_direct(DBX)  # idempotent


def test_non_dropbox_links_untouched():
    for u in ("https://example.com/v.mp4?dl=0", "https://dl.dropbox" + "usercontent.com/s/abc/x.mp4?dl=0",
              "https://notdropbox.com/x?dl=0", "C:\\Users\\me\\Videos\\x.mp4"):
        assert batch.dropbox_direct(u) == u


def test_url_ext():
    assert batch.url_ext(DBX) == ".mp4"
    assert batch.url_ext("https://www.dropbox.com/s/abc/Take%201.MOV?dl=1") == ".mov"
    assert batch.url_ext("https://www.dropbox.com/scl/fi/abc?rlkey=k") == ""


# ---------------------------------------------------------------- manifest

def write(tmp_path: Path, obj) -> Path:
    p = tmp_path / "batch.json"
    p.write_text(json.dumps(obj), encoding="utf-8")
    return p


def test_manifest_minimal_defaults(tmp_path):
    m = batch.load_manifest(write(tmp_path, {"jobs": [{"name": "oscar", "url": DBX}]}))
    j = m["jobs"][0]
    assert j == {"name": "oscar", "url": DBX, "args": [], "approved": False, "upscale": None,
                 "sample_start": None, "sample_duration": 25.0}
    assert (m["in_dir"], m["out_dir"]) == batch.default_dirs()


def test_manifest_full(tmp_path):
    m = batch.load_manifest(write(tmp_path, {
        "in_dir": str(tmp_path / "in"), "out_dir": str(tmp_path / "out"),
        "jobs": [{"name": "mira-2", "url": DBX, "args": ["--cut", "20:03-20:29", "--av-offset", 0.08],
                  "upscale": True, "approved": True}]}))
    j = m["jobs"][0]
    assert m["in_dir"] == tmp_path / "in"
    assert j["args"] == ["--cut", "20:03-20:29", "--av-offset", "0.08"]
    assert j["upscale"] == "x4plus" and j["approved"] is True


@pytest.mark.parametrize("given,seconds", [(90, 90.0), (12.5, 12.5), ("90", 90.0), ("1:30", 90.0),
                                           ("10:00.5", 600.5), ("1:02:03", 3723.0)])
def test_manifest_sample_start(tmp_path, given, seconds):
    m = batch.load_manifest(write(tmp_path, {"jobs": [{"name": "a", "url": DBX, "sample_start": given}]}))
    assert m["jobs"][0]["sample_start"] == seconds


def test_manifest_bare_list(tmp_path):
    assert batch.load_manifest(write(tmp_path, [{"name": "a", "url": DBX}]))["jobs"][0]["name"] == "a"


@pytest.mark.parametrize("jobs,msg", [
    ([], "expected"),
    ([{"url": DBX}], "name"),
    ([{"name": "../x", "url": DBX}], "name"),
    ([{"name": "a b", "url": DBX}], "name"),
    ([{"name": "a"}], "missing url"),
    ([{"name": "a", "url": DBX}, {"name": "A", "url": DBX}], "twice"),
    ([{"name": "a", "url": DBX, "args": "--cut 1-2"}], "list"),
    ([{"name": "a", "url": DBX, "args": ["-o", "x.mp4"]}], "set by sesh-batch"),
    ([{"name": "a", "url": DBX, "args": ["--work-dir=x"]}], "set by sesh-batch"),
    ([{"name": "a", "url": DBX, "upscale": "fast"}], "upscale"),
    ([{"name": "a", "url": DBX, "flags": []}], "unknown key"),
    ([{"name": "a", "url": DBX, "upscale": True, "upscale_approved": True}], "--approve-upscale a"),
    ([{"name": "a", "url": DBX, "sample_start": "ten"}], "sample_start"),
    ([{"name": "a", "url": DBX, "sample_start": -5}], "sample_start"),
    ([{"name": "a", "url": DBX, "sample_start": "1:2:3:4"}], "sample_start"),
    ([{"name": "a", "url": DBX, "sample_duration": 0}], "sample_duration"),
])
def test_manifest_errors(tmp_path, jobs, msg):
    with pytest.raises(ValueError, match=msg):
        batch.load_manifest(write(tmp_path, {"jobs": jobs}))


def test_manifest_bad_json(tmp_path):
    p = tmp_path / "batch.json"
    p.write_text("{nope", encoding="utf-8")
    with pytest.raises(ValueError, match="not valid JSON"):
        batch.load_manifest(p)


def test_status_path_beside_manifest(tmp_path):
    assert batch.status_path(tmp_path / "week47.batch.json") == tmp_path / "week47.batch.status.json"


# ---------------------------------------------------------------- resume logic

def job(**kw):
    j = {"name": "oscar", "url": DBX, "args": [], "approved": False, "upscale": None,
         "sample_start": None, "sample_duration": 25.0}
    j.update(kw)
    return j


def touch(out, *keys):
    for k in keys:
        out[k].parent.mkdir(parents=True, exist_ok=True)
        out[k].write_bytes(b"x")


def test_resume_walks_through_the_steps(tmp_path):
    out = batch.outputs(tmp_path, "oscar")
    j = job()
    sig = batch.plan_sig(j)
    st: dict = {}
    assert batch.next_step(j, st, out) == "plan"
    touch(out, "decisions")
    assert batch.next_step(j, st, out) == "plan"  # file without a matching signature: stale
    st["planned_sig"] = sig
    assert batch.next_step(j, st, out) == "awaiting-review"
    assert batch.next_step(j, st, out, yes=True) == "render"
    st["approved_sig"] = sig
    assert batch.next_step(j, st, out) == "render"
    touch(out, "edited")
    st["rendered_sig"] = sig
    assert batch.next_step(j, st, out) == "preview"
    touch(out, "preview")
    st["preview_sig"] = sig
    assert batch.next_step(j, st, out) == "done"


def test_manifest_approval_skips_review(tmp_path):
    out = batch.outputs(tmp_path, "oscar")
    j = job(approved=True)
    touch(out, "decisions")
    assert batch.next_step(j, {"planned_sig": batch.plan_sig(j)}, out) == "render"


def test_changed_args_replan_and_need_new_approval(tmp_path):
    out = batch.outputs(tmp_path, "oscar")
    old = job()
    s = batch.plan_sig(old)
    touch(out, "decisions", "edited", "preview")
    st = {"planned_sig": s, "approved_sig": s, "rendered_sig": s, "preview_sig": s}
    assert batch.next_step(old, st, out) == "done"
    new = job(args=["--cut", "1:00-1:10"])
    assert batch.next_step(new, st, out) == "plan"
    st["planned_sig"] = batch.plan_sig(new)
    assert batch.next_step(new, st, out) == "awaiting-review"


def test_changed_url_replans(tmp_path):
    out = batch.outputs(tmp_path, "oscar")
    old = job()
    s = batch.plan_sig(old)
    touch(out, "decisions", "edited", "preview")
    st = {"planned_sig": s, "approved_sig": s, "rendered_sig": s, "preview_sig": s}
    assert batch.next_step(old, st, out) == "done"
    assert batch.next_step(job(url=DBX.replace("abc123", "def456")), st, out) == "plan"


def test_deleted_output_is_redone(tmp_path):
    out = batch.outputs(tmp_path, "oscar")
    j = job()
    s = batch.plan_sig(j)
    touch(out, "decisions", "edited")
    st = {"planned_sig": s, "approved_sig": s, "rendered_sig": s, "preview_sig": s}
    assert batch.next_step(j, st, out) == "preview"  # preview file gone


def test_no_upscale_unless_asked_then_sample_and_stop(tmp_path):
    out = batch.outputs(tmp_path, "oscar")
    j = job(upscale="x4plus")
    s = batch.plan_sig(j)
    touch(out, "decisions", "edited", "preview")
    st = {"planned_sig": s, "approved_sig": s, "rendered_sig": s, "preview_sig": s}
    assert batch.next_step(job(), st, out) == "done"
    assert batch.next_step(j, st, out, yes=True) == "upscale-sample"
    touch(out, "compare")
    u = batch.upscale_sig(j)
    st["sample_sig"] = u
    assert batch.next_step(j, st, out, yes=True) == "awaiting-upscale-approval"  # --yes never approves this
    st["upscale_approved_sig"] = u
    assert batch.next_step(j, st, out) == "upscale"
    touch(out, "edited_hd")
    st["upscaled_sig"] = u
    assert batch.next_step(j, st, out) == "done"
    # another method: new sample, new approval
    assert batch.next_step(job(upscale="lanczos"), st, out) == "upscale-sample"


# ---------------------------------------------------------------- download

def make_clip(path: Path, seconds: int = 1) -> None:
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"testsrc=size=160x90:rate=10:duration={seconds}",
                    "-f", "lavfi", "-i", f"sine=duration={seconds}", "-shortest", "-c:v", "libx264", "-c:a", "aac",
                    str(path)], check=True)


needs_ffmpeg = pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg not on PATH")


@pytest.fixture
def server(tmp_path):
    root = tmp_path / "srv"
    root.mkdir()
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(root))
    handler.log_message = lambda *a, **k: None
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield root, f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


@needs_ffmpeg
def test_download_http_then_skip(tmp_path, server):
    root, base = server
    make_clip(root / "clip.mp4")
    inbox = tmp_path / "in"
    p = batch.download(f"{base}/clip.mp4?dl=0", inbox, "oscar", log=lambda m: None)
    assert p == inbox / "oscar.mp4" and p.stat().st_size == (root / "clip.mp4").stat().st_size
    assert not (inbox / "oscar.part").exists()
    (root / "clip.mp4").unlink()  # a second run must not touch the network
    assert batch.download(f"{base}/clip.mp4?dl=0", inbox, "oscar", log=lambda m: None) == p


def test_download_html_page_is_refused(tmp_path, server):
    root, base = server
    (root / "page.html").write_text("<html>link expired</html>")
    with pytest.raises(RuntimeError, match="web page"):
        batch.download(f"{base}/page.html", tmp_path / "in", "oscar", log=lambda m: None)


@needs_ffmpeg
def test_download_not_a_video_is_set_aside(tmp_path, server):
    root, base = server
    (root / "junk.mp4").write_bytes(b"not a video at all")
    with pytest.raises(RuntimeError, match="not a readable video"):
        batch.download(f"{base}/junk.mp4", tmp_path / "in", "oscar", log=lambda m: None)
    assert (tmp_path / "in" / "oscar.mp4.bad").exists()
    assert batch.find_download(tmp_path / "in", "oscar") is None


@needs_ffmpeg
def test_download_local_path(tmp_path):
    src = tmp_path / "Take 1.MOV"
    make_clip(src.with_suffix(".mp4"))
    src.with_suffix(".mp4").rename(src)
    p = batch.download(str(src), tmp_path / "in", "oscar", log=lambda m: None)
    assert p == tmp_path / "in" / "oscar.mov"


@needs_ffmpeg
def test_download_new_link_replaces_old_file_and_part(tmp_path):
    a, b = tmp_path / "a.mp4", tmp_path / "b.mp4"
    make_clip(a)
    make_clip(b, seconds=2)
    inbox = tmp_path / "in"
    first = batch.download(str(a), inbox, "oscar", log=lambda m: None)
    (inbox / "oscar.part").write_bytes(b"half of the old link")
    assert batch.download(str(a), inbox, "oscar", log=lambda m: None) == first  # same link: kept
    second = batch.download(str(b), inbox, "oscar", log=lambda m: None)
    assert second.read_bytes() == b.read_bytes()
    assert not (inbox / "oscar.part").exists()


class RangeHandler(http.server.BaseHTTPRequestHandler):
    body = b""

    def log_message(self, *a):
        pass

    def do_GET(self):
        start = 0
        rng = self.headers.get("Range")
        if rng:
            start = int(rng.split("=")[1].rstrip("-"))
            if start >= len(self.body):
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{len(self.body)}")
                self.end_headers()
                return
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{len(self.body) - 1}/{len(self.body)}")
        else:
            self.send_response(200)
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Content-Length", str(len(self.body) - start))
        self.end_headers()
        self.wfile.write(self.body[start:])


@pytest.fixture
def range_server(tmp_path):
    clip = tmp_path / "clip.mp4"
    if shutil.which("ffmpeg"):
        make_clip(clip)
    handler = type("H", (RangeHandler,), {"body": clip.read_bytes() if clip.exists() else b""})
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield handler.body, f"http://127.0.0.1:{srv.server_address[1]}/clip.mp4"
    srv.shutdown()


@needs_ffmpeg
def test_download_resumes_a_part(tmp_path, range_server):
    body, url = range_server
    inbox = tmp_path / "in"
    inbox.mkdir()
    (inbox / "oscar.source").write_text(batch.url_sig(url))
    (inbox / "oscar.part").write_bytes(body[:1000])
    p = batch.download(url, inbox, "oscar", log=lambda m: None)
    assert p.read_bytes() == body


@needs_ffmpeg
def test_download_416_keeps_a_complete_part(tmp_path, range_server):
    body, url = range_server
    inbox = tmp_path / "in"
    inbox.mkdir()
    (inbox / "oscar.source").write_text(batch.url_sig(url))
    (inbox / "oscar.part").write_bytes(body)  # finished, but the rename never happened
    p = batch.download(url, inbox, "oscar", log=lambda m: None)
    assert p == inbox / "oscar.mp4" and p.read_bytes() == body


@needs_ffmpeg
def test_download_416_drops_a_part_that_is_too_long(tmp_path, range_server):
    body, url = range_server
    inbox = tmp_path / "in"
    inbox.mkdir()
    (inbox / "oscar.source").write_text(batch.url_sig(url))
    (inbox / "oscar.part").write_bytes(body + b"junk from something else")
    with pytest.raises(RuntimeError, match="didn't match"):
        batch.download(url, inbox, "oscar", log=lambda m: None)
    assert not (inbox / "oscar.part").exists()


# ---------------------------------------------------------------- lock + status

def dead_pid() -> int:
    p = subprocess.Popen([sys.executable, "-c", "pass"])
    p.wait()
    return p.pid


def test_lock_is_exclusive_and_released(tmp_path):
    a, b = batch.Lock(tmp_path / "m.lock"), batch.Lock(tmp_path / "m.lock")
    assert a.acquire() is None
    held = b.acquire()
    assert held["pid"] == os.getpid()
    a.release()
    assert not (tmp_path / "m.lock").exists()
    assert b.acquire() is None
    b.release()


def test_stale_lock_is_reclaimed(tmp_path):
    p = tmp_path / "m.lock"
    p.write_text(json.dumps({"pid": dead_pid(), "host": socket.gethostname(), "since": "earlier"}))
    lock = batch.Lock(p)
    assert lock.acquire() is None
    assert json.loads(p.read_text())["pid"] == os.getpid()
    lock.release()


def test_pid_alive():
    assert batch.pid_alive(os.getpid())
    assert not batch.pid_alive(dead_pid())
    assert not batch.pid_alive(0)


def test_status_set_merges_with_other_writers(tmp_path):
    path = tmp_path / "m.status.json"
    runner = batch.Status(path, tmp_path / "m.json")
    runner.set("oscar", state="planning")
    other = batch.Status(path, tmp_path / "m.json")  # e.g. `--approve oscar` from a second window
    other.set("oscar", approved_sig="abc")
    runner.set("mira", state="downloading")  # runner's in-memory copy predates the approval
    runner.set("oscar", state="awaiting-review")
    data = json.loads(path.read_text())
    assert data["jobs"]["oscar"]["approved_sig"] == "abc"
    assert data["jobs"]["oscar"]["state"] == "awaiting-review"
    assert data["jobs"]["mira"]["state"] == "downloading"


def test_approve_while_running_only_records(tmp_path, capsys):
    m = write(tmp_path, {"in_dir": str(tmp_path / "in"), "out_dir": str(tmp_path / "out"),
                         "jobs": [{"name": "oscar", "url": DBX}]})
    sig = batch.plan_sig(job())
    batch.Status(batch.status_path(m), m).set("oscar", state="awaiting-review", planned_sig=sig)
    running = batch.Lock(batch.lock_path(m))
    assert running.acquire() is None  # a batch is running (this process stands in for it)
    try:
        assert batch.main([str(m), "--approve", "oscar"]) == 0
        assert "already running" in capsys.readouterr().out
        assert batch.Status(batch.status_path(m), m).job("oscar")["approved_sig"] == sig
        assert not (tmp_path / "out").exists()  # nothing was run
        assert batch.main([str(m)]) == 2  # a second working run is refused
    finally:
        running.release()


def test_approval_recorded_during_a_run_is_picked_up(tmp_path):
    m = write(tmp_path, {"out_dir": str(tmp_path / "out"), "jobs": [{"name": "oscar", "url": DBX}]})
    man = batch.load_manifest(m)
    status = batch.Status(batch.status_path(m), m)
    out = batch.outputs(man["out_dir"], "oscar")
    touch(out, "decisions")
    j = man["jobs"][0]
    status.set("oscar", planned_sig=batch.plan_sig(j))
    opts = type("O", (), {"yes": False})
    assert batch.approved_meanwhile([j], {"oscar": "awaiting-review"}, man, status, opts) == []
    batch.Status(batch.status_path(m), m).set("oscar", approved_sig=batch.plan_sig(j))
    assert batch.approved_meanwhile([j], {"oscar": "awaiting-review"}, man, status, opts) == [j]
    assert batch.approved_meanwhile([j], {"oscar": "failed"}, man, status, opts) == []


def test_upscale_restarts_clean_when_the_cut_changed(tmp_path, monkeypatch):
    m = write(tmp_path, {"in_dir": str(tmp_path / "in"), "out_dir": str(tmp_path / "out"),
                         "jobs": [{"name": "oscar", "url": DBX, "upscale": "x4plus"}]})
    man = batch.load_manifest(m)
    j = man["jobs"][0]
    out = batch.outputs(man["out_dir"], "oscar")
    src = tmp_path / "in" / "oscar.mp4"
    touch({"src": src}, "src")
    touch(out, "decisions", "edited", "preview", "compare", "clean")
    work = out["clean_hd"].with_suffix(".upscale-work")
    (work / "chunks").mkdir(parents=True)
    (work / "chunks" / "0000.done").write_text("old cut")
    s, u = batch.plan_sig(j), batch.upscale_sig(j)
    status = batch.Status(batch.status_path(m), m)
    status.set("oscar", input=str(src), input_url=batch.url_sig(DBX), planned_sig=s, approved_sig=s,
               rendered_sig=s, preview_sig=s, sample_sig=u, upscale_approved_sig=u, upscale_run_sig="older:x4plus")
    seen = []

    def fake_run(cmd, log_path, echo=print, capture=False):
        seen.append(cmd)
        assert not (work / "chunks").exists()  # the old cut's chunks were thrown away first
        if "sesh_edit.overlay" in cmd:
            out["edited_hd"].write_bytes(b"x")
        return ""

    monkeypatch.setattr(batch, "run_tool", fake_run)
    opts = type("O", (), {"yes": False, "cleanup": False, "preview_height": 360})
    assert batch.run_job(j, man, status, opts, echo=lambda m: None) == "done"
    assert any("--work" in c and str(work) in c for c in seen)
    assert status.reload().job("oscar")["upscale_run_sig"] == u
