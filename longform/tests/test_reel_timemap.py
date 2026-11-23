"""The reel (scripts/reel/sesh.ts, #55) ports sesh-edit's TimeMap to place words on the clean cut.

Both ports are pinned to scripts/reel/fixtures/timemap.json: this checks plan.py against it, the bun
test checks the TypeScript. If sesh-edit's timeline mapping changes, this fails and the reel port
needs the same change."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from sesh_edit.captions import clean_word
from sesh_edit.plan import TimeMap

FIXTURE = Path(__file__).resolve().parents[2] / "scripts" / "reel" / "fixtures" / "timemap.json"


def test_timemap_places_words_like_the_reel_fixture():
    fx = json.loads(FIXTURE.read_text())
    tm = TimeMap(fx["keep_segments"], fx["inserts"])
    assert tm.total == pytest.approx(fx["total"], abs=1e-6)
    got = []
    for w in fx["caption_words"]:  # the placement in render.caption_lines
        text = clean_word(w["word"])
        i = tm.segment_of(w["start"], tol=0.03)
        if not text or i is None:
            continue
        s = tm.cum[i] + max(0.0, w["start"] - tm.s[i])
        e = tm.cum[i] + min(w["end"], tm.e[i]) - tm.s[i]
        got.append({"w": text, "t": round(float(s), 3), "end": round(float(max(e, s + 0.05)), 3)})
    assert got == fx["expected"]
