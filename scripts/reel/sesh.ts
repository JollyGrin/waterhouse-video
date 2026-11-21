/**
 * Reading a sesh-edit episode (#55): its decisions.json, mapped onto the clean cut.
 *
 * sesh-edit keeps the word timings (`caption_words`) and the edit (`keep_segments`,
 * `inserts`) in source time. The clean cut (`<name>.clean.mp4`, and its upscales) is
 * those keep segments played in list order with the inserts placed between them, so
 * "clean time" is exactly sesh-edit's output time. This is a port of sesh-edit's
 * TimeMap (longform/src/sesh_edit/plan.py) and of how `caption_lines` (render.py)
 * places words on it. Nothing is re-transcribed.
 *
 * scripts/reel/fixtures/timemap.json pins both ports to the same answers: the bun test
 * checks this file against it, longform/tests/test_reel_timemap.py checks plan.py.
 */

export type CaptionWord = { t: number; d: number; w: string; br: boolean };

export type SeshWord = { word: string; start: number; end: number };
export type SeshInsert = { kind: string; before: number; dur_s: number };
export type SeshDecisions = {
  input: string;
  input_info: { width: number; height: number; fps: number; duration: number };
  keep_segments: [number, number][];
  inserts?: SeshInsert[];
  caption_words: SeshWord[];
  intro?: { open_s: number } | null;
  render?: { intro?: { offset_frames?: number; offset_s?: number } | null } | null;
};

type Item = { kind: string; start: number; end: number; dur: number };

export class TimeMap {
  readonly items: Item[];
  readonly cum: number[];
  readonly total: number;

  constructor(keeps: [number, number][], inserts: SeshInsert[] = []) {
    // same order as plan.py: by `before`, clips ahead of cards at the same slot
    const ins = [...inserts].sort(
      (a, b) => a.before - b.before || (a.kind === "clip" ? 0 : 1) - (b.kind === "clip" ? 0 : 1),
    );
    const items: Item[] = [];
    let j = 0;
    for (let i = 0; i <= keeps.length; i++) {
      while (j < ins.length && ins[j].before <= i) {
        items.push({ kind: ins[j].kind, start: NaN, end: NaN, dur: Number(ins[j].dur_s) });
        j++;
      }
      if (i < keeps.length) {
        const [s, e] = keeps[i];
        items.push({ kind: "main", start: s, end: e, dur: e - s });
      }
    }
    this.items = items;
    this.cum = [0];
    for (const it of items) this.cum.push(this.cum[this.cum.length - 1] + it.dur);
    this.total = this.cum[this.cum.length - 1];
  }

  /** Index of the first keep segment holding source time t (± tol), or null if t is cut. */
  segmentOf(t: number, tol = 0): number | null {
    const i = this.items.findIndex((it) => it.kind === "main" && it.start - tol <= t && t <= it.end + tol);
    return i < 0 ? null : i;
  }

  /** Clean-cut time of source time t, or null if t was cut. */
  toOut(t: number, tol = 0): number | null {
    const i = this.segmentOf(t, tol);
    if (i === null) return null;
    const it = this.items[i];
    return this.cum[i] + Math.min(Math.max(t, it.start), it.end) - it.start;
  }
}

/** sesh-edit's clean_word: drop filler tags like [UH], [UM]. */
export const cleanWord = (w: string) => w.replace(/\[[A-Z]+\]/g, "").trim();

/**
 * A new caption page starts after a pause this long. Matches sesh-edit's
 * `line_gap_hold`: a shorter pause keeps the line up, a longer one is a new thought.
 */
export const PAGE_GAP_S = 0.6;

/**
 * The episode's words on the clean-cut timeline, as the reel's {t, d, w, br}.
 *
 * Placement is caption_lines' (render.py): a word belongs to the keep segment its
 * start falls in (30 ms tolerance), its start is clamped to the segment start, its end
 * clipped to the segment end, and it lasts at least 50 ms. Cut words and bare filler
 * tags are dropped. `br` marks a word that starts a new caption page: after a
 * sentence end, or after a pause of PAGE_GAP_S or more.
 */
export function seshCaptionWords(dec: Pick<SeshDecisions, "keep_segments" | "inserts" | "caption_words">): CaptionWord[] {
  const tm = new TimeMap(dec.keep_segments, dec.inserts ?? []);
  const placed: { t: number; end: number; w: string }[] = [];
  for (const word of dec.caption_words) {
    const w = cleanWord(word.word);
    if (!w) continue;
    const i = tm.segmentOf(word.start, 0.03);
    if (i === null) continue;
    const it = tm.items[i];
    const s = tm.cum[i] + Math.max(0, word.start - it.start);
    const e = tm.cum[i] + Math.min(word.end, it.end) - it.start;
    placed.push({ t: s, end: Math.max(e, s + 0.05), w });
  }
  placed.sort((a, b) => a.t - b.t);
  return placed.map((p, k) => {
    const prev = placed[k - 1];
    const br = !prev || /[.?!]$/.test(prev.w) || p.t - prev.end >= PAGE_GAP_S;
    return { t: round3(p.t), d: round3(p.end - p.t), w: p.w, br };
  });
}

/**
 * Where the interview starts in the finished edit (<name>.edited.mp4 and its .srt):
 * the intro runs alone for this long, so edit time = clean time + this. Taken from
 * what the render recorded (frames at the input rate, e.g. 118 at 30 fps, 98 at 25),
 * else from the intro spec. `intro: null` means it was edited with --no-intro (0).
 * Decisions from before the intro existed have no `intro` at all, and sesh-edit and
 * sesh-overlay give those the default Fuse-Drums intro, so that is assumed here too.
 */
export const DEFAULT_INTRO_OPEN_S = 118 / 30;
export function introOffsetS(dec: Pick<SeshDecisions, "intro" | "render" | "input_info">): number {
  const r = dec.render?.intro;
  if (r?.offset_s !== undefined) return r.offset_s;
  if (dec.intro === null) return 0;
  const open = dec.intro?.open_s ?? DEFAULT_INTRO_OPEN_S;
  return Math.round(open * dec.input_info.fps) / dec.input_info.fps;
}

const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");

export type PhraseHit = { start: number; end: number; index: number; score: number };

/**
 * Find a quoted phrase in the clean-cut words, for turning "the bit where he says
 * '...'" into clean-cut seconds. Matching is on normalised words (case and punctuation
 * ignored). Every exact occurrence is returned; with `near` (clean seconds) the
 * closest comes first.
 */
export function findPhrase(words: CaptionWord[], phrase: string, near?: number): PhraseHit[] {
  const want = phrase.split(/\s+/).map(norm).filter(Boolean);
  const have = words.map((w) => norm(w.w));
  const hits: PhraseHit[] = [];
  if (!want.length) return hits;
  for (let i = 0; i + want.length <= have.length; i++) {
    if (want.every((w, k) => have[i + k] === w)) {
      const last = words[i + want.length - 1];
      hits.push({ start: words[i].t, end: round3(last.t + last.d), index: i, score: 0 });
    }
  }
  if (near !== undefined) {
    for (const h of hits) h.score = Math.abs(h.start - near);
    hits.sort((a, b) => a.score - b.score);
  }
  return hits;
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;
