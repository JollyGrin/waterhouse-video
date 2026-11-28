/**
 * Reproducible shares (#60): a job bundle carries everything a reel or an edit needs to
 * render again on a teammate's computer, except the raw recording (both sides have it).
 *
 *   bun run share <name>.reel.json | <name>.decisions.json   builds the bundle (share.ts)
 *   bun run preflight <bundle> [--recording <file>]          says REPRODUCIBLE or what's off
 *   bun run rerender <bundle> --recording <file>             preflight → clean cut → reel
 *
 * A bundle is a plain folder: put it in the shared Dropbox folder or send its link.
 *
 *   <bundle>/job.json               what this file's `Job` type says: every input, pinned
 *   <bundle>/README.txt             the steps, in plain words
 *   <bundle>/<slug>.reel.json       the reel (a reel share); episode.clean → rebuild/
 *   <bundle>/<name>.decisions.json  the edit; inserted clips and a custom intro point into media/
 *   <bundle>/media/...              those clips, the intro, private media the render uses
 *   <bundle>/rebuild/...            made by `rerender`
 *
 * It names the guest, quotes the interview and may hold a Dropbox link to the recording:
 * never in git (.gitignore has job.json, and scripts/no-tracked-private.test.ts checks).
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { findBin } from "../lib/ff";
import { isPrivate, PRIVATE_MEDIA } from "../private-media";
import { findMediaRefs, readSources, ROOT } from "../template-media";

/** 2: one bundle per episode, the edit and its reels (#62). 1: one reel or one edit (#60), still read. */
export const JOB_VERSION = 2;
/** The fast fingerprint reads this much from each end of the recording. */
export const FINGERPRINT_CHUNK = 16 * 1024 * 1024;

export type RecordingInfo = { duration: number; fps: number; width: number; height: number };

export type PinnedRecording = RecordingInfo & {
  /** The file name on the sharer's computer (the receiver's copy may be named the same). */
  name: string;
  bytes: number;
  /** sha256 of the size, the first and the last 16 MiB (the whole file when it's smaller). */
  fingerprint: string;
  /** Where to download it again (a Dropbox share link). Optional; private. */
  link?: string;
};

export type FileRole = "reel" | "decisions" | "insert" | "intro" | "private-media";

export type PinnedFile = {
  /** Relative to the bundle, forward slashes. */
  path: string;
  role: FileRole;
  bytes: number;
  sha256: string;
  /** private-media only: where it goes, relative to the repo's public/. */
  publicPath?: string;
};

export type Job = {
  version: number;
  /** Version 1 only: what the bundle held. A version 2 bundle holds the edit and `reels`. */
  kind?: "reel" | "edit";
  created: string;
  by?: string;
  /** The reel's slug, or the edit's name: also the bundle folder's name. */
  name: string;
  /** The edit's name: <name>.decisions.json in the bundle, rebuild/<name>.clean.mp4 after a rerender. */
  episode: string;
  repo: { commit: string; branch?: string };
  tools: Tools;
  recording: PinnedRecording;
  files: PinnedFile[];
  /** Version 1 reel: the clean cut the reel was cut from (its `shots` are in its pixels). */
  clean?: CleanSpec;
  /** Version 1: the sharer's own render, for comparison only (bit-identical output isn't promised). */
  reference?: Output;
  /** Version 2: the full edit (always there: every episode gets one). */
  edit?: { reference?: Output };
  /** Version 2: every reel shared from this episode, by slug: reels/<slug>.reel.json. */
  reels?: Record<string, { clean: CleanSpec; reference?: Output }>;
};

/** One reel in a bundle, whatever its version. */
export type ReelPart = { slug: string; def: string; clean: CleanSpec; reference?: Output };

/** What a bundle renders: the edit (with its intro) and/or reels, the same for both versions. */
export type Parts = { edit: boolean; editReference?: Output; reels: ReelPart[]; noIntro: boolean };

export function parts(job: Job): Parts {
  if (job.version === 1) {
    if (job.kind === "reel")
      return { edit: false, noIntro: true, reels: [{ slug: job.name, def: `${job.name}.reel.json`, clean: job.clean!, reference: job.reference }] };
    return { edit: true, editReference: job.reference, noIntro: false, reels: [] };
  }
  return {
    edit: true,
    editReference: job.edit?.reference,
    noIntro: false,
    reels: Object.entries(job.reels ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([slug, r]) => ({ slug, def: reelDefPath(slug), clean: r.clean, reference: r.reference })),
  };
}

/** Where a version 2 bundle keeps a reel's definition. */
export const reelDefPath = (slug: string) => `reels/${slug}.reel.json`;

/**
 * The clean cut a reel reads: sesh-edit's own (`none`, the recording's frame size) or an
 * upscale of it (`sesh-upscale --method <method> --height <height>`), which the rerender
 * redoes after rebuilding the clean cut.
 */
export type CleanSpec = { width: number; height: number; method: "none" | "lanczos" | "x4plus" };

export type Tools = { ffmpeg: string | null; bun: string | null; uv: string | null };
export type Output = { file: string; bytes: number; sha256: string; loudness?: { i: number; tp: number } };

/* ---------- hashing ---------- */

export function sha256File(file: string): string {
  const hash = createHash("sha256");
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(4 * 1024 * 1024);
    let n: number;
    while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

/**
 * Read `len` bytes at `from`, or up to the end of the file. One readSync can return fewer
 * bytes than asked (network drives, Dropbox Smart Sync), so it loops.
 */
export function readFully(fd: number, len: number, from: number, read: typeof readSync = readSync): Buffer {
  const buf = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const n = read(fd, buf, got, len - got, from + got);
    if (n <= 0) break;
    got += n;
  }
  return buf.subarray(0, got);
}

/** sha256 of the size and both ends: seconds on a 10 GB recording, and a different take never matches. */
export function fingerprint(file: string, chunk = FINGERPRINT_CHUNK, read: typeof readSync = readSync): string {
  const size = statSync(file).size;
  const hash = createHash("sha256").update(`${size}\n`);
  const fd = openSync(file, "r");
  try {
    const take = (from: number, len: number) => hash.update(readFully(fd, len, from, read));
    if (size <= 2 * chunk) take(0, size);
    else {
      take(0, chunk);
      take(size - chunk, chunk);
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

/* ---------- probing ---------- */

/** Duration, frame rate and frame size, read the way sesh-edit's media.probe reads them. */
export function probeRecording(file: string): RecordingInfo {
  const bin = findBin("ffprobe");
  if (!bin) throw new Error("ffprobe not found: install ffmpeg (GETTING-STARTED.md section 1)");
  const res = spawnSync(
    bin,
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "format=duration:stream=width,height,r_frame_rate", "-of", "json", file],
    { encoding: "utf8" },
  );
  if (res.status !== 0) throw new Error(`can't read ${basename(file)} as a video: ${res.stderr.trim()}`);
  const j = JSON.parse(res.stdout);
  const v = j.streams?.[0];
  if (!v) throw new Error(`${basename(file)} has no video`);
  const [num, den] = String(v.r_frame_rate).split("/").map(Number);
  return { duration: Number(j.format.duration), fps: num / (den || 1), width: v.width, height: v.height };
}

export function pinRecording(file: string, link?: string, probe = probeRecording): PinnedRecording {
  return {
    name: basename(file),
    bytes: statSync(file).size,
    fingerprint: fingerprint(file),
    ...probe(file),
    ...(link ? { link } : {}),
  };
}

/** Problems with using `file` as the recording `pin` describes; empty = it's the same file. */
export function recordingProblems(pin: PinnedRecording, file: string, probe = probeRecording): string[] {
  if (!existsSync(file)) return [`the recording ${file} isn't there`];
  const name = basename(file);
  const out: string[] = [];
  const bytes = statSync(file).size;
  if (bytes !== pin.bytes) out.push(`${name} is ${bytes} bytes, the shared one was ${pin.bytes}`);
  else if (fingerprint(file) !== pin.fingerprint) out.push(`${name} is the right size but different content: not the same recording`);
  let info: RecordingInfo;
  try {
    info = probe(file);
  } catch (err) {
    return [...out, err instanceof Error ? err.message : String(err)];
  }
  if (Math.abs(info.duration - pin.duration) > 0.1) out.push(`${name} is ${info.duration.toFixed(2)}s long, the shared one was ${pin.duration.toFixed(2)}s`);
  if (Math.abs(info.fps - pin.fps) > 0.01) out.push(`${name} is ${info.fps.toFixed(3)} fps, the shared one was ${pin.fps.toFixed(3)} fps`);
  if (info.width !== pin.width || info.height !== pin.height)
    out.push(`${name} is ${info.width}x${info.height}, the shared one was ${pin.width}x${pin.height}`);
  if (out.length) out.unshift("WRONG RECORDING: not the one that was shared");
  return out;
}

/** What sesh-edit's adopt_recording checks: is `info` the recording these decisions were made on? */
export function decisionsMismatch(decisions: SeshDecisionsLite, info: RecordingInfo): string | null {
  const want = decisions.stats?.input_duration_s;
  if (want !== undefined && Math.abs(info.duration - want) > 0.5)
    return `it is ${info.duration.toFixed(2)}s but the edit was made on a ${want.toFixed(2)}s recording`;
  const old = decisions.input_info;
  if (old?.fps !== undefined && Math.abs(info.fps - old.fps) > 0.01) return `it is ${info.fps.toFixed(3)} fps, the edit's was ${old.fps.toFixed(3)}`;
  if (old?.width !== undefined && (info.width !== old.width || info.height !== old.height))
    return `it is ${info.width}x${info.height}, the edit's was ${old.width}x${old.height}`;
  return null;
}

/** The parts of a sesh-edit decisions file a share touches. */
export type SeshDecisionsLite = {
  input: string;
  input_info?: Partial<RecordingInfo>;
  stats?: { input_duration_s?: number };
  inserts?: { kind: string; path?: string }[];
  intro?: { file: string } | null;
};

/* ---------- the code and the tools ---------- */

export function git(args: string[], cwd = ROOT) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { ok: res.status === 0, out: (res.stdout ?? "").trim(), err: (res.stderr ?? "").trim() };
}

/** Why the checkout can't be pinned (changed tracked files, a commit not on GitHub), or null. */
export function codeRefusal(cwd = ROOT): string | null {
  const status = git(["diff", "--name-only", "HEAD"], cwd); // staged or not
  if (!status.ok) return `not a git checkout with a commit (${status.err})`;
  if (status.out) {
    const files = status.out.split("\n");
    return (
      `there are unsaved changes to the repo (${files.slice(0, 5).join(", ")}${files.length > 5 ? ", ..." : ""}).\n` +
      "A share pins the exact code, so save and back them up online first (commit and push), then share again."
    );
  }
  const remote = git(["branch", "-r", "--contains", "HEAD"], cwd);
  if (!remote.ok || !remote.out)
    return "this version of the code isn't backed up online yet (the commit isn't pushed).\nPush it first, so your teammate can get exactly this code, then share again.";
  return null;
}

export function toolVersions(): Tools {
  const first = (cmd: string | null, args: string[]) => {
    if (!cmd) return null;
    const res = spawnSync(cmd, args, { encoding: "utf8" });
    return res.status === 0 ? (res.stdout || res.stderr).split("\n")[0].trim() : null;
  };
  return {
    ffmpeg: first(Bun.which("ffmpeg"), ["-version"]),
    bun: Bun.version,
    uv: first(Bun.which("uv"), ["--version"]),
  };
}

/* ---------- private media a reel uses ---------- */

/** The folders a reel's render reads its template code from. */
const REEL_SOURCES = ["src/reel/", "src/ident/", "src/session/"];

/**
 * Private files (scripts/private-media.ts) under public/ that the reel's code names and
 * this computer has. The render's own output (`generated` on the list) is left out: the
 * rerender makes it again.
 */
export function reelPrivateMedia(root = ROOT): string[] {
  const refs = findMediaRefs(readSources(root).filter((f) => REEL_SOURCES.some((d) => f.path.startsWith(d))));
  const found = new Set<string>();
  for (const ref of refs) {
    if (ref.pattern) continue;
    for (const c of ref.candidates) {
      const entry = isPrivate(c, PRIVATE_MEDIA);
      if (entry && !entry.generated && existsSync(join(root, "public", c))) found.add(c);
    }
  }
  return [...found].sort();
}

/* ---------- per-machine config ---------- */

/** share.local.json at the repo root (gitignored): where this computer keeps bundles and recordings. */
export type LocalConfig = { bundles?: string; recordings?: string[] };
export const CONFIG_FILE = "share.local.json";

export function readConfig(root = ROOT): LocalConfig {
  const p = join(root, CONFIG_FILE);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch (err) {
    throw new Error(`${p} isn't valid JSON: ${err instanceof Error ? err.message : err}`);
  }
}

/** Where to look for the recording when --recording isn't given. */
export function recordingFolders(bundle: string, config: LocalConfig): string[] {
  const home = homedir();
  return [
    bundle,
    ...(config.recordings ?? []),
    join(home, "Movies", "waterhouse", "in"), // Macs (GETTING-STARTED.md)
    join(home, "Videos", "sesh-in"), // the GPU box
    join(home, "Downloads"),
  ];
}

/** The first file named like the pinned recording, with its size, in `folders`. */
export function findRecording(pin: PinnedRecording, folders: string[]): string | null {
  for (const dir of folders) {
    const p = join(dir, pin.name);
    if (existsSync(p) && statSync(p).size === pin.bytes) return p;
  }
  for (const dir of folders) {
    const p = join(dir, pin.name);
    if (existsSync(p)) return p; // same name, wrong size: preflight will say so loudly
  }
  return null;
}

/* ---------- job.json ---------- */

export function readJob(bundle: string): Job {
  const p = join(bundle, "job.json");
  if (!existsSync(p)) throw new Error(`${bundle} isn't a share bundle (no job.json in it)`);
  const job = JSON.parse(readFileSync(p, "utf8")) as Job;
  const problems = jobProblems(job);
  if (problems.length) throw new Error(`${p} is damaged:\n  ${problems.join("\n  ")}`);
  return job;
}

export function jobProblems(job: Partial<Job>): string[] {
  const out: string[] = [];
  if (job.version !== 1 && job.version !== JOB_VERSION)
    out.push(`version ${job.version}, this repo reads versions 1 and ${JOB_VERSION} (get the latest work)`);
  if (job.version === 1 && job.kind !== "reel" && job.kind !== "edit") out.push(`kind ${JSON.stringify(job.kind)}`);
  if (job.version === JOB_VERSION && (typeof job.reels !== "object" || job.reels === null || Array.isArray(job.reels))) out.push("no reels map");
  if (!job.name || !job.episode) out.push("no name or episode");
  else if (!SAFE_NAME.test(job.name) || !SAFE_NAME.test(job.episode)) out.push(`name ${JSON.stringify(job.name)} / episode ${JSON.stringify(job.episode)}: letters, digits, - and _ only`);
  if (!job.repo?.commit || !/^[0-9a-f]{40}$/.test(job.repo.commit)) out.push("no repo commit");
  const r = job.recording;
  if (!r || !r.name || !r.fingerprint || !(r.bytes > 0) || !(r.duration > 0) || !(r.fps > 0) || !(r.width > 0) || !(r.height > 0))
    out.push("the recording isn't fully pinned (name, bytes, fingerprint, duration, fps, frame size)");
  if (!Array.isArray(job.files)) out.push("no file list");
  else {
    for (const f of job.files)
      if (!safeRelPath(f.path) || !/^[0-9a-f]{64}$/.test(f.sha256 ?? "")) out.push(`file entry ${JSON.stringify(f.path)}`);
      else if (f.publicPath !== undefined && (!safeRelPath(f.publicPath) || !isPrivate(f.publicPath)))
        out.push(`file entry ${JSON.stringify(f.path)}: public/${f.publicPath} isn't on the private list`);
    // the files the rerender reads by name
    const need: [string, FileRole][] = [[`${job.episode}.decisions.json`, "decisions"]];
    if (job.version === 1 && job.kind === "reel") need.push([`${job.name}.reel.json`, "reel"]);
    for (const slug of Object.keys(job.version === JOB_VERSION ? job.reels ?? {} : {}))
      if (!SAFE_NAME.test(slug)) out.push(`reel ${JSON.stringify(slug)}: letters, digits, - and _ only`);
      else need.push([reelDefPath(slug), "reel"]);
    for (const [path, role] of need)
      if (!job.files.some((f) => f.path === path && f.role === role)) out.push(`no ${role} entry ${path}`);
  }
  const cleans: [string, CleanSpec | undefined][] =
    job.version === 1 ? (job.kind === "reel" ? [[job.name ?? "", job.clean]] : []) : Object.entries(job.reels ?? {}).map(([k, r]) => [k, r?.clean]);
  for (const [slug, c] of cleans)
    if (!c || !(c.width > 0) || !(c.height > 0) || !["none", "lanczos", "x4plus"].includes(c.method)) out.push(`the clean cut of reel ${slug} isn't pinned`);
  return out;
}

/** A share's folder name, slug and episode name. */
export const SAFE_NAME = /^(?!\.)[\w.-]+$/;

/** A relative path with forward slashes only: no backslash, drive letter, absolute path or "..". */
export function safeRelPath(p: unknown): p is string {
  return (
    typeof p === "string" && p.length > 0 && !p.includes("\\") && !p.includes(":") && !p.startsWith("/") &&
    !isAbsolute(p) && !p.split("/").some((part) => part === ".." || part === "")
  );
}

/** A bundle-relative path on this computer. */
export const inBundle = (bundle: string, rel: string) => resolve(bundle, ...rel.split("/"));

/* ---------- preflight ---------- */

export type Check = { label: string; ok: boolean; warn?: boolean; detail?: string[] };

export type PreflightOptions = {
  recording?: string;
  root?: string;
  config?: LocalConfig;
  probe?: (file: string) => RecordingInfo;
  tools?: Tools;
};

/** Every check, in report order. Not reproducible = any check with ok false and no warn. */
export function preflight(bundle: string, job: Job, opts: PreflightOptions = {}): { checks: Check[]; recording: string | null } {
  const root = opts.root ?? ROOT;
  const checks: Check[] = [codeCheck(job.repo.commit, root)];

  const recording = opts.recording ? resolve(opts.recording) : findRecording(job.recording, recordingFolders(bundle, opts.config ?? readConfig(root)));
  if (!recording) {
    checks.push({
      label: `recording ${job.recording.name}`,
      ok: false,
      detail: [
        "not found: pass --recording <file> (or put it in ~/Movies/waterhouse/in/ or Videos\\sesh-in\\)",
        ...(job.recording.link ? [`download it again: ${job.recording.link}`] : []),
      ],
    });
  } else {
    const problems = recordingProblems(job.recording, recording, opts.probe);
    checks.push({ label: `recording ${recording}`, ok: problems.length === 0, detail: problems.length ? problems : undefined });
  }

  for (const f of job.files) {
    const p = inBundle(bundle, f.path);
    if (!existsSync(p)) checks.push({ label: `${f.role} ${f.path}`, ok: false, detail: ["missing from the bundle"] });
    else if (sha256File(p) !== f.sha256)
      checks.push({ label: `${f.role} ${f.path}`, ok: false, detail: ["changed since it was shared (its sha256 doesn't match job.json)"] });
    else if (f.publicPath && existsSync(join(root, "public", f.publicPath)) && sha256File(join(root, "public", f.publicPath)) !== f.sha256)
      checks.push({
        label: `${f.role} ${f.path}`,
        ok: false,
        detail: [`this computer has a different public/${f.publicPath}: move yours aside so the shared one can go there`],
      });
    else checks.push({ label: `${f.role} ${f.path}`, ok: true });
  }

  const reels = parts(job).reels;
  for (const c of distinctCleans(reels)) checks.push(cleanCheck(c));
  if (reels.length) checks.push(packagesCheck(root));
  checks.push(toolsCheck(job.tools, opts.tools ?? toolVersions()));
  return { checks, recording };
}

/** What a render can't depend on, so it may differ from the pinned commit. */
export const CODE_EXCLUDES = [
  "*.md",
  "**/*.test.ts",
  "**/*.test.tsx",
  "longform/tests/**",
  ".github/**",
  // job.ts and rerender.ts decide how the render runs, so they stay pinned
  "scripts/share/share.ts",
  "scripts/share/preflight.ts",
];

/** Is the pinned commit here, and does this checkout's code match it? */
export function codeCheck(commit: string, root = ROOT): Check {
  const label = `code at ${commit.slice(0, 7)}`;
  if (!git(["cat-file", "-e", `${commit}^{commit}`], root).ok)
    return {
      label,
      ok: false,
      detail: ["that commit isn't on this computer: get the latest work (git fetch). If it's still missing, the sender never pushed it."],
    };
  const head = git(["rev-parse", "HEAD"], root).out;
  // Working tree against the commit, so unsaved edits count too. Docs, tests and these
  // share scripts can't change a render.
  const diff = git(["diff", "--name-only", commit, "--", ".", ...CODE_EXCLUDES.map((p) => `:(exclude)${p}`)], root);
  const files = diff.out ? diff.out.split("\n") : [];
  if (files.length === 0) return { label, ok: true, detail: head === commit ? undefined : ["checked out elsewhere, but the code is the same"] };
  return {
    label,
    ok: false,
    detail: [
      `this checkout's code differs from it in ${files.length} file(s): ${files.slice(0, 8).join(", ")}${files.length > 8 ? ", ..." : ""}`,
      `render from that commit instead, e.g. git worktree add ../share-${commit.slice(0, 7)} ${commit}`,
    ],
  };
}

/* ---------- the clean cut, and the rebuild ---------- */

/** Each clean cut the reels need, once. */
export function distinctCleans(reels: { clean: CleanSpec }[]): CleanSpec[] {
  const seen = new Map<string, CleanSpec>();
  for (const r of reels) seen.set(JSON.stringify(r.clean), r.clean);
  return [...seen.values()];
}

/** The rebuilt clean cut's file name the shared reel definition reads. */
export function cleanFileName(episode: string, clean: CleanSpec): string {
  return clean.method === "none" ? `${episode}.clean.mp4` : `${episode}.clean.${clean.method}${clean.height}p.mp4`;
}

/**
 * How the clean cut at `file` was made: the recording's own size is sesh-edit's cut;
 * anything else is an upscale, named by its file name (".x4plus1080p") or by the
 * sesh-upscale work folder next to it. null = can't tell.
 */
export function cleanMethod(file: string, size: { width: number; height: number }, recording: { width: number; height: number }): CleanSpec["method"] | null {
  if (size.width === recording.width && size.height === recording.height) return "none";
  const name = basename(file).toLowerCase();
  if (name.includes("x4plus")) return "x4plus";
  if (name.includes("lanczos")) return "lanczos";
  const status = join(dirname(file), basename(file).replace(/\.mp4$/i, "") + ".upscale-work", "status.json");
  try {
    const method = JSON.parse(readFileSync(status, "utf8")).settings?.method;
    if (method === "x4plus" || method === "lanczos") return method;
  } catch {
    // no work folder: unknown
  }
  return null;
}

export function cleanCheck(clean: CleanSpec): Check {
  if (clean.method === "none") return { label: `clean cut ${clean.width}x${clean.height} (sesh-edit's own)`, ok: true };
  const label = `clean cut ${clean.width}x${clean.height}: rerender upscales it with sesh-upscale --method ${clean.method}`;
  return clean.method === "x4plus"
    ? { label, ok: false, warn: true, detail: ["an x4plus upscale isn't bit-identical across graphics cards, and takes hours: GPU box"] }
    : { label, ok: true };
}

/** Do the installed node packages match package.json's pinned versions (Remotion, fonts)? */
export function packagesCheck(root = ROOT): Check {
  const label = "node packages";
  let deps: Record<string, string>;
  try {
    deps = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).dependencies ?? {};
  } catch {
    return { label, ok: false, detail: ["no package.json"] };
  }
  const off: string[] = [];
  for (const [name, want] of Object.entries(deps)) {
    if (!/^\d+\.\d+\.\d+$/.test(want)) continue; // only exact pins can be compared
    let have: string | null = null;
    try {
      have = JSON.parse(readFileSync(join(root, "node_modules", name, "package.json"), "utf8")).version;
    } catch {
      have = null;
    }
    if (have !== want) off.push(`${name} ${have ?? "missing"} (want ${want})`);
  }
  return off.length ? { label, ok: false, detail: [...off.slice(0, 6), "run bun install --frozen-lockfile"] } : { label, ok: true };
}

/**
 * What rebuild/ was made from; --reuse-clean reuses the clean cut only when this matches,
 * and an upscale only when it's also listed in `upscales`.
 */
export type RebuildStamp = { decisions: string; recording: string; intro: boolean; upscales: string[] };

export const STAMP_FILE = "rebuild.json";

/** The stamp in rebuild/, if it was made from the same decisions, recording and intro choice; else null. */
export function readStamp(rebuild: string, want: Omit<RebuildStamp, "upscales">): RebuildStamp | null {
  try {
    const got = JSON.parse(readFileSync(join(rebuild, STAMP_FILE), "utf8")) as RebuildStamp;
    const same = got.decisions === want.decisions && got.recording === want.recording && got.intro === want.intro;
    return same ? { ...got, upscales: Array.isArray(got.upscales) ? got.upscales : [] } : null;
  } catch {
    return null;
  }
}

export function toolsCheck(pinned: Tools, here: Tools): Check {
  const diffs = (Object.keys(pinned) as (keyof Tools)[])
    .filter((k) => (pinned[k] ?? null) !== (here[k] ?? null))
    .map((k) => `${k}: shared with ${pinned[k] ?? "none"}, here ${here[k] ?? "none"}`);
  return diffs.length ? { label: "tool versions", ok: false, warn: true, detail: diffs } : { label: "tool versions", ok: true };
}

export function formatReport(checks: Check[]): { text: string; reproducible: boolean } {
  const lines: string[] = [];
  for (const c of checks) {
    lines.push(`${c.ok ? "ok  " : c.warn ? "warn" : "FAIL"}  ${c.label}`);
    for (const d of c.detail ?? []) lines.push(`        ${d}`);
  }
  const failed = checks.filter((c) => !c.ok && !c.warn);
  const warned = checks.filter((c) => c.warn);
  lines.push("");
  if (failed.length === 0) {
    lines.push(`REPRODUCIBLE${warned.length ? ` (${warned.length} warning: tool versions differ, the output may not be bit-identical)` : ""}`);
  } else {
    lines.push("NOT REPRODUCIBLE:");
    for (const c of failed) lines.push(`  - ${c.label}: ${(c.detail ?? []).join("; ")}`);
  }
  return { text: lines.join("\n"), reproducible: failed.length === 0 };
}

/** The bundle's folder for a share named `name`: --to, else share.local.json's `bundles`. */
export function bundleDir(name: string, to: string | undefined, config: LocalConfig, root = ROOT): string {
  const base = to ?? config.bundles;
  if (!base)
    throw new Error(
      `where should the bundle go? Pass --to <folder>, or set "bundles" in ${CONFIG_FILE} at the repo root ` +
        `(e.g. {"bundles": "<your Dropbox>/Waterhouse/shares"}).`,
    );
  return checkOutsideRepo(resolve(base, name), root);
}

/** The local, not-yet-shared bundle of an episode: next to its outputs (#62). */
export const localBundleDir = (decisionsPath: string, episode: string) => join(dirname(decisionsPath), `${episode}.share`);

/** `dir`, unless it's inside the repo and git would track it (the repo is public). */
export function checkOutsideRepo(dir: string, root = ROOT): string {
  const rel = relative(resolve(root), dir);
  const inside = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  // inside is fine only when gitignored, like a local bundle in out/ or a *.share/ folder
  if (inside && (rel === "" || !git(["check-ignore", "-q", "--no-index", rel.split("\\").join("/") + "/"], root).ok))
    throw new Error(`${dir} is inside the repo, which is public: put share bundles outside it (e.g. your Dropbox)`);
  return dir;
}
