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
