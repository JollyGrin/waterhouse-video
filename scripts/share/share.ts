/**
 * Share bundles (#60, #62): everything a teammate needs to render an episode's edit and
 * its reels again from their own copy of the recording. See job.ts for what's in one.
 *
 *   bun run share <name>.reel.json | <name>.decisions.json [--local] [--link <url>] [--recording <file>] [--to <folder>]
 *   bun run share --publish <bundle | name.reel.json | name.decisions.json> [--to <folder>]
 *
 * One bundle per episode: the full edit (its decisions) and every reel shared from it
 * (reels/<slug>.reel.json). Sharing a reel adds or updates it and keeps the others; reels
 * next to the decisions (or in its reel/ folder) are picked up too.
 *
 * - `--local` writes the episode's local bundle next to its outputs, <name>.share/,
 *   nothing shared yet. `bun run reel` and sesh-edit do this by themselves after a render
 *   (auto.ts).
 * - Without it, the bundle goes straight to <folder>/<name>/: --to, or "bundles" in
 *   share.local.json (gitignored, one per computer: the shared Dropbox folder).
 * - `--publish` copies a local bundle (made first if a .json is given) into that folder,
 *   replacing safely and keeping reels that are only there.
 *
 * It refuses when the repo has unsaved changes or a commit that isn't pushed: a bundle
 * pins the exact code.
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { ROOT } from "../template-media";
import { measureLoudness, renderSidecar, type ReelDef } from "../reel/make-reel";
import {
  bundleDir,
  checkOutsideRepo,
  cleanFileName,
  cleanMethod,
  codeRefusal,
  CONFIG_FILE,
  decisionsMismatch,
  findRecording,
  git,
  JOB_VERSION,
  jobProblems,
  localBundleDir,
  parts,
  pinRecording,
  probeRecording,
  readConfig,
  readJob,
  recordingFolders,
  reelDefPath,
  reelPrivateMedia,
  SAFE_NAME,
  safeRelPath,
  sha256File,
  toolVersions,
  introDigest,
  type FileRole,
  type PartCommit,
  type ReelEntry,
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
  /** The local bundle next to the outputs instead of the shared folder. */
  local?: boolean;
  /** Accepted for #61 scripts; an episode bundle is always updated in place now. */
  replace?: boolean;
  root?: string;
  probe?: (file: string) => RecordingInfo;
  /** Off in tests that don't make a git checkout with a remote. */
  checkCode?: boolean;
  /** Print progress lines (off for the auto-bundle, which prints one line). */
  quiet?: boolean;
};

type ReelIn = { slug: string; def: ReelDef; defPath: string };

export async function buildBundle(opts: ShareOptions): Promise<{ dir: string; job: Job; notes: string[] }> {
  const root = opts.root ?? ROOT;
  const probe = opts.probe ?? probeRecording;
  const say = (line: string) => opts.quiet || console.log(line);
  const notes: string[] = [];
  const input = resolve(opts.input);
  if (!existsSync(input)) throw new Error(`${input} isn't there`);

  if (opts.checkCode !== false) {
    const refusal = codeRefusal(root);
    if (refusal) throw new Error(`Can't share yet: ${refusal}`);
  }

  /* ---------- the episode, and the reel being shared ---------- */

  let given: ReelIn | null = null;
  let decisionsPath: string;
  if (input.endsWith(".reel.json")) {
    const def = (await Bun.file(input).json()) as ReelDef;
    if (!def.episode) throw new Error(`${basename(input)} isn't made from a sesh-edit episode (no "episode"): only those can be shared`);
    given = { slug: def.slug, def, defPath: input };
    decisionsPath = resolve(dirname(input), def.episode.decisions);
  } else if (input.endsWith(".decisions.json")) {
    decisionsPath = input;
  } else {
    throw new Error(`share a reel (<name>.reel.json) or an edit (<name>.decisions.json), not ${basename(input)}`);
  }
  if (!existsSync(decisionsPath)) throw new Error(`the edit's decisions file isn't there: ${decisionsPath}`);
  const decisions = (await Bun.file(decisionsPath).json()) as SeshDecisionsLite;
  const episode = basename(decisionsPath).replace(/\.decisions\.json$/, "");
  if (!SAFE_NAME.test(episode)) throw new Error(`"${episode}" can't be a folder name: use letters, digits, - and _ only`);
  if (given && !SAFE_NAME.test(given.slug)) throw new Error(`reel slug "${given.slug}": use letters, digits, - and _ only`);
  const here = dirname(decisionsPath);
  /** A path in the decisions: absolute, or relative to the decisions file (a received bundle's media/...). */
  const fromDecisions = (p: string) => (isAbsolute(p) ? p : resolve(here, p));

  // A received bundle is itself the share (and may sit in the shared folder): no local bundle inside it.
  if (opts.local && existsSync(join(here, "job.json")))
    throw new Error(
      `${here} is a share bundle already: to share a change, edit its reels/<slug>.reel.json in place and run ` +
        `bun run share <that file> --to "${dirname(here)}"`,
    );

  /* ---------- the recording ---------- */

  const recording = resolve(opts.recording ?? findShared(here, decisions, root));
  if (!existsSync(recording))
    throw new Error(`the recording isn't at ${recording}: pass --recording <file> (the raw file this edit was made from)`);
  const info = probe(recording);
  const mismatch = decisionsMismatch(decisions, info);
  if (mismatch) throw new Error(`${basename(recording)} isn't the recording this edit was made from: ${mismatch}`);

  /* ---------- where it goes, and what's there already ---------- */

  const dir = opts.local ? checkOutsideRepo(localBundleDir(decisionsPath, episode), root) : bundleDir(episode, opts.to, readConfig(root), root);
  const unlock = opts.local ? () => {} : takeLock(dir, root);
  try {
    return await buildInto(dir, readExisting(dir));
  } finally {
    unlock();
  }

  async function buildInto(dir: string, old: Job | null): Promise<{ dir: string; job: Job; notes: string[] }> {

    say(`Fingerprinting ${basename(recording)}...`);
    const pinned = pinRecording(recording, undefined, () => info);
    if (old && old.recording?.fingerprint && old.recording.fingerprint !== pinned.fingerprint && !opts.replace)
      throw new Error(`${dir} is a share of a different recording (${old.recording.name}): pass --replace to overwrite it`);
    // Keep an earlier share's download link (this bundle's, or a received one being re-shared) when it's the same recording.
    const prior = old ?? (existsSync(join(here, "job.json")) ? (JSON.parse(readFileSync(join(here, "job.json"), "utf8")) as Job) : null);
    const link = opts.link ?? (prior?.recording?.fingerprint === pinned.fingerprint ? prior.recording.link : undefined);
    if (link) pinned.link = link;

    /* ---------- the reels: this one, the ones next to the edit, the ones already in the bundle ---------- */

    const reelsIn = new Map<string, ReelIn>();
    for (const r of findReels(decisionsPath)) reelsIn.set(r.slug, r);
    if (given) reelsIn.set(given.slug, given);

    const reels: Record<string, ReelEntry> = {};
    const priorReels = prior?.version === JOB_VERSION ? prior.reels ?? {} : {};
    for (const r of reelsIn.values()) {
      // a received bundle's reel: its clean cut and code version are already pinned there
      const fromBundle = existsSync(join(here, "job.json")) && resolve(dirname(r.defPath)) === resolve(here, "reels") && priorReels[r.slug];
      const commit = reelCommit(r, fromBundle ? priorReels[r.slug] : undefined);
      if (fromBundle) {
        reels[r.slug] = { clean: priorReels[r.slug].clean, ...commit };
        continue;
      }
      const file = resolve(dirname(r.defPath), r.def.episode!.clean);
      if (!existsSync(file)) {
        if (r === given)
          throw new Error(`the clean cut this reel was cut from isn't there: ${file} (its size decides the crops, so it's needed to share)`);
        notes.push(`left out reel ${r.slug}: its clean cut ${basename(file)} isn't on this computer`);
        reelsIn.delete(r.slug);
        continue;
      }
      const size = probe(file);
      const method = cleanMethod(file, size, info);
      if (!method) {
        const fix =
          `rename it to <name>.clean.x4plus${size.height}p.mp4 or <name>.clean.lanczos${size.height}p.mp4 ` +
          `(and "clean" in ${basename(r.defPath)})`;
        if (r === given) throw new Error(`can't tell how ${basename(file)} was upscaled: ${fix}, then share again`);
        notes.push(`left out reel ${r.slug}: can't tell how ${basename(file)} was upscaled (${fix})`);
        reelsIn.delete(r.slug);
        continue;
      }
      reels[r.slug] = { clean: { width: size.width, height: size.height, method }, ...commit };
    }
    // reels only in the existing bundle stay, as they were (with their own code version)
    const oldReels = old?.version === JOB_VERSION ? old.reels ?? {} : {};
    const kept = old?.version === JOB_VERSION ? parts(old).reels.filter((r) => !reelsIn.has(r.slug)) : [];

    /* ---------- build it outside the shared folder, so a failure never leaves a half bundle ---------- */

    const tmp = makeTemp(dir);
    try {
      const files: PinnedFile[] = [];
      const pin = (rel: string, role: FileRole, publicPath?: string) => {
        const p = join(tmp, ...rel.split("/"));
        files.push({ path: rel, role, bytes: statSync(p).size, sha256: sha256File(p), ...(publicPath ? { publicPath } : {}) });
      };
      const copyIn = (src: string, rel: string, role: FileRole, publicPath?: string) => {
        const dest = join(tmp, ...rel.split("/"));
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(src, dest);
        pin(rel, role, publicPath);
      };

      /* the edit, with its clips and intro pointing into the bundle */

      const shared: SeshDecisionsLite = JSON.parse(JSON.stringify(decisions));
      (shared.inserts ?? []).forEach((ins, i) => {
        if (ins.kind !== "clip" || !ins.path) return;
        const src = fromDecisions(ins.path);
        if (!existsSync(src)) throw new Error(`the edit inserts a clip that isn't on this computer: ${src}`);
        // a received bundle's clip is already numbered: don't number it twice
        const base = ins.path.startsWith("media/inserts/") ? basename(src).replace(/^\d+-/, "") : basename(src);
        const rel = `media/inserts/${i + 1}-${base}`;
        copyIn(src, rel, "insert");
        ins.path = rel;
      });
      // The edit renders with its intro: bundle the one it was made with, or leave the edit out (the reels don't need it).
      let editSkip: string | undefined;
      let introUnverified = false;
      let intro: string | undefined;
      if (shared.intro?.file) {
        // a bare name is sesh-edit's built intro; a path is absolute or relative to the decisions
        const f = shared.intro.file;
        const file = /[\\/]/.test(f) ? fromDecisions(f) : join(root, INTRO_ASSETS, f);
        const recorded = decisions.render?.intro_digest ?? undefined;
        if (!existsSync(file)) editSkip = `its intro isn't on this computer (${file}: bun run render:intro)`;
        else if (recorded && introDigest(file) !== recorded)
          editSkip = "the intro changed since the edit was rendered: render the edit again (sesh-edit --from-decisions), then share";
        else {
          introUnverified = !recorded;
          intro = introDigest(file);
          const stem = basename(file, extname(file));
          for (const ext of [".json", ".flac", ".wav"]) {
            const side = join(dirname(file), stem + ext);
            if (side !== file && existsSync(side)) copyIn(side, `media/intro/${stem}${ext}`, "intro");
          }
          copyIn(file, `media/intro/${basename(file)}`, "intro");
          shared.intro.file = `media/intro/${basename(file)}`;
        }
      }
      if (editSkip) {
        if (!reelsIn.size && !kept.length) throw new Error(`nothing to share: the edit can't be (${editSkip}) and there are no reels`);
        notes.push(`left out the edit: ${editSkip}`);
      }
      const code = decisions.render?.code;
      const editCommit: PartCommit = code && !code.dirty && /^[0-9a-f]{40}$/.test(code.commit) ? { commit: code.commit } : { commitAssumed: true };
      const decisionsText = JSON.stringify(shared, null, 1);
      if (kept.length && old && existsSync(join(dir, `${episode}.decisions.json`)) && readFileSync(join(dir, `${episode}.decisions.json`), "utf8") !== decisionsText)
        notes.push(`the edit changed since ${kept.map((r) => r.slug).join(", ")} was shared: check those reels' spans still fit`);
      writeFileSync(join(tmp, `${episode}.decisions.json`), decisionsText);
      pin(`${episode}.decisions.json`, "decisions");

      /* the reels, reading the clean cut the rerender makes */

      for (const r of reelsIn.values()) {
        const reel: ReelDef = {
          ...r.def,
          episode: { clean: `../rebuild/${cleanFileName(episode, reels[r.slug].clean)}`, decisions: `../${episode}.decisions.json` },
        };
        delete reel.output;
        mkdirSync(join(tmp, "reels"), { recursive: true });
        writeFileSync(join(tmp, ...reelDefPath(r.slug).split("/")), JSON.stringify(reel, null, 1));
        pin(reelDefPath(r.slug), "reel");
      }
      for (const r of kept) {
        copyIn(join(dir, ...r.def.split("/")), r.def, "reel");
        reels[r.slug] = { ...oldReels[r.slug] };
      }
      if (Object.keys(reels).length) for (const p of reelPrivateMedia(root)) copyIn(join(root, "public", p), `media/public/${p}`, "private-media", p);

      /* the sharer's own renders, for comparison */

      const reference = async (file: string, loud: boolean): Promise<Output | undefined> => {
        if (!existsSync(file)) return undefined;
        say(`Hashing your render ${basename(file)} (for comparison)...`);
        const out: Output = { file: basename(file), bytes: statSync(file).size, sha256: sha256File(file) };
        if (loud) out.loudness = await measureLoudness(file);
        return out;
      };
      for (const r of reelsIn.values()) {
        const out = r.def.output ? resolve(dirname(r.defPath), r.def.output) : join(dirname(r.defPath), `${r.slug}.reel.mp4`);
        reels[r.slug].reference = await reference(out, true);
      }
      const editRef = editSkip
        ? undefined
        : ((await reference(join(here, `${episode}.edited.mp4`), false)) ?? (old?.version === JOB_VERSION ? old.edit?.reference : undefined));

      const job: Job = {
        version: JOB_VERSION,
        created: new Date().toISOString(),
        by: git(["config", "user.name"], root).out || undefined,
        name: episode,
        episode,
        repo: { commit: git(["rev-parse", "HEAD"], root).out, branch: git(["branch", "--show-current"], root).out || undefined },
        tools: toolVersions(),
        recording: pinned,
        files,
        edit: editSkip
          ? { skipped: editSkip }
          : { ...editCommit, ...(intro ? { intro } : {}), ...(introUnverified ? { introUnverified } : {}), ...(editRef ? { reference: editRef } : {}) },
        reels: Object.fromEntries(Object.entries(reels).sort(([a], [b]) => a.localeCompare(b))),
      };
      writeFileSync(join(tmp, "job.json"), JSON.stringify(job, null, 1));
      writeFileSync(join(tmp, "README.txt"), readme(job));

      /* swap: take out only what the old share put there, move the new one in, job.json last */

      swapIn(tmp, dir, old);
      verifyBundle(dir, job);
      return { dir, job, notes };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}

/**
 * A reel's code version: what make-reel recorded next to its render (<reel>.render.json),
 * else what a received bundle pinned for it, else the share's commit (assumed).
 */
function reelCommit(r: ReelIn, fromBundle?: ReelEntry): PartCommit {
  const out = r.def.output ? resolve(dirname(r.defPath), r.def.output) : join(dirname(r.defPath), `${r.slug}.reel.mp4`);
  try {
    const v = JSON.parse(readFileSync(renderSidecar(out), "utf8"));
    if (v && v.dirty === false && /^[0-9a-f]{40}$/.test(v.commit)) return { commit: v.commit };
  } catch {
    // never rendered here, or before the sidecar existed
  }
  if (fromBundle?.commit) return { commit: fromBundle.commit, ...(fromBundle.commitAssumed ? { commitAssumed: true } : {}) };
  return { commitAssumed: true };
}

/** Reel definitions next to the decisions (or in its reel/ folder) made from this episode. */
export function findReels(decisionsPath: string): ReelIn[] {
  const here = dirname(decisionsPath);
  const out: ReelIn[] = [];
  for (const folder of [here, join(here, "reel"), join(here, "reels")]) {
    if (!existsSync(folder) || !statSync(folder).isDirectory()) continue;
    for (const name of readdirSync(folder)) {
      if (!name.endsWith(".reel.json")) continue;
      const defPath = join(folder, name);
      try {
        const def = JSON.parse(readFileSync(defPath, "utf8")) as ReelDef;
        if (def.episode && SAFE_NAME.test(def.slug) && resolve(folder, def.episode.decisions) === resolve(decisionsPath))
          out.push({ slug: def.slug, def, defPath });
      } catch {
        // not a reel definition we can read: not this episode's
      }
    }
  }
  return out;
}

/** Without --recording: the decisions' own path, else (a received bundle) the recording its job.json pins. */
function findShared(here: string, decisions: SeshDecisionsLite, root: string): string {
  if (existsSync(decisions.input)) return decisions.input;
  const jobFile = join(here, "job.json");
  if (existsSync(jobFile)) {
    const pin = (JSON.parse(readFileSync(jobFile, "utf8")) as Job).recording;
    const found = pin && findRecording(pin, recordingFolders(here, readConfig(root)));
    if (found) return found;
  }
  return decisions.input;
}

/** Delete the files an earlier share wrote (its job.json list, README.txt, job.json) and the folders they leave empty. Nothing else. */
export function removeShared(dir: string, old: Pick<Job, "files">) {
  const rels = [...(old.files ?? []).map((f) => f.path).filter(safeRelPath), "job.json", "README.txt"];
  for (const rel of rels) {
    rmSync(join(dir, ...rel.split("/")), { force: true });
    // tidy now-empty parent folders (media/inserts, media, reels), never the bundle itself
    let parent = dirname(join(dir, ...rel.split("/")));
    while (parent.startsWith(dir) && parent !== dir && existsSync(parent) && readdirSync(parent).length === 0) {
      rmdirSync(parent);
      parent = dirname(parent);
    }
  }
}

function moveInto(from: string, to: string, skip: string[] = []) {
  for (const entry of readdirSync(from)) {
    if (skip.includes(entry)) continue;
    const src = join(from, entry);
    const dest = join(to, entry);
    if (statSync(src).isDirectory()) {
      mkdirSync(dest, { recursive: true });
      moveInto(src, dest);
    } else moveFile(src, dest);
  }
}

/** rename, or copy + delete across drives (the temp folder is outside the shared one). */
function moveFile(src: string, dest: string) {
  rmSync(dest, { force: true });
  try {
    renameSync(src, dest);
  } catch {
    copyFileSync(src, dest);
    unlinkSync(src);
  }
}

/* ---------- writing into a (possibly shared, synced) bundle folder safely ---------- */

/** In a bundle folder while a swap is under way: no job.json + this = an interrupted swap, safe to redo. */
export const SWAP_MARK = ".share-swap";
const LOCK_STALE_MS = 10 * 60 * 1000;

/** A fresh build folder outside the shared folder (so Dropbox never syncs a half-built bundle); clears #63's old siblings. */
function makeTemp(dir: string): string {
  if (existsSync(dirname(dir)))
    for (const n of readdirSync(dirname(dir))) if (n.startsWith(`${basename(dir)}.sharing-`)) rmSync(join(dirname(dir), n), { recursive: true, force: true });
  return mkdtempSync(join(tmpdir(), "waterhouse-share-"));
}

/**
 * Take out only what the old share put there, move the new files in, job.json last. A
 * folder without job.json but with SWAP_MARK was interrupted: the next share redoes it.
 */
export function swapIn(tmp: string, dir: string, old: Pick<Job, "files"> | null) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, SWAP_MARK), new Date().toISOString());
  rmSync(join(dir, "job.json"), { force: true });
  if (old) removeShared(dir, old);
  moveInto(tmp, dir, ["job.json"]);
  moveFile(join(tmp, "job.json"), join(dir, "job.json"));
  rmSync(join(dir, SWAP_MARK), { force: true });
}

/** Read the bundle back and check every file: a sync client could have changed it under us. */
export function verifyBundle(dir: string, want: Job) {
  const back = readJob(dir);
  const bad = back.files.find((f) => {
    const p = join(dir, ...f.path.split("/"));
    return !existsSync(p) || sha256File(p) !== f.sha256;
  });
  if (JSON.stringify(back) !== JSON.stringify(JSON.parse(JSON.stringify(want))) || bad)
    throw new Error(`Not shared: ${dir} doesn't match what was written${bad ? ` (${bad.path})` : ""}; try again`);
}

/**
 * The share already in `dir`, checked, or null when there's none (or a swap was
 * interrupted). Refuses one it can't keep safely: an unreadable or newer job.json, or a
 * reel it lists that isn't there yet (Dropbox still syncing), so nobody's reels get dropped.
 */
export function readExisting(dir: string): Job | null {
  if (!existsSync(dir) || readdirSync(dir).length === 0) return null;
  if (!existsSync(join(dir, "job.json"))) {
    if (existsSync(join(dir, SWAP_MARK))) return null;
    throw new Error(`${dir} already exists and isn't a share bundle: pick another --to`);
  }
  const syncing = (why: string) => new Error(`Not shared: the share in ${dir} isn't complete (${why}). Dropbox may still be syncing it: try again in a minute.`);
  let old: Job;
  try {
    old = JSON.parse(readFileSync(join(dir, "job.json"), "utf8")) as Job;
  } catch {
    throw syncing("its job.json can't be read");
  }
  if (typeof old.version === "number" && old.version > JOB_VERSION)
    throw new Error(`Not shared: ${dir} was shared from a newer version of the repo (job.json version ${old.version}): get the latest work first`);
  const problems = jobProblems(old);
  if (problems.length) throw syncing(`its job.json: ${problems[0]}`);
  for (const r of parts(old).reels) if (!existsSync(join(dir, ...r.def.split("/")))) throw syncing(`${r.def} is listed but not there`);
  return old;
}

/** A short-lived lock next to a shared bundle, so two people sharing the same episode at once don't interleave. */
export function takeLock(dir: string, root = ROOT): () => void {
  const lock = join(dirname(dir), `.${basename(dir)}.publishing`);
  if (existsSync(lock)) {
    let held: { by?: string; at?: string } | null = null;
    try {
      held = JSON.parse(readFileSync(lock, "utf8"));
    } catch {
      held = null; // unreadable: treat as stale
    }
    if (held?.at && Date.now() - Date.parse(held.at) < LOCK_STALE_MS)
      throw new Error(`Not shared: ${held.by ?? "someone"} is sharing ${basename(dir)} right now (since ${held.at.slice(11, 16)} UTC). Try again in a few minutes.`);
  }
  mkdirSync(dirname(lock), { recursive: true });
  writeFileSync(lock, JSON.stringify({ by: git(["config", "user.name"], root).out || "someone", host: hostname(), pid: process.pid, at: new Date().toISOString() }));
  return () => rmSync(lock, { force: true });
}

/* ---------- publish: a local bundle into the shared folder ---------- */

export type PublishOptions = {
  source: string;
  to?: string;
  link?: string;
  recording?: string;
  root?: string;
  checkCode?: boolean;
  probe?: (file: string) => RecordingInfo;
};

/**
 * Copies a local bundle into the shared folder (<to or share.local.json "bundles">/<episode>/).
 * Given a .reel.json or .decisions.json, (re)makes the local bundle first. Replaces like a
 * re-share: built outside the shared folder, swapped in (job.json last), only the old
 * share's own files removed, reels that are only in the shared copy (a teammate's) kept
 * with their own code versions, and a short lock while it writes.
 */
export async function publish(opts: PublishOptions): Promise<{ dir: string; job: Job; notes: string[] }> {
  const root = opts.root ?? ROOT;
  const config = readConfig(root);
  if (!opts.to && !config.bundles)
    throw new Error(
      `Not shared: this computer doesn't know the shared Dropbox folder yet. Set "bundles" in ${CONFIG_FILE} at the repo root, ` +
        `e.g. {"bundles": "<your Dropbox>/Waterhouse/shares"}, or pass --to <folder>.`,
    );
  let local = resolve(opts.source);
  const notes: string[] = [];
  if (local.endsWith(".json")) {
    const made = await buildBundle({
      input: local,
      local: true,
      root,
      checkCode: opts.checkCode,
      probe: opts.probe,
      quiet: true,
      recording: opts.recording,
      link: opts.link,
    });
    local = made.dir;
    notes.push(...made.notes);
  }
  const job = readJob(local);
  if (opts.checkCode !== false && !git(["branch", "-r", "--contains", job.repo.commit], root).out)
    throw new Error(`Not shared: the code this bundle pins (${job.repo.commit.slice(0, 7)}) isn't backed up online. Push it, then publish again.`);
  for (const f of job.files) {
    const p = join(local, ...f.path.split("/"));
    if (!existsSync(p) || sha256File(p) !== f.sha256) throw new Error(`Not shared: ${f.path} changed or is missing in ${local}; make the bundle again (bun run share <its .json> --local)`);
  }
  const dir = bundleDir(job.episode, opts.to, config, root);
  if (dir === local) return { dir, job, notes };

  const unlock = takeLock(dir, root);
  const tmp = makeTemp(dir);
  try {
    const old = readExisting(dir);
    if (old?.recording?.fingerprint && old.recording.fingerprint !== job.recording.fingerprint)
      throw new Error(`Not shared: ${dir} is a share of a different recording (${old.recording.name}). Move it aside first.`);
    const files = [...job.files];
    const copy = (from: string, rel: string) => {
      const dest = join(tmp, ...rel.split("/"));
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(join(from, ...rel.split("/")), dest);
    };
    for (const f of job.files) copy(local, f.path);
    const link = opts.link ?? job.recording.link;
    const out: Job = { ...job, recording: { ...job.recording, ...(link ? { link } : {}) }, files, reels: { ...(job.reels ?? {}) } };
    // a teammate's reels that are only in the shared copy stay, exactly as pinned there
    if (old?.version === JOB_VERSION) {
      for (const r of parts(old).reels) {
        if (out.reels![r.slug]) continue;
        const entry = old.files.find((f) => f.path === r.def && f.role === "reel")!;
        copy(dir, r.def);
        files.push({ ...entry, sha256: sha256File(join(tmp, ...r.def.split("/"))) });
        out.reels![r.slug] = { ...old.reels![r.slug] };
        notes.push(`kept reel ${r.slug}, which was only in the shared folder`);
      }
    }
    writeFileSync(join(tmp, "job.json"), JSON.stringify(out, null, 1));
    writeFileSync(join(tmp, "README.txt"), readme(out));
    swapIn(tmp, dir, old);
    verifyBundle(dir, out);
    return { dir, job: out, notes };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    unlock();
  }
}

export function readme(job: Job): string {
  const p = parts(job);
  const what = [p.edit ? `the edit "${job.episode}"` : "", ...p.reels.map((r) => `the reel "${r.slug}"`)].filter(Boolean).join(", ");
  return `This folder is a Waterhouse share: ${what}, ready to render again.

It is private (it names the guest and quotes the interview). Never put it in the repo.

You need your own copy of the raw recording: ${job.recording.name}
${job.recording.link ? `(download it here if you don't have it: ${job.recording.link})\n` : ""}
In the waterhouse-video repo, ask Claude: "render what's in <this folder>". Or run:

  bun run preflight "<this folder>" --recording "<your copy of ${job.recording.name}>"
  bun run rerender  "<this folder>" --recording "<your copy of ${job.recording.name}>"

preflight checks the code, the recording and every file, and ends with REPRODUCIBLE
or a list of what's missing. rerender does the same checks, then renders the edit and
every reel into rebuild/ (--only edit or --only <reel> for just one).
`;
}

/* ---------- command line ---------- */

function parseArgs(argv: string[]): ShareOptions & { publish: boolean } {
  const out: Partial<ShareOptions> & { publish: boolean } = { publish: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--link") out.link = argv[++i];
    else if (a === "--recording") out.recording = argv[++i];
    else if (a === "--to") out.to = argv[++i];
    else if (a === "--replace") out.replace = true;
    else if (a === "--local") out.local = true;
    else if (a === "--publish") out.publish = true;
    else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else out.input = a;
  }
  if (!out.input)
    throw new Error(
      "usage: bun run share <name>.reel.json | <name>.decisions.json [--local] [--link <url>] [--recording <file>] [--to <folder>]\n" +
        "       bun run share --publish <bundle | name.reel.json | name.decisions.json> [--to <folder>]",
    );
  return out as ShareOptions & { publish: boolean };
}

export function summary(job: Job, notes: string[]): string {
  const p = parts(job);
  return [
    `  ${[p.edit ? "the edit" : "", ...p.reels.map((r) => `reel ${r.slug}`)].filter(Boolean).join(", ")}; ${job.files.length} files, code at ${job.repo.commit.slice(0, 7)}, recording ${job.recording.name}`,
    ...notes.map((n) => `  Note: ${n}`),
    ...(job.recording.link ? [] : ["  No Dropbox link for the recording (add one with --link, so it can be downloaded again)."]),
  ].join("\n");
}

if (/share\.ts$/.test(process.argv[1] ?? "")) {
  const args = (() => {
    try {
      return parseArgs(process.argv.slice(2));
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }
  })();
  (args.publish ? publish({ source: args.input, to: args.to, link: args.link, recording: args.recording }) : buildBundle(args))
    .then(({ dir, job, notes }) => {
      if (args.publish) console.log(`\nShared "${basename(dir)}" in the shared folder: ${dir}`);
      else if (args.local) console.log(`\nBundled (not shared yet): ${dir}\nTo share it: bun run share --publish "${dir}"`);
      else console.log(`\nShared "${basename(dir)}": ${dir}`);
      console.log(summary(job, notes));
      if (!args.local) console.log(`Tell your teammate the folder name "${basename(dir)}". They run: bun run rerender <folder> --recording <their copy>`);
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
