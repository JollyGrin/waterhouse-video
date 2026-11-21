"""mix_audio reuses a recorded intro gain only while the intro still measures what it did at the
edit; a rebuilt intro (Fuse -> Fuse-Drums, same file name) gets its level matched again."""
import numpy as np
import pytest

from sesh_edit import intro

SR, FPS = 48000, 30.0
SPEC = {"file": "fuse-16x9.webm", "open_s": 0.1, "dur_s": 0.2}


@pytest.fixture
def fake(monkeypatch):
    """A 0.2 s intro that 'measures' at `now` LUFS, -3 dBTP; the body measures -14 LUFS."""
    state = {"now": -14.7}
    ia = np.full((int(0.2 * SR), 2), 0.01, np.float32)
    monkeypatch.setattr(intro, "load_audio", lambda spec, sr, ch: ia.copy())

    def loud(a, sr):
        return {"i": state["now"], "tp": -3.0} if a is not None and len(a) == len(ia) else {"i": -14.0, "tp": -6.0}

    monkeypatch.setattr(intro, "loudness", loud)
    return state


def body():
    return np.zeros((SR, 2), np.float32)


def test_recorded_gain_kept_when_intro_unchanged(fake):
    fake["now"] = -9.9
    _, info = intro.mix_audio(body(), SR, SPEC, FPS, speech_lufs=-14.0, gain_db=-4.1, recorded_lufs=-9.75)
    assert info["gain_db"] == -4.1
    assert "rematched" not in info


def test_recorded_gain_dropped_when_intro_changed(fake):
    fake["now"] = -14.7  # Fuse-Drums, where the edit recorded old Fuse at -9.9
    _, info = intro.mix_audio(body(), SR, SPEC, FPS, speech_lufs=-14.0, gain_db=-4.1, recorded_lufs=-9.9)
    assert info["rematched"] is True
    assert info["stale_gain_db"] == -4.1
    assert info["gain_db"] == pytest.approx(0.7)  # -14.0 - (-14.7), under the TP cap (-1 - -3 = +2)
    assert info["intro_lufs_applied"] == pytest.approx(-14.0)


def test_no_recorded_lufs_keeps_old_behaviour(fake):
    fake["now"] = -14.7
    _, info = intro.mix_audio(body(), SR, SPEC, FPS, gain_db=-4.1)
    assert info["gain_db"] == -4.1
    assert "rematched" not in info
