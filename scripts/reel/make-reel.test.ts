import { describe, expect, it } from "bun:test";
import { introGainDb, rebaseCaptions, resolveCrops, snap } from "./make-reel";
import { centreCrop, cropProblems } from "../../src/reel/crop";
import { reelTiming, INTRO_OPEN_FRAME } from "../../src/reel/SessionReel";
import example from "../../src/reel/data/example.reel.json";

const src = { width: 1920, height: 1080 };
const w = (t: number, d: number, word: string, br = false) => ({ t, d, w: word, br });

describe("make-reel (#55)", () => {
  it("rebases words onto the clip, span by span", () => {
    const words = [w(9.8, 0.4, "cut"), w(10.1, 0.3, "So"), w(10.5, 0.3, "this"), w(20, 0.2, "gone"), w(30.9, 0.4, "and"), w(31.4, 0.3, "that.")];
    const out = rebaseCaptions(words, [
      { start: 10, end: 11 },
      { start: 31, end: 32 },
    ]);
    expect(out.map((x) => x.w)).toEqual(["cut", "So", "this", "and", "that."]);
    // a word straddling the span start is clipped to it and starts the page
    expect(out[0]).toEqual({ t: 0, d: 0.2, w: "cut", br: true });
    expect(out[1].t).toBeCloseTo(0.1, 6);
    // the second span lands 30 frames in
    expect(out[3]).toEqual({ t: 1, d: 0.3, w: "and", br: true });
    expect(out[4].t).toBeCloseTo(1.4, 6);
  });

  it("applies word fixes by time", () => {
    const out = rebaseCaptions([w(10.1, 0.3, "trends")], [{ start: 10, end: 11 }], [{ t: 10.1, w: "trance" }]);
    expect(out[0].w).toBe("trance");
  });

  it("gives an unnamed span the centre crop and rejects bad shots", () => {
    const crops = resolveCrops({ segments: [{ start: 0, end: 1 }, { start: 1, end: 2, shot: "guest" }], shots: { guest: { x: 1000, y: 0, width: 608, height: 1080 } } }, src);
    expect(crops[0]).toEqual(centreCrop(src));
    expect(crops[0]).toEqual({ x: 656, y: 0, width: 608, height: 1080 });
    expect(crops[1].x).toBe(1000);
    expect(() => resolveCrops({ segments: [{ start: 0, end: 1, shot: "host" }] }, src)).toThrow(/host/);
    expect(() => resolveCrops({ segments: [], shots: { wide: { x: 0, y: 0, width: 1000, height: 1000 } } }, src)).toThrow(/9:16/);
    expect(cropProblems("low", { x: 0, y: 95, width: 534, height: 950 }, src, 1000)).toHaveLength(1);
    expect(cropProblems("off", { x: 1500, y: 0, width: 608, height: 1080 }, src)).toHaveLength(1);
  });

  it("matches the intro to the clip, capped by its true peak", () => {
    expect(introGainDb(-14, { i: -14.6, tp: -3 })).toBeCloseTo(0.6, 6);
    expect(introGainDb(-12, { i: -14.6, tp: -1.2 })).toBeCloseTo(0.2, 6); // the cap wins
  });

  it("opens the clip under the intro's tail and puts the end card after it", () => {
    const t = reelTiming({ intro: "fuse-drums", outro: "card", pictureFrames: 750 });
    expect(t.clipFrom).toBe(INTRO_OPEN_FRAME);
    expect(t.clipFrom / 30).toBeCloseTo(3.933, 3);
    expect(t.total).toBe(118 + 750 + 48);
    expect(reelTiming({ intro: "none", outro: "none", pictureFrames: 750 }).total).toBe(750);
  });

  it("snaps to the 30 fps grid", () => {
    expect(snap(10.02)).toBeCloseTo(10.0333333, 6);
    expect(snap(10.016)).toBe(10);
  });

  it("ships an example definition with made-up text only", () => {
    expect(example.episode.clean).toStartWith("<name>");
    expect(example.segments.length).toBeGreaterThan(0);
  });
});
