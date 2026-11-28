/**
 * Renders what a teammate shared, from your own copy of the recording (#60, #62).
 *
 *   bun run rerender <bundle> --recording <file> [--only edit|<reel slug>] [--reuse-clean] [--cut-only]
 *
 * 1. preflight (stops unless REPRODUCIBLE); with a reel to render, `bun install
 *    --frozen-lockfile` first, so the node packages are the ones bun.lock pins;
 * 2. the clean cut, once: sesh-edit --from-decisions into <bundle>/rebuild/, which also
 *    writes the full edit with its intro (rebuild/<name>.edited.mp4);
 * 3. each upscale a reel was cut from (sesh-upscale, same method and height), once, and a
 *    check that its size is the pinned one;
 * 4. every reel into rebuild/<slug>.reel.mp4 (--cut-only stops each before Remotion
 *    renders it and prints a props file to preview in Studio).
 *
 * By default it does the edit and every reel; --only edit, --only <slug> (repeatable, or
 * comma-separated) limits it. --reuse-clean skips steps 2 and 3 when rebuild/rebuild.json
 * says they were made from the same decisions and recording. A version 1 bundle (#61: one
 * reel, or one edit) renders as it did then.
 *
 * "Exact" means the same inputs and the same code. Different ffmpeg builds can still give
 * different bytes, so each result's sha256 (and a reel's loudness) goes to
 * rebuild/result.json and is compared with the sharer's, for information only.
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { ROOT } from "../template-media";
import { measureLoudness } from "../reel/make-reel";
import {
  cleanFileName,
  distinctCleans,
  inBundle,
  parts,
  probeRecording,
  readJob,
  readStamp,
  safeRelPath,
  sha256File,
  STAMP_FILE,
  readConfig,
  type Check,
  type CleanSpec,
  type Job,
  type LocalConfig,
  type ReelPart,
  type Output,
  type Parts,
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

/** What --only picks out of a bundle; unknown names are an error. */
export function selectParts(p: Parts, only: string[]): Parts {
  if (!only.length) return p;
  const known = new Set([...(p.edit ? ["edit"] : []), ...p.reels.map((r) => r.slug)]);
  const unknown = only.filter((o) => !known.has(o));
  if (unknown.length) throw new Error(`--only ${unknown.join(", ")}: this bundle has ${[...known].join(", ")}`);
  return { ...p, edit: p.edit && only.includes("edit"), reels: p.reels.filter((r) => only.includes(r.slug)) };
}

async function main() {
  const args = parseBundleArgs(process.argv.slice(2), "bun run rerender <bundle> --recording <file> [--only edit|<reel>] [--reuse-clean] [--cut-only]");
  for (const f of args.flags) if (f !== "--reuse-clean" && f !== "--cut-only") throw new Error(`unknown option ${f}`);
  if (!args.recording) throw new Error("pass --recording <your copy of the raw recording>");
  const bundle = args.bundle;

  const todo = selectParts(parts(readJob(bundle)), args.only);
  // The reels render with this checkout's node packages: make them exactly what bun.lock says first.
  if (todo.reels.length) run(["bun", "install", "--frozen-lockfile"], ROOT);

  const select = args.only.length ? [...(todo.edit ? ["edit"] : []), ...todo.reels.map((r) => r.slug)] : undefined;
  const { job, recording, reproducible, checks } = runPreflight(bundle, args.recording, select);
  if (!reproducible || !recording) throw new Error(`\n${notRendering(checks, bundle, args.recording)}`);

  const rebuild = rebuildDir(bundle, job.episode, readConfig(ROOT));
  mkdirSync(rebuild, { recursive: true });
  console.log(`\nRebuilding into ${rebuild}`);

  // Private media the render reads from public/ (preflight made sure ours is absent or the same).
  for (const f of job.files)
    if (f.publicPath && !existsSync(join(ROOT, "public", f.publicPath))) {
      mkdirSync(dirname(join(ROOT, "public", f.publicPath)), { recursive: true });
      copyFileSync(inBundle(bundle, f.path), join(ROOT, "public", f.publicPath));
    }

  /* ---------- the clean cut (and the edit), once ---------- */

  const own = join(rebuild, `${job.episode}.clean.mp4`);
  const edited = join(rebuild, `${job.episode}.edited.mp4`);
  const base = baseStamp(job);
  const reuse = args.flags.has("--reuse-clean");
  let stamp = reuse ? readStamp(rebuild, base) : null;
  if (stamp && existsSync(own) && (todo.noIntro || existsSync(edited))) {
    console.log(`\nReusing ${own}${todo.noIntro ? "" : " and the edit"} (made from these same decisions and recording)`);
  } else {
    if (reuse) console.log("\nNot reusing rebuild/: it wasn't made from this share's decisions and recording.");
    rmSync(join(rebuild, STAMP_FILE), { force: true });
    const decisions = JSON.parse(readFileSync(inBundle(bundle, `${job.episode}.decisions.json`), "utf8"));
    const local = join(rebuild, `${job.episode}.shared-input.json`);
    writeFileSync(local, JSON.stringify(localDecisions(bundle, decisions), null, 1));
    run(
      ["uv", "run", "sesh-edit", recording, "--from-decisions", local, "--no-share", ...(todo.noIntro ? ["--no-intro"] : []), "-o", edited],
      join(ROOT, "longform"),
    );
    stamp = { ...base, upscales: [] };
    writeFileSync(join(rebuild, STAMP_FILE), JSON.stringify(stamp, null, 1));
  }

  /* ---------- each upscale the reels were cut from, once ---------- */

  for (const clean of distinctCleans(todo.reels)) {
    const file = join(rebuild, cleanFileName(job.episode, clean));
    if (clean.method !== "none") {
      const name = cleanFileName(job.episode, clean);
      if (reuse && stamp.upscales.includes(name) && existsSync(file)) console.log(`\nReusing ${file}`);
      else {
        run(["uv", "run", "sesh-upscale", own, "-o", file, "--method", clean.method, "--height", String(clean.height)], join(ROOT, "longform"));
        stamp = { ...stamp, upscales: [...stamp.upscales.filter((u) => u !== name), name] };
        writeFileSync(join(rebuild, STAMP_FILE), JSON.stringify(stamp, null, 1));
      }
    }
    const problem = cleanSizeProblem(clean, probeRecording(file));
    if (problem) throw new Error(problem);
  }

  /* ---------- the results ---------- */

  const results = readResults(rebuild);
  const lines: string[] = [];
  if (todo.edit && !todo.noIntro) {
    const out: Output = { file: edited, bytes: statSync(edited).size, sha256: sha256File(edited) };
    results.edit = out;
    lines.push(`Edit: ${edited}\n  ${compare(todo.editReference, out)}`);
  }
  for (const reel of todo.reels) {
    const output = join(rebuild, `${reel.slug}.reel.mp4`);
    const cutOnly = args.flags.has("--cut-only") ? ["--cut-only"] : [];
    const def = localReel(bundle, rebuild, job.episode, reel);
    run(["bun", join("scripts", "reel", "make-reel.ts"), def, "--out", output, "--no-share", ...cutOnly], ROOT);
    if (cutOnly.length) continue;
    const out: Output = { file: output, bytes: statSync(output).size, sha256: sha256File(output), loudness: await measureLoudness(output) };
    results.reels[reel.slug] = out;
    lines.push(`Reel ${reel.slug}: ${output}\n  ${compare(reel.reference, out)}`);
  }
  writeFileSync(join(rebuild, "result.json"), JSON.stringify(results, null, 1));
  console.log(`\nDone.\n${lines.join("\n") || "(--cut-only: nothing rendered)"}`);
}

/** What the clean cut is made from: the shared decisions, the recording, whether the edit's intro is on, and which intro. */
export function baseStamp(job: Job): Omit<RebuildStamp, "upscales"> {
  const decisions = job.files.find((f) => f.role === "decisions" && f.path === `${job.episode}.decisions.json`);
  const intro = !parts(job).noIntro;
  const introFiles = job.files.filter((f) => f.role === "intro").map((f) => `${f.path}:${f.sha256}`).sort();
  return {
    decisions: decisions?.sha256 ?? "",
    recording: job.recording.fingerprint,
    intro,
    introDigest: intro && introFiles.length ? createHash("sha256").update(introFiles.join("\n")).digest("hex") : null,
  };
}

/**
 * Where the rebuild goes. A bundle in the shared folder ("bundles" in share.local.json)
 * must not fill it with gigabytes of clean cuts and upscales for everyone: there it's
 * "rebuilds" in share.local.json, else ~/waterhouse-rebuilds, then <episode>/. Any other
 * bundle (a local copy): its own rebuild/.
 */
export function rebuildDir(bundle: string, episode: string, config: LocalConfig, home = homedir()): string {
  const shared = config.bundles ? resolve(config.bundles) : null;
  const rel = shared ? relative(shared, resolve(bundle)) : "..";
  const inShared = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  if (!inShared) return join(bundle, "rebuild");
  return join(config.rebuilds ? resolve(config.rebuilds) : join(home, "waterhouse-rebuilds"), episode);
}

/** A copy of the bundle's reel definition next to the rebuild, reading the clean cut there and the bundle's decisions. */
export function localReel(bundle: string, rebuild: string, episode: string, reel: ReelPart): string {
  const def = JSON.parse(readFileSync(inBundle(bundle, reel.def), "utf8"));
  def.episode = { clean: join(rebuild, cleanFileName(episode, reel.clean)), decisions: inBundle(bundle, `${episode}.decisions.json`) };
  const out = join(rebuild, `${reel.slug}.shared-input.reel.json`);
  writeFileSync(out, JSON.stringify(def, null, 1));
  return out;
}

/** Why nothing renders, naming the commit and the worktree to use when only a part's code differs. */
export function notRendering(checks: Check[], bundle: string, recording?: string): string {
  const failed = checks.filter((c) => !c.ok && !c.warn);
  const code = failed.filter((c) => c.code);
  if (!code.length || code.length !== failed.length) return "Not rendering: fix what preflight lists first.";
  const lines = ["Not rendering: some parts were made with code this checkout doesn't have."];
  for (const c of code) {
    const sha = c.code!.commit;
    const what = c.code!.parts.map((p) => (p === "edit" ? "the edit (and every clean cut)" : `reel ${p}`)).join(", ");
    lines.push(
      `  ${what}: render from ${sha.slice(0, 7)} in its own checkout:`,
      `    git worktree add ../share-${sha.slice(0, 7)} ${sha}`,
      `    cd ../share-${sha.slice(0, 7)} && bun install && (cd longform && uv sync)`,
      `    bun run rerender "${bundle}" --recording "${recording ?? "<your copy>"}"${c.code!.parts.includes("edit") ? "" : ` --only ${c.code!.parts.join(",")}`}`,
    );
  }
  lines.push("  or --only the parts that do match here.");
  return lines.join("\n");
}

type Results = { edit?: Output; reels: Record<string, Output> };

function readResults(rebuild: string): Results {
  try {
    const r = JSON.parse(readFileSync(join(rebuild, "result.json"), "utf8"));
    if (r && typeof r === "object" && r.reels) return r;
  } catch {
    // none yet, or the #61 shape: start over
  }
  return { reels: {} };
}

/** The reel's crops are in the shared clean cut's pixels: a rebuilt one of another size must not be used. */
export function cleanSizeProblem(want: CleanSpec, got: { width: number; height: number }): string | null {
  return want.width === got.width && want.height === got.height
    ? null
    : `the rebuilt clean cut is ${got.width}x${got.height}, but the reel was cut from a ${want.width}x${want.height} one ` +
        `(${want.method === "none" ? "sesh-edit's own" : `a ${want.method} upscale`}): its crops would be wrong. Not rendering.`;
}

export function compare(ref: Output | undefined, result: Output): string {
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
