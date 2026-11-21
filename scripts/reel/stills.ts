/**
 * Gridded stills for picking a reel's crops (#55).
 *
 *   bun scripts/reel/stills.ts <name>.reel.json [--at 12.5,80,301] [--n 6] [--out <dir>]
 *   bun scripts/reel/stills.ts <video.mp4>      [--at ...]         [--n 6] [--out <dir>]
 *
 * Writes JPEG stills at full source size with a pixel grid (thin lines every 100 px,
 * thick every 500 px) so a crop can be read straight off them. Given a reel definition
 * it grabs the clean cut at the middle of each span and draws every crop in `shots`
 * (plus the centre crop) on top, so you can see whether a framing holds the speaker.
 * A crop is { "x", "y", "width", "height" } in source pixels and must be 9:16
 * (height = width × 16 / 9).
 *
 * Default output: work/reel-stills/<name>/ (gitignored: stills of an interview are
 * footage).
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { findBin } from "../lib/ff";
import { CENTRE, centreCrop, type Crop } from "../../src/reel/crop";
import type { ReelDef } from "./make-reel";

const COLOURS = ["yellow", "cyan", "magenta", "lime", "orange", "red", "white", "blue"];

/** ffmpeg filter that draws the grid and the named crops. */
export function stillFilter(crops: [string, Crop][]): string {
  const parts = ["drawgrid=w=100:h=100:t=1:c=white@0.3", "drawgrid=w=500:h=500:t=3:c=white@0.6"];
  crops.forEach(([, c], i) => parts.push(`drawbox=x=${c.x}:y=${c.y}:w=${c.width}:h=${c.height}:c=${COLOURS[i % COLOURS.length]}:t=5`));
  return parts.join(",");
}

function probe(ffprobe: string, file: string) {
  const r = spawnSync(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", file], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffprobe failed on ${file}\n${r.stderr}`);
  const j = JSON.parse(r.stdout);
  return { width: j.streams[0].width as number, height: j.streams[0].height as number, duration: Number(j.format.duration) };
}

function main() {
  const argv = process.argv.slice(2);
  const opt = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv.splice(i, 2)[1] : undefined;
  };
  const at = opt("--at");
  const n = Number(opt("--n") ?? 6);
  const outOpt = opt("--out");
  const input = argv[0];
  if (!input) throw new Error("usage: bun scripts/reel/stills.ts <name>.reel.json | <video> [--at s,s,...] [--n 6] [--out dir]");
  const ffmpeg = findBin("ffmpeg");
  const ffprobe = findBin("ffprobe");
  if (!ffmpeg || !ffprobe) throw new Error("ffmpeg / ffprobe not found on PATH");

  let video = resolve(input);
  let name = basename(input).replace(/\.[^.]+$/, "");
  let def: ReelDef | undefined;
  if (input.endsWith(".json")) {
    def = JSON.parse(readFileSync(input, "utf8")) as ReelDef;
    const clean = def.episode?.clean ?? def.source;
    if (!clean) throw new Error(`${input} names no video (episode.clean or source)`);
    video = resolve(dirname(resolve(input)), clean);
    name = def.slug;
  }
  const src = probe(ffprobe, video);
  const crops: [string, Crop][] = [[CENTRE, centreCrop(src)], ...Object.entries(def?.shots ?? {})];

  let times: number[];
  if (at) times = at.split(",").map(Number);
  else if (def?.segments.length) times = def.segments.map((s) => (s.start + s.end) / 2);
  else times = Array.from({ length: n }, (_, i) => ((i + 0.5) * src.duration) / n);

  const outDir = outOpt ?? join("work", "reel-stills", name);
  mkdirSync(outDir, { recursive: true });
  const vf = stillFilter(crops);
  for (const t of times) {
    const file = join(outDir, `${name}-${t.toFixed(1).padStart(7, "0")}s.jpg`);
    const r = spawnSync(ffmpeg, ["-y", "-v", "error", "-ss", t.toFixed(3), "-i", video, "-frames:v", "1", "-vf", vf, "-q:v", "3", file], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`ffmpeg failed at ${t}s\n${r.stderr}`);
    console.log(file);
  }
  console.log(`\n${src.width}x${src.height}. Grid: thin every 100 px, thick every 500 px. Crops drawn:`);
  crops.forEach(([k, c], i) => console.log(`  ${COLOURS[i % COLOURS.length].padEnd(8)} ${k}: x ${c.x}, y ${c.y}, ${c.width}x${c.height}`));
}

if (/stills\.ts$/.test(process.argv[1] ?? "")) main();
