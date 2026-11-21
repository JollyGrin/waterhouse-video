import { describe, expect, it } from "bun:test";
import fixture from "./fixtures/timemap.json";
import { TimeMap, findPhrase, introOffsetS, seshCaptionWords, type SeshDecisions } from "./sesh";

const dec = fixture as unknown as SeshDecisions;

describe("sesh-edit words on the clean cut (#55)", () => {
  it("places words exactly where sesh-edit does (shared fixture)", () => {
    const tm = new TimeMap(dec.keep_segments, dec.inserts);
    expect(tm.total).toBeCloseTo(fixture.total, 6);
    const got = seshCaptionWords(dec).map((w) => ({ w: w.w, t: w.t, end: Math.round((w.t + w.d) * 1000) / 1000 }));
    expect(got).toEqual(fixture.expected);
  });

  it("drops cut words and filler tags, keeps moved-to-front segments first", () => {
    const words = seshCaptionWords(dec).map((w) => w.w);
    expect(words).not.toContain("gone");
    expect(words).not.toContain("[UH]");
    expect(words.slice(0, 3)).toEqual(["Made", "up", "words."]);
  });

  it("starts a page after a sentence end or a long pause", () => {
    const br = Object.fromEntries(seshCaptionWords(dec).map((w) => [w.w, w.br]));
    expect(br.Made).toBe(true); // first word
    expect(br.up).toBe(false);
    expect(br.So).toBe(true); // after "words."
    expect(br.this).toBe(false); // 0.5 s pause
    expect(br.is).toBe(true); // 1.1 s pause
    expect(br.test).toBe(true);
  });

  it("maps source times through the edit, inserts included", () => {
    const tm = new TimeMap(dec.keep_segments, dec.inserts);
    expect(tm.toOut(51)).toBeCloseTo(1, 6);
    expect(tm.toOut(1.5)).toBeCloseTo(2.5 + 2 + 3.5 + 0.5, 6); // after the clip and the card
    expect(tm.toOut(3.5)).toBeNull();
  });

  it("finds a quoted phrase, ignoring case and punctuation", () => {
    const words = seshCaptionWords(dec);
    const [hit] = findPhrase(words, "made up WORDS");
    expect(hit.start).toBe(0.2);
    expect(hit.end).toBe(2.5);
    expect(findPhrase(words, "not there")).toEqual([]);
  });

  it("reads the intro offset the render recorded, else from the spec, else the default", () => {
    const info = { width: 1920, height: 1080, fps: 25, duration: 1 };
    expect(introOffsetS({ input_info: info, render: { intro: { offset_s: 3.92 } } })).toBe(3.92);
    expect(introOffsetS({ input_info: info, intro: { open_s: 3.933333 } })).toBeCloseTo(3.92, 6);
    expect(introOffsetS({ input_info: info, intro: null })).toBe(0);
    expect(introOffsetS({ input_info: { ...info, fps: 30 } })).toBeCloseTo(118 / 30, 6); // pre-intro decisions
  });
});
