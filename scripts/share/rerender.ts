/**
 * Renders what a teammate shared, from your own copy of the recording (#60).
 *
 *   bun run rerender <bundle> --recording <file> [--reuse-clean] [--cut-only]
 *
 * 1. preflight (stops unless REPRODUCIBLE);
 * 2. rebuilds the clean cut into <bundle>/rebuild/ with sesh-edit --from-decisions
 *    (a reel share: --no-intro; an edit share: the edited video with its intro is the result),
 *    then, when the reel was cut from an upscale, redoes it (sesh-upscale, same method and
 *    height) and checks the size matches; --reuse-clean skips this only when rebuild/rebuild.json
 *    says it was made from the same decisions, recording and clean cut;
 * 3. a reel share: renders the reel into <bundle>/rebuild/<slug>.reel.mp4 (--cut-only stops
 *    before Remotion renders it and prints a props file to preview in Studio).
 *
 * "Exact" means the same inputs and the same code. Different ffmpeg builds can still give
 * different bytes, so the result's sha256 (and a reel's loudness) is written to
 * rebuild/result.json and compared with the sharer's, for information only.
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT } from "../template-media";
import { measureLoudness } from "../reel/make-reel";
import {
  cleanFileName,
  inBundle,
  probeRecording,
  readJob,
  safeRelPath,
  sha256File,
  stampMatches,
  STAMP_FILE,
  type CleanSpec,
  type Job,
  type Output,
  type RebuildStamp,
  type SeshDecisionsLite,
} from "./job";
import { parseBundleArgs, runPreflight } from "./preflight";

/** The shared decisions with the bundle's clips and intro as full paths on this computer (sesh-edit wants those). */
export function localDecisions(bundle: string, decisions: SeshDecisionsLite): SeshDecisionsLite {
  const out: SeshDecisionsLite = JSON.parse(JSON.stringify(decisions));
  const mine = (p?: string): p is string => !!p && p.startsWith("media/") && safeRelPath(p);
  for (const ins of out.inserts ?? []) if (ins.kind === "clip" && mine(ins.path)) ins.path = inBundle(bundle, ins.path);
  if (out.intro && mine(out.intro.file)) out.intro.file = inBundle(bundle, out.intro.file);
  return out;
}

function run(cmd: string[], cwd: string) {
  console.log(`\n$ ${cmd.join(" ")}`);
  const res = spawnSync(cmd[0], cmd.slice(1), { cwd, stdio: "inherit" });
  if (res.status !== 0) throw new Error(`${cmd.slice(0, 3).join(" ")} failed (exit ${res.status})`);
}

async function main() {
  const args = parseBundleArgs(process.argv.slice(2), "bun run rerender <bundle> --recording <file> [--reuse-clean] [--cut-only]");
  for (const f of args.flags) if (f !== "--reuse-clean" && f !== "--cut-only") throw new Error(`unknown option ${f}`);
  if (!args.recording) throw new Error("pass --recording <your copy of the raw recording>");
  const bundle = args.bundle;

  // The reel renders with this checkout's node packages: make them exactly what bun.lock says first.
  if (readJob(bundle).kind === "reel") run(["bun", "install", "--frozen-lockfile"], ROOT);

  const { job, recording, reproducible } = runPreflight(bundle, args.recording);
  if (!reproducible || !recording) throw new Error("\nNot rendering: fix what preflight lists first.");

  const rebuild = join(bundle, "rebuild");
  mkdirSync(rebuild, { recursive: true });

  // Private media the render reads from public/ (preflight made sure ours is absent or the same).
  for (const f of job.files)
    if (f.publicPath && !existsSync(join(ROOT, "public", f.publicPath))) {
      mkdirSync(dirname(join(ROOT, "public", f.publicPath)), { recursive: true });
      copyFileSync(inBundle(bundle, f.path), join(ROOT, "public", f.publicPath));
    }

  const decisionsFile = `${job.episode}.decisions.json`;
  const stamp = rebuildStamp(job);
  const clean = join(rebuild, job.clean ? cleanFileName(job.episode, job.clean) : `${job.episode}.clean.mp4`);
  const edited = join(rebuild, `${job.episode}.edited.mp4`);
  if (args.flags.has("--reuse-clean") && existsSync(job.kind === "reel" ? clean : edited) && stampMatches(rebuild, stamp)) {
    console.log(`\nReusing ${job.kind === "reel" ? clean : edited} (made from these same decisions and recording)`);
  } else {
    if (args.flags.has("--reuse-clean")) console.log("\nNot reusing rebuild/: it wasn't made from this share's decisions, recording and clean cut.");
    rmSync(join(rebuild, STAMP_FILE), { force: true });
    const decisions = JSON.parse(readFileSync(inBundle(bundle, decisionsFile), "utf8"));
    const local = join(rebuild, `${job.episode}.shared-input.json`);
    writeFileSync(local, JSON.stringify(localDecisions(bundle, decisions), null, 1));
    run(
      ["uv", "run", "sesh-edit", recording, "--from-decisions", local, ...(job.kind === "reel" ? ["--no-intro"] : []), "-o", edited],
      join(ROOT, "longform"),
    );
    if (job.clean && job.clean.method !== "none") {
      const own = join(rebuild, `${job.episode}.clean.mp4`);
      run(
        ["uv", "run", "sesh-upscale", own, "-o", clean, "--method", job.clean.method, "--height", String(job.clean.height)],
        join(ROOT, "longform"),
      );
    }
    if (job.clean) {
      const size = probeRecording(clean);
      const problem = cleanSizeProblem(job.clean, size);
      if (problem) throw new Error(problem);
    }
    writeFileSync(join(rebuild, STAMP_FILE), JSON.stringify(stamp, null, 1));
  }

  let output = edited;
  if (job.kind === "reel") {
    output = join(rebuild, `${job.name}.reel.mp4`);
    const cutOnly = args.flags.has("--cut-only") ? ["--cut-only"] : [];
    run(["bun", join("scripts", "reel", "make-reel.ts"), inBundle(bundle, `${job.name}.reel.json`), "--out", output, ...cutOnly], ROOT);
    if (cutOnly.length) return;
  }

  const result: Output = { file: output, bytes: statSync(output).size, sha256: sha256File(output) };
  if (job.kind === "reel") result.loudness = await measureLoudness(output);
  writeFileSync(join(rebuild, "result.json"), JSON.stringify({ ...result, reference: job.reference ?? null }, null, 1));
  console.log(`\nDone: ${output}`);
  console.log(compare(job, result));
}

/** What a rebuild of this share is made from (written next to it, checked by --reuse-clean). */
export function rebuildStamp(job: Job): RebuildStamp {
  const decisions = job.files.find((f) => f.role === "decisions" && f.path === `${job.episode}.decisions.json`);
  return { decisions: decisions?.sha256 ?? "", recording: job.recording.fingerprint, clean: job.clean ?? null, intro: job.kind === "edit" };
}

/** The reel's crops are in the shared clean cut's pixels: a rebuilt one of another size must not be used. */
export function cleanSizeProblem(want: CleanSpec, got: { width: number; height: number }): string | null {
  return want.width === got.width && want.height === got.height
    ? null
    : `the rebuilt clean cut is ${got.width}x${got.height}, but the reel was cut from a ${want.width}x${want.height} one ` +
        `(${want.method === "none" ? "sesh-edit's own" : `a ${want.method} upscale`}): its crops would be wrong. Not rendering.`;
}

export function compare(job: Pick<Job, "reference">, result: Output): string {
  const ref = job.reference;
  if (!ref) return "(the share has no render of its own to compare with)";
  if (ref.sha256 === result.sha256) return "Byte-for-byte the same file as the one that was shared.";
  const loud =
    ref.loudness && result.loudness
      ? ` Loudness ${result.loudness.i.toFixed(1)} LUFS / ${result.loudness.tp.toFixed(1)} dBTP here, ` +
        `${ref.loudness.i.toFixed(1)} / ${ref.loudness.tp.toFixed(1)} on theirs.`
      : "";
  return `Not byte-identical to theirs (expected across computers: ffmpeg builds differ); same inputs and code.${loud}`;
}

if (/rerender\.ts$/.test(process.argv[1] ?? "")) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
