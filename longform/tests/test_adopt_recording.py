"""--from-decisions with this computer's copy of the recording: same file, and every other file
the decisions name by absolute path is here (#59 review)."""
import pytest

from sesh_edit.cli import adopt_recording

INFO = {"duration": 600.0, "width": 1280, "height": 720, "fps": 30.0, "sample_rate": 48000, "channels": 2}


def dec(**over):
    d = {"input": "/elsewhere/rec.mp4", "input_info": dict(INFO), "stats": {"input_duration_s": 600.0},
         "inserts": [], "intro": {"file": "fuse-16x9.webm"}}
    d.update(over)
    return d


def test_adopts_the_same_recording():
    d = dec()
    adopt_recording(d, "/here/rec.mp4", {**INFO, "duration": 600.2})
    assert d["input"] == "/here/rec.mp4"
    assert d["input_info"]["duration"] == 600.2


@pytest.mark.parametrize("change, msg", [({"duration": 590.0}, "590.00s"), ({"fps": 25.0}, "fps"),
                                         ({"width": 1920, "height": 1080}, "1920x1080")])
def test_rejects_a_different_recording(change, msg):
    with pytest.raises(SystemExit, match=msg):
        adopt_recording(dec(), "/here/rec.mp4", {**INFO, **change})


def test_warns_when_the_length_was_not_recorded(capsys):
    adopt_recording(dec(stats={}), "/here/rec.mp4", INFO)
    assert "warning" in capsys.readouterr().out


def test_names_missing_insert_clips(tmp_path):
    here = tmp_path / "here.mp4"
    here.touch()
    ins = [{"kind": "clip", "path": str(here)}, {"kind": "clip", "path": "/nope/clip.mov"}, {"kind": "card", "text": "x"}]
    with pytest.raises(SystemExit, match="/nope/clip.mov") as e:
        adopt_recording(dec(inserts=ins), "/here/rec.mp4", INFO)
    assert str(here) not in str(e.value)


def test_custom_intro_must_be_here_unless_not_used():
    d = dec(intro={"file": "/nope/intro.mov"})
    with pytest.raises(SystemExit, match="/nope/intro.mov"):
        adopt_recording(d, "/here/rec.mp4", INFO)
    adopt_recording(d, "/here/rec.mp4", INFO, check_intro=False)  # --no-intro / --intro
