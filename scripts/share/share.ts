/**
 * Builds a job bundle (#60): everything a teammate needs to render this reel or edit
 * again from their own copy of the recording. See job.ts for what's in it.
 *
 *   bun run share <name>.reel.json      [--link <dropbox link>] [--recording <file>] [--to <folder>] [--replace]
 *   bun run share <name>.decisions.json (same flags)
 *
 * The bundle goes to <folder>/<slug or name>/, <folder> being --to or "bundles" in
 * share.local.json (gitignored, one per computer). It refuses when the repo has unsaved
 * changes or a commit that isn't pushed: the share pins the exact code.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { ROOT } from "../template-media";
import { measureLoudness, type ReelDef } from "../reel/make-reel";
import {
  bundleDir,
  codeRefusal,
  decisionsMismatch,
  git,
  JOB_VERSION,
  pinRecording,
  probeRecording,
  readConfig,
  reelPrivateMedia,
  sha256File,
  toolVersions,
  type FileRole,
  type Job,
  type Output,
  type PinnedFile,
  type RecordingInfo,
  type SeshDecisionsLite,
} from "./job";

/** Where sesh-edit keeps its built intro (a decisions file names it by bare file name). */
const INTRO_ASSETS = join("longform", "src", "sesh_edit", "assets", "intro");

export type ShareOptions = {
  input: string;
  recording?: string;
  link?: string;
  to?: string;
  replace?: boolean;
  root?: string;
  probe?: (file: string) => RecordingInfo;
  /** Off in tests that don't make a git checkout with a remote. */
  checkCode?: boolean;
};

export async function buildBundle(opts: ShareOptions): Promise<{ dir: string; job: Job }> {
  const root = opts.root ?? ROOT;
  const probe = opts.probe ?? probeRecording;
  const input = resolve(opts.input);
  if (!existsSync(input)) throw new Error(`${input} isn't there`);

  if (opts.checkCode !== false) {
    const refusal = codeRefusal(root);
    if (refusal) throw new Error(`Can't share yet: ${refusal}`);
  }

  /* ---------- what is being shared ---------- */

  let kind: Job["kind"];
  let def: ReelDef | null = null;
  let decisionsPath: string;
  if (input.endsWith(".reel.json")) {
    kind = "reel";
    def = (await Bun.file(input).json()) as ReelDef;
    if (!def.episode) throw new Error(`${basename(input)} isn't made from a sesh-edit episode (no "episode"): only those can be shared`);
    decisionsPath = resolve(dirname(input), def.episode.decisions);
  } else if (input.endsWith(".decisions.json")) {
    kind = "edit";
    decisionsPath = input;
  } else {
    throw new Error(`share a reel (<name>.reel.json) or an edit (<name>.decisions.json), not ${basename(input)}`);
  }
  if (!existsSync(decisionsPath)) throw new Error(`the edit's decisions file isn't there: ${decisionsPath}`);
  const decisions = (await Bun.file(decisionsPath).json()) as SeshDecisionsLite;
  const episode = basename(decisionsPath).replace(/\.decisions\.json$/, "");
  const name = def ? def.slug : episode;
  if (!/^[\w.-]+$/.test(name) || name.startsWith(".")) throw new Error(`"${name}" can't be a folder name: use letters, digits, - and _ only`);

  /* ---------- the recording ---------- */

  const recording = resolve(opts.recording ?? decisions.input);
  if (!existsSync(recording))
    throw new Error(`the recording isn't at ${recording}: pass --recording <file> (the raw file this edit was made from)`);
  const info = probe(recording);
  const mismatch = decisionsMismatch(decisions, info);
  if (mismatch) throw new Error(`${basename(recording)} isn't the recording this edit was made from: ${mismatch}`);
  console.log(`Fingerprinting ${basename(recording)}...`);
  const pinned = pinRecording(recording, opts.link, () => info);

  /* ---------- the bundle folder ---------- */

  const dir = bundleDir(name, opts.to, readConfig(root));
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    if (!existsSync(join(dir, "job.json"))) throw new Error(`${dir} already exists and isn't a share bundle: pick another --to`);
    if (!opts.replace) throw new Error(`${dir} is already shared: pass --replace to share it again (its rebuild/ folder is kept)`);
    for (const entry of readdirSync(dir)) if (entry !== "rebuild") rmSync(join(dir, entry), { recursive: true, force: true });
  }
  mkdirSync(dir, { recursive: true });

  const files: PinnedFile[] = [];
  const pin = (rel: string, role: FileRole, publicPath?: string) => {
    const p = join(dir, ...rel.split("/"));
    files.push({ path: rel, role, bytes: statSync(p).size, sha256: sha256File(p), ...(publicPath ? { publicPath } : {}) });
  };
  const copyIn = (src: string, rel: string, role: FileRole, publicPath?: string) => {
    const dest = join(dir, ...rel.split("/"));
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    pin(rel, role, publicPath);
  };

  /* ---------- the edit, with its clips and intro pointing into the bundle ---------- */

  const shared: SeshDecisionsLite = JSON.parse(JSON.stringify(decisions));
  (shared.inserts ?? []).forEach((ins, i) => {
    if (ins.kind !== "clip" || !ins.path) return;
    if (!existsSync(ins.path)) throw new Error(`the edit inserts a clip that isn't on this computer: ${ins.path}`);
    const rel = `media/inserts/${i + 1}-${basename(ins.path)}`;
    copyIn(ins.path, rel, "insert");
    ins.path = rel;
  });
  // A reel's clean cut has no intro (the rerender passes --no-intro); an edit's does.
  if (kind === "edit" && shared.intro?.file) {
    const file = isAbsolute(shared.intro.file) ? shared.intro.file : join(root, INTRO_ASSETS, shared.intro.file);
    if (!existsSync(file)) throw new Error(`the edit's intro isn't on this computer: ${file} (run bun run render:intro)`);
    const stem = basename(file, extname(file));
    for (const ext of [".json", ".flac", ".wav"]) {
      const side = join(dirname(file), stem + ext);
      if (side !== file && existsSync(side)) copyIn(side, `media/intro/${stem}${ext}`, "intro");
    }
    copyIn(file, `media/intro/${basename(file)}`, "intro");
    shared.intro.file = `media/intro/${basename(file)}`;
  }
  writeFileSync(join(dir, `${episode}.decisions.json`), JSON.stringify(shared, null, 1));
  pin(`${episode}.decisions.json`, "decisions");

  /* ---------- the reel, reading the clean cut the rerender makes ---------- */

  if (def) {
    const reel: ReelDef = { ...def, episode: { clean: `rebuild/${episode}.clean.mp4`, decisions: `${episode}.decisions.json` } };
    delete reel.output;
    writeFileSync(join(dir, `${def.slug}.reel.json`), JSON.stringify(reel, null, 1));
    pin(`${def.slug}.reel.json`, "reel");
    for (const p of reelPrivateMedia(root)) copyIn(join(root, "public", p), `media/public/${p}`, "private-media", p);
  }

  /* ---------- the sharer's own render, for comparison ---------- */

  let reference: Output | undefined;
  const ref = def
    ? def.output ? resolve(dirname(input), def.output) : join(dirname(input), `${def.slug}.reel.mp4`)
    : join(dirname(decisionsPath), `${episode}.edited.mp4`);
  if (existsSync(ref)) {
    console.log(`Hashing your render ${basename(ref)} (for comparison)...`);
    reference = { file: basename(ref), bytes: statSync(ref).size, sha256: sha256File(ref) };
    if (def) reference.loudness = await measureLoudness(ref);
  }

  const job: Job = {
    version: JOB_VERSION,
    kind,
    created: new Date().toISOString(),
    by: git(["config", "user.name"], root).out || undefined,
    name,
    episode,
    repo: { commit: git(["rev-parse", "HEAD"], root).out, branch: git(["branch", "--show-current"], root).out || undefined },
    tools: toolVersions(),
    recording: pinned,
    files,
    ...(reference ? { reference } : {}),
  };
  writeFileSync(join(dir, "job.json"), JSON.stringify(job, null, 1));
  writeFileSync(join(dir, "README.txt"), readme(job));
  return { dir, job };
}

export function readme(job: Job): string {
  const what = job.kind === "reel" ? `the reel "${job.name}"` : `the edit "${job.name}"`;
  return `This folder is a Waterhouse share: ${what}, ready to render again.

It is private (it names the guest and quotes the interview). Never put it in the repo.

You need your own copy of the raw recording: ${job.recording.name}
${job.recording.link ? `(download it here if you don't have it: ${job.recording.link})\n` : ""}
In the waterhouse-video repo, ask Claude: "render what's in <this folder>". Or run:

  bun run preflight "<this folder>" --recording "<your copy of ${job.recording.name}>"
  bun run rerender  "<this folder>" --recording "<your copy of ${job.recording.name}>"

preflight checks the code, the recording and every file, and ends with REPRODUCIBLE
or a list of what's missing. rerender does the same checks, then renders into rebuild/.
`;
}

/* ---------- command line ---------- */

function parseArgs(argv: string[]): ShareOptions {
  const out: Partial<ShareOptions> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--link") out.link = argv[++i];
    else if (a === "--recording") out.recording = argv[++i];
    else if (a === "--to") out.to = argv[++i];
    else if (a === "--replace") out.replace = true;
    else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else out.input = a;
  }
  if (!out.input) throw new Error("usage: bun run share <name>.reel.json | <name>.decisions.json [--link <url>] [--recording <file>] [--to <folder>] [--replace]");
  return out as ShareOptions;
}

if (/share\.ts$/.test(process.argv[1] ?? "")) {
  buildBundle(parseArgs(process.argv.slice(2)))
    .then(({ dir, job }) => {
      console.log(`\nShared ${job.kind} "${job.name}": ${dir}`);
      console.log(`  ${job.files.length} files pinned, code at ${job.repo.commit.slice(0, 7)}, recording ${job.recording.name}`);
      if (!job.recording.link) console.log("  No Dropbox link for the recording (add one with --link, so it can be downloaded again).");
      console.log("Send your teammate that folder (or its Dropbox link). They run: bun run rerender <folder> --recording <their copy>");
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
