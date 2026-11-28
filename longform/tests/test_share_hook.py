"""The auto-bundle after a render (#62) never fails the render: every problem is one line."""
import subprocess

from sesh_edit import share_hook


def test_reports_the_share_scripts_line(monkeypatch, tmp_path):
    monkeypatch.setattr(share_hook.shutil, "which", lambda _: "/usr/bin/bun")
    seen = {}

    def fake_run(cmd, **kw):
        seen["cmd"] = cmd
        return subprocess.CompletedProcess(cmd, 0, stdout="Bundled for sharing (nothing sent yet): /x/ep.share\n", stderr="")

    monkeypatch.setattr(share_hook.subprocess, "run", fake_run)
    lines = []
    out = share_hook.auto_bundle(tmp_path / "ep.decisions.json", "/rec.mp4", log=lines.append)
    assert out.startswith("Bundled for sharing") and lines == [out]
    assert seen["cmd"][1].endswith("auto.ts") and "--recording" in seen["cmd"]


def test_no_bun_is_one_line(monkeypatch, tmp_path):
    monkeypatch.setattr(share_hook.shutil, "which", lambda _: None)
    assert share_hook.auto_bundle(tmp_path / "ep.decisions.json", "/rec.mp4", log=lambda _: None) \
        == "Not bundled for sharing: bun isn't installed"


def test_a_crash_or_timeout_never_raises(monkeypatch, tmp_path):
    monkeypatch.setattr(share_hook.shutil, "which", lambda _: "/usr/bin/bun")

    def boom(cmd, **kw):
        raise subprocess.TimeoutExpired(cmd, 900)

    monkeypatch.setattr(share_hook.subprocess, "run", boom)
    assert share_hook.auto_bundle(tmp_path / "x", "/r", log=lambda _: None).startswith("Not bundled for sharing: TimeoutExpired")


def test_outside_the_repo(monkeypatch, tmp_path):
    monkeypatch.setattr(share_hook, "SCRIPT", tmp_path / "missing.ts")
    assert "isn't here" in share_hook.auto_bundle(tmp_path / "x", "/r", log=lambda _: None)


def test_the_cli_has_no_share():
    from sesh_edit import cli
    import inspect
    assert "--no-share" in inspect.getsource(cli.main)


INTRO_DIGEST = "08313fdc53ff496287033d6e295be8c45e45c44bf986eb11f124ece7307ec206"  # also pinned in scripts/share/job.test.ts


def _intro(tmp_path):
    (tmp_path / "intro.webm").write_bytes(b"video")
    (tmp_path / "intro.json").write_bytes(b'{"open_s": 1}')
    (tmp_path / "intro.flac").write_bytes(b"sound")
    return tmp_path / "intro.webm"


def test_intro_digest_matches_the_share_scripts(tmp_path):
    assert share_hook.intro_digest(_intro(tmp_path)) == INTRO_DIGEST


def test_render_stamp_records_code_and_intro(tmp_path):
    stamp = share_hook.render_stamp(_intro(tmp_path))
    assert stamp["intro_digest"] == INTRO_DIGEST
    assert stamp["code"] is None or (len(stamp["code"]["commit"]) == 40 and isinstance(stamp["code"]["dirty"], bool))
    assert share_hook.render_stamp(None)["intro_digest"] is None


def test_a_bun_warning_doesnt_hide_the_result(monkeypatch, tmp_path):
    monkeypatch.setattr(share_hook.shutil, "which", lambda _: "/usr/bin/bun")
    seen = {}

    def fake_run(cmd, **kw):
        seen.update(kw)
        out = "Bundled for sharing (nothing sent yet): /x/Gäst Ø.share\n"
        return subprocess.CompletedProcess(cmd, 0, stdout=out, stderr="warn: bun is old\n")

    monkeypatch.setattr(share_hook.subprocess, "run", fake_run)
    line = share_hook.auto_bundle(tmp_path / "x", "/r", log=lambda _: None)
    assert line == "Bundled for sharing (nothing sent yet): /x/Gäst Ø.share"
    assert seen["encoding"] == "utf-8" and seen["errors"] == "replace"


def test_no_result_line_is_still_one_line(monkeypatch, tmp_path):
    monkeypatch.setattr(share_hook.shutil, "which", lambda _: "/usr/bin/bun")
    monkeypatch.setattr(share_hook.subprocess, "run",
                        lambda cmd, **kw: subprocess.CompletedProcess(cmd, 3, stdout="something else\n", stderr="boom\n"))
    assert share_hook.auto_bundle(tmp_path / "x", "/r", log=lambda _: None) == \
        "Not bundled for sharing: no answer from the share script (exit 3)"
