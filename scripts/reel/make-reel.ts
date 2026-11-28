/**
 * Cuts a vertical (9:16) Instagram reel out of a finished interview.
 *
 *   bun run reel <name>.reel.json [--cut-only] [--reuse-cut] [--out <file.mp4>]
 *
 * A reel is: the Fuse-Drums intro (9:16), the clip opening under its tail, cropped to
 * 9:16 with big karaoke captions, then the end card. Three stages, because they answer
 * different questions:
 *   1. ffmpeg lifts the chosen spans out of the 16:9 episode and joins them. Still the
 *      full wide two-shot: this stage only decides *what is said*.
 *   2. Remotion (SessionReel) crops to 9:16, cuts between the speakers, lays the
 *      captions on, puts the intro in front and the end card behind. That stage decides
 *      *what is seen*, and it stays adjustable without re-cutting (--reuse-cut).
 *   3. ffmpeg masters the sound to -14 LUFS / -1 dBTP and writes h264 + aac with
 *      +faststart.
 *
 * Two kinds of reel definition (#55):
 *
 * - **A sesh-edit episode** (`episode`): `episode.clean` is the clean cut (no captions
 *   burned in: `<name>.clean.mp4`, or an upscale like `<name>.clean.x4plus1080p.mp4`) and
 *   `episode.decisions` its `<name>.decisions.json`. Spans are in clean-cut seconds. The
 *   words come from the decisions file, mapped onto the clean cut exactly as sesh-edit
 *   places its own captions (scripts/reel/sesh.ts): nothing is re-transcribed.
 *   These definitions quote the interview, so they live next to the episode's outputs,
 *   never in git. src/reel/data/example.reel.json shows the shape.
 * - **The retired TypeScript episode cut** (`source` + `captions`): the two checked-in
 *   reels (fro-ministry, boogie-exit). Still builds, given that machine's work/ files.
 *
 * Crops: `shots` names crop windows in source pixels (9:16; `bun scripts/reel/stills.ts`
 * grabs gridded stills to measure them on). A span with no `shot` uses the centre crop.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { findBin } from "../lib/ff";
import { CENTRE, centreCrop, cropProblems, type Crop, type SourceSize } from "../../src/reel/crop";
import { FPS } from "../../src/reel/theme";
import { reelBanner, reelTiming, type ReelBanner, type ReelIntro, type ReelOutro, type SessionReelProps } from "../../src/reel/SessionReel";
import { FUSE_DRUMS_AUDIO } from "../../src/ident/Fuse";
// (the YouTube bumper's sound is placed by SessionReel; only its gain is worked out here)
import { seshCaptionWords, TimeMap, type CaptionWord, type SeshDecisions } from "./sesh";

export type Segment = { start: number; end: number; shot?: string; note?: string };
/**
 * A correction to one transcribed word, keyed on its time in the source the spans are
 * measured in (the clean cut for a sesh-edit episode). `w` replaces the text; `at`/`d`
 * replace the timing; `drop` takes the word out of the captions (a stutter like "po
 * police"), while the sound stays as it is.
 */
export type WordFix = {
  t: number;
  /** Also require this text, when several words share one time. */
  match?: string;
  w?: string;
  at?: number;
  d?: number;
  drop?: boolean;
};
export type ReelDef = {
  slug: string;
  title: string;
  /** A sesh-edit episode. */
  episode?: { clean: string; decisions: string };
  /** Retired TypeScript cut: the master, and its {t,d,w,br} words. */
  source?: string;
  captions?: string;
  /** Retired cut only: where the sound comes from, when that is not `source`. */
  audioSource?: string;
  artist: string;
  episodeLabel: string;
  cta: string;
  /** Default "fuse-drums". */
  intro?: ReelIntro;
  /** Default "youtube" (the YouTube end bumper); "card" is the old end card. */
  outro?: ReelOutro;
  /** "youtube" (default): a "full interview on YouTube" banner over the whole clip. "none" turns it off. */
  banner?: ReelBanner;
  /** Named crop windows into the source, in source pixels. "centre" is always there. */
  shots?: Record<string, Crop>;
  /** Lowest source row a crop may reach (a burned-in ticker below, say). */
  floorY?: number;
  segments: Segment[];
  wordFixes?: WordFix[];
  /** Where the finished reel goes. Default: <slug>.reel.mp4 next to a sesh-edit definition. */
  output?: string;
};

/** Loudness the finished reel is mastered to (Instagram's own normalisation target). */
export const TARGET_LUFS = -14;
export const TARGET_TP = -1;

/** Snap a time onto the reel's frame grid (see stage 1). */
export const snap = (t: number) => Math.round(t * FPS) / FPS;

/** The crop for every span, by shot name; unknown names are an error. */
export function resolveCrops(def: Pick<ReelDef, "shots" | "floorY" | "segments">, src: SourceSize): Crop[] {
  const shots: Record<string, Crop> = { [CENTRE]: centreCrop(src), ...def.shots };
  const problems = Object.entries(def.shots ?? {}).flatMap(([name, c]) => cropProblems(name, c, src, def.floorY));
  if (problems.length) throw new Error(problems.join("\n"));
  return def.segments.map((s, i) => {
    const name = s.shot ?? CENTRE;
    const crop = shots[name];
    if (!crop) throw new Error(`span ${i + 1} uses shot "${name}", which isn't in "shots" (${Object.keys(shots).join(", ")})`);
    return crop;
  });
}

/**
 * Rebase source-timed words onto the clip's timeline: each span's words shifted to
 * where the span lands, words straddling a cut clipped to the span, the first word of
 * every span starting a new caption page (a new span is often a new speaker, and a
 * page must not carry one speaker's words over the cut to the other).
 */
export function rebaseCaptions(words: CaptionWord[], segments: Segment[], wordFixes: WordFix[] = []): CaptionWord[] {
  const out: CaptionWord[] = [];
  let from = 0;
  for (const segment of segments) {
    const shift = from / FPS - segment.start;
    let first = true;
    for (const raw of words) {
      const fix = wordFixes.find((f) => Math.abs(f.t - raw.t) < 0.005 && (!f.match || f.match === raw.w));
      if (fix?.drop) continue;
      const word = fix ? { ...raw, t: fix.at ?? raw.t, d: fix.d ?? raw.d, w: fix.w ?? raw.w } : raw;
      if (word.t + word.d <= segment.start || word.t >= segment.end) continue;
      // Clipped rather than dropped: losing it leaves a visible hole in the line.
      const start = Math.max(word.t, segment.start);
      const end = Math.min(word.t + word.d, segment.end);
      out.push({
        t: +(start + shift).toFixed(3),
        d: +(end - start).toFixed(3),
        w: word.w,
        br: word.br || first,
      });
      first = false;
    }
    from += Math.round((segment.end - segment.start) * FPS);
  }
  return out;
}

/** The intro's gain to sit at the clip's loudness, capped so its own true peak stays under the ceiling (sesh-edit's intro.mix_audio). */
export function introGainDb(clipLufs: number, intro: { i: number; tp: number }): number {
  return +Math.min(clipLufs - intro.i, TARGET_TP - intro.tp).toFixed(2);
}

/**
 * The YouTube bumper's gain. Its tail was made to a fixed level (hit at −1.5 dBTP),
 * and it is mostly decay, so matching its integrated loudness to the speech (the
 * intro's rule) would be wrong. Instead it is pre-gained by the opposite of what the
 * master will do to the clip (TARGET_LUFS − clip), so it comes out at its designed
 * level in the finished reel and the limiter leaves it alone.
 */
export function outroGainDb(clipLufs: number): number {
  return +(clipLufs - TARGET_LUFS).toFixed(2);
}

const run = (cmd: string, args: string[]) =>
  new Promise<string>((resolvePromise, reject) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    proc.stdout.on("data", (c) => (out += c));
    proc.stderr.on("data", (c) => (err += c));
    proc.on("close", (code) =>
      code === 0
        ? resolvePromise(out + err)
        : reject(new Error(`${cmd} exited ${code}\n${err.slice(-4000)}`)),
    );
  });

const tool = (name: "ffmpeg" | "ffprobe") => {
  const bin = findBin(name);
  if (!bin) throw new Error(`${name} not found on PATH`);
  return bin;
};

/** EBU R128 integrated loudness and true peak of a file's audio. */
export async function measureLoudness(file: string, af = ""): Promise<{ i: number; tp: number }> {
  const log = await run(tool("ffmpeg"), [
    "-hide_banner", "-nostats", "-i", file, "-vn",
    "-af", `${af ? af + "," : ""}loudnorm=I=${TARGET_LUFS}:TP=${TARGET_TP}:print_format=json`,
    "-f", "null", "-",
  ]);
  const json = JSON.parse(log.slice(log.lastIndexOf("{"), log.lastIndexOf("}") + 1));
  return { i: Number(json.input_i), tp: Number(json.input_tp) };
}

async function probeSize(file: string): Promise<SourceSize & { duration: number }> {
  const out = await run(tool("ffprobe"), [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height:format=duration", "-of", "json", file,
  ]);
  const j = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
  return { width: j.streams[0].width, height: j.streams[0].height, duration: Number(j.format.duration) };
}

const parseArgs = (argv: string[]) => {
  const flags = new Set(["--cut-only", "--reuse-cut"]);
  const out: { def?: string; cutOnly: boolean; reuseCut: boolean; out?: string } = { cutOnly: false, reuseCut: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") out.out = argv[++i];
    else if (flags.has(a)) {
      if (a === "--cut-only") out.cutOnly = true;
      else out.reuseCut = true;
    } else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else out.def = a;
  }
  if (!out.def) throw new Error("usage: bun run reel <name>.reel.json [--cut-only] [--reuse-cut] [--out <file.mp4>]");
  return out;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const defPath = resolve(args.def!);
  const def: ReelDef = await Bun.file(defPath).json();
  const intro: ReelIntro = def.intro ?? "fuse-drums";
  const outro: ReelOutro = def.outro ?? "youtube";

  /* ---------- the source, and its words in source time ---------- */

  let source: string;
  let audioSource: string;
  let words: CaptionWord[];
  if (def.episode) {
    source = resolve(dirname(defPath), def.episode.clean);
    audioSource = source;
    const decisions: SeshDecisions = await Bun.file(resolve(dirname(defPath), def.episode.decisions)).json();
    words = seshCaptionWords(decisions);
    const expected = new TimeMap(decisions.keep_segments, decisions.inserts ?? []).total;
    const { duration } = await probeSize(source);
    if (Math.abs(duration - expected) > 0.5) {
      throw new Error(
        `${basename(source)} is ${duration.toFixed(2)}s but its decisions describe a ${expected.toFixed(2)}s clean cut: ` +
          `not the clean cut of this episode (or the edit changed since).`,
      );
    }
  } else if (def.source && def.captions) {
    source = def.source;
    audioSource = def.audioSource ?? def.source;
    words = await Bun.file(def.captions).json();
  } else {
    throw new Error(`${defPath}: needs "episode": {"clean", "decisions"} (sesh-edit) or "source" + "captions"`);
  }
  const src = await probeSize(source);

  /**
   * Snap every span to the reel's frame grid before anything else touches it. An
   * arbitrary float duration gives ffmpeg a fractional number of frames to emit, and
   * its rounding then disagrees with the frame count the reel timeline predicts, until
   * the crop cuts and the captions no longer sit where the picture cuts.
   */
  def.segments = def.segments.map((s) => ({ ...s, start: snap(s.start), end: snap(s.end) }));
  const crops = resolveCrops(def, src);
  const seconds = def.segments.reduce((n, s) => n + s.end - s.start, 0);
  if (seconds < 15 || seconds > 45) console.log(`Note: the clip is ${seconds.toFixed(1)}s (a reel is usually 20-30s).`);

  const workDir = join("work", `reel-${def.slug}`);
  mkdirSync(workDir, { recursive: true });
  mkdirSync(join("public", "reel"), { recursive: true });
  const cutName = `${def.slug}-cut.mp4`;
  const cutPath = join("public", "reel", cutName);

  /* ---------- stage 1: lift the spans out of the episode and join them ---------- */

  /**
   * A 30ms ramp on each end of every span. The joins land mid-room-tone, and an
   * instantaneous level change there is an audible tick on a phone speaker.
   */
  const AUDIO_RAMP = 0.03;
  const SAMPLE_RATE = 48000;
  const sameFile = audioSource === source;
  const inputs: string[] = [];
  const filters: string[] = [];
  const concatIn: string[] = [];

  def.segments.forEach((segment, i) => {
    const duration = segment.end - segment.start;
    const frames = Math.round(duration * FPS);
    const samples = Math.round(duration * SAMPLE_RATE);
    // Ask for a little more than needed and trim to an exact count: asking for the exact
    // duration leaves ffmpeg to round a sub-frame seek however it likes.
    const seek = ["-ss", segment.start.toFixed(3), "-t", (duration + 0.1).toFixed(3), "-i"];
    const vi = sameFile ? i : i * 2;
    const ai = sameFile ? i : i * 2 + 1;
    inputs.push(...seek, source);
    if (!sameFile) inputs.push(...seek, audioSource);
    // Conformed to the reel's 30 fps here (sources are 25, 30 or 60).
    filters.push(`[${vi}:v]fps=${FPS},trim=end_frame=${frames},setpts=PTS-STARTPTS,format=yuv420p[v${i}]`);
    filters.push(
      `[${ai}:a]aresample=${SAMPLE_RATE},atrim=end_sample=${samples},asetpts=PTS-STARTPTS,` +
        `aformat=sample_fmts=fltp:channel_layouts=stereo,` +
        `afade=t=in:st=0:d=${AUDIO_RAMP},afade=t=out:st=${(duration - AUDIO_RAMP).toFixed(3)}:d=${AUDIO_RAMP}[a${i}]`,
    );
    concatIn.push(`[v${i}][a${i}]`);
  });
  filters.push(`${concatIn.join("")}concat=n=${def.segments.length}:v=1:a=1[v][a]`);

  if (args.reuseCut && existsSync(cutPath)) {
    console.log(`Reusing ${cutPath}`);
  } else {
    console.log(`Cutting ${def.segments.length} spans (${seconds.toFixed(2)}s) out of ${basename(source)}...`);
    await run(tool("ffmpeg"), [
      "-y", "-v", "error",
      ...inputs,
      "-filter_complex", filters.join(";"),
      "-map", "[v]", "-map", "[a]",
      // A high-quality intermediate: Remotion scales this up ~2x, so anything lost here
      // is lost twice over.
      "-c:v", "libx264", "-crf", "16", "-preset", "medium", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "320k",
      "-movflags", "+faststart",
      cutPath,
    ]);
  }

  /* ---------- the reel timeline ---------- */

  let offset = 0;
  const segments = def.segments.map((segment, i) => {
    const durationInFrames = Math.round((segment.end - segment.start) * FPS);
    const entry = { fromFrame: offset, durationInFrames, crop: crops[i] };
    offset += durationInFrames;
    return entry;
  });
  const pictureFrames = offset;
  const captions = rebaseCaptions(words, def.segments, def.wordFixes);

  // Match the intro to the clip, as sesh-edit does on the 16:9 edit.
  let gain = 0;
  const clip = await measureLoudness(cutPath);
  const outroGain = outro === "youtube" ? outroGainDb(clip.i) : 0;
  if (outro === "youtube") console.log(`Outro: gain ${outroGain >= 0 ? "+" : ""}${outroGain.toFixed(2)} dB (lands at its own level after mastering)`);
  if (intro === "fuse-drums") {
    const introLoud = await measureLoudness(join("public", FUSE_DRUMS_AUDIO));
    gain = introGainDb(clip.i, introLoud);
    console.log(
      `Intro: clip ${clip.i.toFixed(1)} LUFS, Fuse-Drums ${introLoud.i.toFixed(1)} LUFS ` +
        `(${introLoud.tp.toFixed(1)} dBTP) -> gain ${gain >= 0 ? "+" : ""}${gain.toFixed(2)} dB`,
    );
  }

  const props: SessionReelProps = {
    cutFile: `reel/${cutName}`,
    source: { width: src.width, height: src.height },
    segments,
    captions,
    pictureFrames,
    intro,
    introGainDb: gain,
    outro,
    outroGainDb: outroGain,
    banner: reelBanner(def.banner),
    artist: def.artist,
    episodeLabel: def.episodeLabel,
    cta: def.cta,
  };
  const propsPath = join(workDir, "props.json");
  writeFileSync(propsPath, JSON.stringify(props, null, 1));
  const timing = reelTiming(props);
  console.log(
    `Reel: ${(timing.total / FPS).toFixed(2)}s = intro ${(timing.clipFrom / FPS).toFixed(2)}s + clip ` +
      `${(pictureFrames / FPS).toFixed(2)}s + end ${((timing.total - timing.outroFrom) / FPS).toFixed(2)}s, ` +
      `${captions.length} words. Props: ${propsPath}`,
  );
  if (args.cutOnly) {
    console.log(`--cut-only: stopping before the render. Preview: bun run dev -- --props=${propsPath}`);
    return;
  }

  /* ---------- stage 2: render ---------- */

  const output = resolve(
    args.out ?? (def.output ? resolve(dirname(defPath), def.output)
      : def.episode ? join(dirname(defPath), `${def.slug}.reel.mp4`)
      : join("out", "reels", `WH REEL - ${def.title}.mp4`)),
  );
  mkdirSync(dirname(output), { recursive: true });
  const rendered = join(workDir, "rendered.mp4");
  console.log(`Rendering ${rendered}...`);
  const remotion = Bun.spawn(
    [
      "bun", join("node_modules", ".bin", "remotionb"), "render", join("src", "index.ts"), "SessionReel", rendered,
      `--props=${propsPath}`, "--codec=h264", "--crf=17", "--audio-bitrate=320k", "--concurrency=4",
    ],
    { stdin: "ignore", stdout: "inherit", stderr: "inherit" },
  );
  if ((await remotion.exited) !== 0) throw new Error("remotion render failed");

  /* ---------- stage 3: master the sound, write the deliverable ---------- */

  /**
   * Remotion's mux does not compensate the AAC encoder's priming, so its file's sound
   * sits 2048 samples (42.7ms) behind its picture (measured on the old reels). Trimmed
   * off here, before the sound is mastered.
   */
  const AAC_PRIMING_SECONDS = 2048 / SAMPLE_RATE;
  const raw = join(workDir, "audio.wav");
  await run(tool("ffmpeg"), [
    "-y", "-v", "error", "-i", rendered, "-vn",
    "-af", `atrim=start=${AAC_PRIMING_SECONDS.toFixed(6)},asetpts=PTS-STARTPTS`,
    "-ar", String(SAMPLE_RATE), "-c:a", "pcm_f32le", raw,
  ]);

  /**
   * One gain for the whole reel to TARGET_LUFS, then a true-peak limiter (run at
   * 192 kHz so inter-sample peaks are caught), as sesh-edit's loudnorm_2pass. The
   * limiter takes a little loudness, so the gain is corrected and re-applied; the
   * ceiling sits under TARGET_TP to leave room for the AAC encode, and drops further
   * if the encoded file still peaks over it.
   */
  const mastered = join(workDir, "audio-master.wav");
  const first = await measureLoudness(raw);
  let gainDb = TARGET_LUFS - first.i;
  let ceiling = TARGET_TP - 0.5;
  let final = { i: NaN, tp: NaN };
  for (let pass = 0; pass < 4; pass++) {
    for (let k = 0; k < 3; k++) {
      const lim = `aresample=192000,alimiter=limit=${(10 ** ((ceiling - 0.3) / 20)).toFixed(4)}:attack=2:release=60:level=false,aresample=${SAMPLE_RATE}`;
      await run(tool("ffmpeg"), ["-y", "-v", "error", "-i", raw, "-af", `volume=${gainDb.toFixed(2)}dB,${lim}`, "-c:a", "pcm_f32le", mastered]);
      const m = await measureLoudness(mastered);
      if (Math.abs(TARGET_LUFS - m.i) < 0.2) break;
      gainDb += TARGET_LUFS - m.i;
    }
    await run(tool("ffmpeg"), [
      "-y", "-v", "error", "-i", rendered, "-i", mastered,
      "-map", "0:v:0", "-map", "1:a:0",
      "-c:v", "copy", "-c:a", "aac", "-b:a", "256k", "-ar", String(SAMPLE_RATE),
      "-af", "apad", "-shortest",
      "-movflags", "+faststart", output,
    ]);
    final = await measureLoudness(output);
    if (final.tp <= TARGET_TP && Math.abs(final.i - TARGET_LUFS) <= 0.5) break;
    if (final.tp > TARGET_TP) ceiling -= final.tp - TARGET_TP + 0.1;
    gainDb += TARGET_LUFS - final.i;
  }
  console.log(
    `Sound: ${first.i.toFixed(1)} LUFS -> ${final.i.toFixed(1)} LUFS, true peak ${final.tp.toFixed(1)} dBTP ` +
      `(target ${TARGET_LUFS} LUFS, <= ${TARGET_TP} dBTP)`,
  );
  if (final.tp > TARGET_TP || Math.abs(final.i - TARGET_LUFS) > 0.5) {
    throw new Error(`${output} missed the loudness target: ${final.i.toFixed(2)} LUFS, ${final.tp.toFixed(2)} dBTP`);
  }
  console.log(`Done: ${output}`);
}

if (/make-reel\.ts$/.test(process.argv[1] ?? "")) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
