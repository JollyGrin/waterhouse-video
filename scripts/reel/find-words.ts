/**
 * Find a quote in a sesh-edit episode and print its clean-cut times (#55), to turn
 * "the bit where he says '...'" into a reel span.
 *
 *   bun scripts/reel/find-words.ts <name>.decisions.json "the quoted words" [--near 12:34] [--context 8]
 *
 * --near is a time in the finished edit (<name>.edited.mp4 or its .srt, intro
 * included), to pick the right one when a phrase comes up more than once. Prints each
 * match in clean-cut seconds (what a reel definition's spans use) and in edit time.
 */

import { findPhrase, introOffsetS, seshCaptionWords, type SeshDecisions } from "./sesh";

export const parseClock = (x: string): number =>
  x.split(":").reduce((acc, part) => acc * 60 + Number(part), 0);

const clock = (s: number) => {
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(2).padStart(5, "0")}`;
};

async function main() {
  const argv = process.argv.slice(2);
  const opt = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv.splice(i, 2)[1] : undefined;
  };
  const near = opt("--near");
  const context = Number(opt("--context") ?? 8);
  const [decPath, ...rest] = argv;
  const phrase = rest.join(" ");
  if (!decPath || !phrase) throw new Error('usage: bun scripts/reel/find-words.ts <name>.decisions.json "words" [--near mm:ss] [--context 8]');
  const dec: SeshDecisions = await Bun.file(decPath).json();
  const words = seshCaptionWords(dec);
  const off = introOffsetS(dec);
  const hits = findPhrase(words, phrase, near === undefined ? undefined : parseClock(near) - off);
  if (!hits.length) {
    console.log(`"${phrase}" not found (matching ignores case and punctuation; try fewer words).`);
    process.exit(1);
  }
  console.log(`edit time = clean time + ${off.toFixed(3)}s (intro)\n`);
  for (const h of hits) {
    const n = phrase.split(/\s+/).filter(Boolean).length;
    const before = words.slice(Math.max(0, h.index - context), h.index).map((w) => w.w).join(" ");
    const after = words.slice(h.index + n, h.index + n + context).map((w) => w.w).join(" ");
    console.log(`clean ${h.start.toFixed(3)}-${h.end.toFixed(3)}   edit ${clock(h.start + off)}-${clock(h.end + off)}`);
    console.log(`  ...${before} [${words.slice(h.index, h.index + n).map((w) => w.w).join(" ")}] ${after}...\n`);
  }
}

if (/find-words\.ts$/.test(process.argv[1] ?? "")) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
