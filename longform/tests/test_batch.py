"""sesh-batch: manifest parsing, the Dropbox link rewrite, resume logic, downloads."""
from __future__ import annotations

import functools
import http.server
import json
import shutil
import subprocess
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
    for u in ("https://example.com/v.mp4?dl=0", "https://dl.dropboxusercontent.com/s/abc/x.mp4?dl=0",
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
                 "upscale_approved": False, "sample_start": None, "sample_duration": 25.0}
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
    j = {"name": "oscar", "url": DBX, "args": [], "approved": False, "upscale": None, "upscale_approved": False,
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

def make_clip(path: Path) -> None:
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=10:duration=1",
                    "-f", "lavfi", "-i", "sine=duration=1", "-shortest", "-c:v", "libx264", "-c:a", "aac",
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
    assert batch.download(f"{base}/clip.mp4", inbox, "oscar", log=lambda m: None) == p


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
