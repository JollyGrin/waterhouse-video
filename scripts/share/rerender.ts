/**
 * Renders what a teammate shared, from your own copy of the recording (#60).
 *
 *   bun run rerender <bundle> --recording <file> [--reuse-clean]
 *
 * 1. preflight (stops unless REPRODUCIBLE);
 * 2. rebuilds the clean cut into <bundle>/rebuild/ with sesh-edit --from-decisions
 *    (a reel share: --no-intro; an edit share: the edited video with its intro is the result);
 * 3. a reel share: renders the reel into <bundle>/rebuild/<slug>.reel.mp4.
 *
 * "Exact" means the same inputs and the same code. Different ffmpeg builds can still give
 * different bytes, so the result's sha256 (and a reel's loudness) is written to
 * rebuild/result.json and compared with the sharer's, for information only.
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT } from "../template-media";
import { measureLoudness } from "../reel/make-reel";
import { inBundle, sha256File, type Job, type Output, type SeshDecisionsLite } from "./job";
import { parseBundleArgs, runPreflight } from "./preflight";

/** The shared decisions with the bundle's clips and intro as full paths on this computer (sesh-edit wants those). */
export function localDecisions(bundle: string, decisions: SeshDecisionsLite): SeshDecisionsLite {
  const out: SeshDecisionsLite = JSON.parse(JSON.stringify(decisions));
  for (const ins of out.inserts ?? []) if (ins.kind === "clip" && ins.path?.startsWith("media/")) ins.path = inBundle(bundle, ins.path);
  if (out.intro?.file?.startsWith("media/")) out.intro.file = inBundle(bundle, out.intro.file);
  return out;
}

function run(cmd: string[], cwd: string) {
  console.log(`\n$ ${cmd.join(" ")}`);
  const res = spawnSync(cmd[0], cmd.slice(1), { cwd, stdio: "inherit" });
  if (res.status !== 0) throw new Error(`${cmd.slice(0, 3).join(" ")} failed (exit ${res.status})`);
}

async function main() {
  const args = parseBundleArgs(process.argv.slice(2), "bun run rerender <bundle> --recording <file> [--reuse-clean]");
  for (const f of args.flags) if (f !== "--reuse-clean") throw new Error(`unknown option ${f}`);
  if (!args.recording) throw new Error("pass --recording <your copy of the raw recording>");
  const { job, recording, reproducible } = runPreflight(args.bundle, args.recording);
  if (!reproducible || !recording) throw new Error("\nNot rendering: fix what preflight lists first.");

  const bundle = args.bundle;
  const rebuild = join(bundle, "rebuild");
  mkdirSync(rebuild, { recursive: true });

  // Private media the render reads from public/ (preflight made sure ours is absent or the same).
  for (const f of job.files)
    if (f.publicPath && !existsSync(join(ROOT, "public", f.publicPath))) {
      mkdirSync(dirname(join(ROOT, "public", f.publicPath)), { recursive: true });
      copyFileSync(inBundle(bundle, f.path), join(ROOT, "public", f.publicPath));
    }

  const clean = join(rebuild, `${job.episode}.clean.mp4`);
  const edited = join(rebuild, `${job.episode}.edited.mp4`);
  if (args.flags.has("--reuse-clean") && existsSync(clean) && (job.kind === "reel" || existsSync(edited))) {
    console.log(`\nReusing ${clean}`);
  } else {
    const decisions = JSON.parse(readFileSync(inBundle(bundle, `${job.episode}.decisions.json`), "utf8"));
    const local = join(rebuild, `${job.episode}.shared-input.json`);
    writeFileSync(local, JSON.stringify(localDecisions(bundle, decisions), null, 1));
    run(
      ["uv", "run", "sesh-edit", recording, "--from-decisions", local, ...(job.kind === "reel" ? ["--no-intro"] : []), "-o", edited],
      join(ROOT, "longform"),
    );
  }

  let output = edited;
  if (job.kind === "reel") {
    output = join(rebuild, `${job.name}.reel.mp4`);
    run(["bun", join("scripts", "reel", "make-reel.ts"), inBundle(bundle, `${job.name}.reel.json`), "--out", output], ROOT);
  }

  const result: Output = { file: output, bytes: statSync(output).size, sha256: sha256File(output) };
  if (job.kind === "reel") result.loudness = await measureLoudness(output);
  writeFileSync(join(rebuild, "result.json"), JSON.stringify({ ...result, reference: job.reference ?? null }, null, 1));
  console.log(`\nDone: ${output}`);
  console.log(compare(job, result));
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
