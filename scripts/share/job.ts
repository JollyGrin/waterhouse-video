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
import { basename, isAbsolute, join, resolve } from "node:path";
import { findBin } from "../lib/ff";
import { isPrivate, PRIVATE_MEDIA } from "../private-media";
import { findMediaRefs, readSources, ROOT } from "../template-media";

export const JOB_VERSION = 1;
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
  kind: "reel" | "edit";
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
  /** The sharer's own render, for comparison only (bit-identical output isn't promised). */
  reference?: Output;
};

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

/** sha256 of the size and both ends: seconds on a 10 GB recording, and a different take never matches. */
export function fingerprint(file: string, chunk = FINGERPRINT_CHUNK): string {
  const size = statSync(file).size;
  const hash = createHash("sha256").update(`${size}\n`);
  const fd = openSync(file, "r");
  try {
    const read = (from: number, len: number) => {
      const buf = Buffer.alloc(len);
      const n = readSync(fd, buf, 0, len, from);
      hash.update(buf.subarray(0, n));
    };
    if (size <= 2 * chunk) read(0, size);
    else {
      read(0, chunk);
      read(size - chunk, chunk);
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
  if (job.version !== JOB_VERSION) out.push(`version ${job.version}, this repo reads version ${JOB_VERSION} (get the latest work)`);
  if (job.kind !== "reel" && job.kind !== "edit") out.push(`kind ${JSON.stringify(job.kind)}`);
  if (!job.name || !job.episode) out.push("no name or episode");
  if (!job.repo?.commit || !/^[0-9a-f]{40}$/.test(job.repo.commit)) out.push("no repo commit");
  const r = job.recording;
  if (!r || !r.name || !r.fingerprint || !(r.bytes > 0) || !(r.duration > 0) || !(r.fps > 0) || !(r.width > 0) || !(r.height > 0))
    out.push("the recording isn't fully pinned (name, bytes, fingerprint, duration, fps, frame size)");
  if (!Array.isArray(job.files)) out.push("no file list");
  else
    for (const f of job.files)
      if (!f.path || isAbsolute(f.path) || f.path.split("/").includes("..") || !/^[0-9a-f]{64}$/.test(f.sha256 ?? ""))
        out.push(`file entry ${JSON.stringify(f.path)}`);
  return out;
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

  checks.push(toolsCheck(job.tools, opts.tools ?? toolVersions()));
  return { checks, recording };
}

/** What a render can't depend on, so it may differ from the pinned commit. */
export const CODE_EXCLUDES = ["*.md", "**/*.test.ts", "**/*.test.tsx", "scripts/share/**", "longform/tests/**", ".github/**"];

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
export function bundleDir(name: string, to: string | undefined, config: LocalConfig): string {
  const base = to ?? config.bundles;
  if (!base)
    throw new Error(
      `where should the bundle go? Pass --to <folder>, or set "bundles" in ${CONFIG_FILE} at the repo root ` +
        `(e.g. {"bundles": "<your Dropbox>/Waterhouse/shares"}).`,
    );
  return resolve(base, name);
}
