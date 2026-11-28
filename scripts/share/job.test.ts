import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findBin } from "../lib/ff";
import {
  codeCheck,
  codeRefusal,
  decisionsMismatch,
  fingerprint,
  formatReport,
  jobProblems,
  pinRecording,
  preflight,
  probeRecording,
  readJob,
  recordingProblems,
  toolsCheck,
  type RecordingInfo,
} from "./job";
import { buildBundle } from "./share";
import { compare, localDecisions } from "./rerender";

// Everything here is made up and tiny: no real recordings, no renders (#60).

const TMP = mkdtempSync(join(tmpdir(), "share-test-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const INFO: RecordingInfo = { duration: 1500, fps: 25, width: 1280, height: 720 };
const probe = () => INFO;
const bytes = (n: number, seed: number) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 31 + seed) % 251));

function sh(cwd: string, ...args: string[]) {
  const res = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
  return res.stdout.trim();
}

/** A made-up episode: recording, decisions with one inserted clip, a reel definition. */
function episode(dir: string) {
  mkdirSync(dir, { recursive: true });
  const rec = join(dir, "guest.mp4");
  writeFileSync(rec, bytes(5000, 1));
  const clip = join(dir, "broll.mp4");
  writeFileSync(clip, bytes(300, 2));
  writeFileSync(
    join(dir, "guest.decisions.json"),
    JSON.stringify({
      input: rec,
      input_info: INFO,
      stats: { input_duration_s: INFO.duration },
      keep_segments: [[0, 10], [12, 20]],
      inserts: [{ kind: "clip", path: clip, before: 1, dur_s: 2 }],
      intro: { file: "fuse-16x9.webm", open_s: 3.9 },
      caption_words: [],
    }),
  );
  writeFileSync(
    join(dir, "guest.reel.json"),
    JSON.stringify({
      slug: "guest-best-30",
      title: "made up",
      episode: { clean: "guest.clean.mp4", decisions: "guest.decisions.json" },
      artist: "GUEST",
      episodeLabel: "WATERHOUSE SESSIONS",
      cta: "FULL INTERVIEW ON YOUTUBE",
      output: "somewhere/else.mp4",
      segments: [{ start: 1, end: 25 }],
    }),
  );
  return { rec, reel: join(dir, "guest.reel.json") };
}

describe("fingerprint", () => {
  it("tells two same-size files apart, at either end", () => {
    const a = join(TMP, "a.bin");
    const b = join(TMP, "b.bin");
    const buf = bytes(10_000, 3);
    writeFileSync(a, buf);
    buf[buf.length - 1] ^= 1; // only the last byte differs: in the tail chunk
    writeFileSync(b, buf);
    expect(fingerprint(a, 1000)).not.toBe(fingerprint(b, 1000));
    expect(fingerprint(a, 1000)).toBe(fingerprint(a, 1000));
    // a small file is hashed whole
    expect(fingerprint(a)).not.toBe(fingerprint(b));
  });
});

describe("share → job.json → preflight", async () => {
  const src = join(TMP, "sharer");
  const { rec, reel } = episode(src);
  const { dir, job } = await buildBundle({ input: reel, to: join(TMP, "shares"), link: "https://example.com/rec", probe, checkCode: false });

  it("round-trips the manifest", () => {
    expect(readJob(dir)).toEqual(JSON.parse(JSON.stringify(job)));
    expect(jobProblems(job)).toEqual([]);
    const evil = { ...job, files: [{ ...job.files[0], publicPath: "../src/Root.tsx" }] };
    expect(jobProblems(evil)[0]).toContain("isn't on the private list");
    expect(job.kind).toBe("reel");
    expect(job.name).toBe("guest-best-30");
    expect(job.recording).toMatchObject({ name: "guest.mp4", bytes: 5000, link: "https://example.com/rec", ...INFO });
    expect(job.files.map((f) => [f.role, f.path])).toEqual([
      ["insert", "media/inserts/1-broll.mp4"],
      ["decisions", "guest.decisions.json"],
      ["reel", "guest-best-30.reel.json"],
    ]);
  });

  it("points the reel and the edit into the bundle", () => {
    const def = JSON.parse(readFileSync(join(dir, "guest-best-30.reel.json"), "utf8"));
    expect(def.episode).toEqual({ clean: "rebuild/guest.clean.mp4", decisions: "guest.decisions.json" });
    expect(def.output).toBeUndefined();
    const dec = JSON.parse(readFileSync(join(dir, "guest.decisions.json"), "utf8"));
    expect(dec.inserts[0].path).toBe("media/inserts/1-broll.mp4");
    const local = localDecisions(dir, dec);
    expect(local.inserts![0].path).toBe(join(dir, "media", "inserts", "1-broll.mp4"));
    expect(readFileSync(join(dir, "README.txt"), "utf8")).toContain("guest.mp4");
  });

  it("refuses to overwrite a bundle unless asked", async () => {
    await expect(buildBundle({ input: reel, to: join(TMP, "shares"), probe, checkCode: false })).rejects.toThrow("--replace");
  });

  const run = (recording: string, tools = job.tools) =>
    preflight(dir, job, { recording, probe, tools, config: {} }).checks.filter((c) => !c.label.startsWith("code"));

  it("passes with the same recording and untouched files", () => {
    const checks = run(rec);
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(formatReport(checks)).toEqual(expect.objectContaining({ reproducible: true }));
    expect(formatReport(checks).text).toEndWith("REPRODUCIBLE");
  });

  it("fails loudly on a different recording with the same name and size", () => {
    const other = join(TMP, "receiver", "guest.mp4");
    mkdirSync(join(TMP, "receiver"), { recursive: true });
    writeFileSync(other, bytes(5000, 9));
    const report = formatReport(run(other));
    expect(report.reproducible).toBe(false);
    expect(report.text).toContain("WRONG RECORDING");
    expect(report.text).toContain("different content");
  });

  it("finds the recording by name when --recording isn't given", () => {
    const res = preflight(dir, job, { probe, tools: job.tools, config: { recordings: [src] } });
    expect(res.recording).toBe(rec);
  });

  it("flags a changed and a missing media file", () => {
    const clip = join(dir, "media", "inserts", "1-broll.mp4");
    writeFileSync(clip, bytes(300, 7));
    let report = formatReport(run(rec));
    expect(report.reproducible).toBe(false);
    expect(report.text).toContain("insert media/inserts/1-broll.mp4: changed since it was shared");
    unlinkSync(clip);
    report = formatReport(run(rec));
    expect(report.text).toContain("insert media/inserts/1-broll.mp4: missing from the bundle");
  });

  it("only warns when tool versions differ", () => {
    const check = toolsCheck({ ffmpeg: "ffmpeg version 7.1", bun: "1.3.0", uv: null }, { ffmpeg: "ffmpeg version 6.0", bun: "1.3.0", uv: null });
    expect(check).toMatchObject({ ok: false, warn: true });
    const report = formatReport([{ label: "x", ok: true }, check]);
    expect(report.reproducible).toBe(true);
    expect(report.text).toContain("REPRODUCIBLE (1 warning");
  });
});

describe("an edit share", () => {
  it("refuses an intro that isn't on this computer", async () => {
    const src = join(TMP, "edit");
    episode(src);
    const decisions = join(src, "guest.decisions.json");
    const d = JSON.parse(readFileSync(decisions, "utf8"));
    d.intro.file = join(src, "missing-intro.webm");
    writeFileSync(decisions, JSON.stringify(d));
    await expect(buildBundle({ input: decisions, to: join(TMP, "edit-shares"), probe, checkCode: false })).rejects.toThrow("intro isn't on this computer");
  });

  it("refuses a recording the edit wasn't made from", async () => {
    const src = join(TMP, "edit2");
    const { reel } = episode(src);
    const wrong = () => ({ ...INFO, duration: 900 });
    await expect(buildBundle({ input: reel, to: join(TMP, "x"), probe: wrong, checkCode: false })).rejects.toThrow("isn't the recording");
    expect(decisionsMismatch({ input: "", input_info: INFO }, { ...INFO, fps: 30 })).toContain("fps");
  });
});

describe("the code a share pins", () => {
  const repo = join(TMP, "repo");
  const remote = join(TMP, "remote.git");
  mkdirSync(repo, { recursive: true });
  sh(TMP, "init", "-q", "--bare", remote);
  sh(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
  writeFileSync(join(repo, "notes.md"), "notes\n");
  sh(repo, "add", "a.ts", "notes.md");
  sh(repo, "commit", "-q", "-m", "one");
  const first = sh(repo, "rev-parse", "HEAD");

  it("refuses a commit that isn't pushed", async () => {
    expect(codeRefusal(repo)).toContain("isn't backed up online");
    await expect(buildBundle({ input: join(TMP, "sharer", "guest.reel.json"), to: join(TMP, "y"), root: repo, probe })).rejects.toThrow("Can't share yet");
  });

  it("accepts a clean, pushed checkout", () => {
    sh(repo, "remote", "add", "origin", remote);
    sh(repo, "push", "-q", "-u", "origin", "main");
    expect(codeRefusal(repo)).toBeNull();
  });

  it("refuses unsaved changes to tracked files", () => {
    writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
    expect(codeRefusal(repo)).toContain("unsaved changes to the repo (a.ts)");
    sh(repo, "checkout", "--", "a.ts");
  });

  it("matches the pinned commit by its code, not its docs", () => {
    expect(codeCheck(first, repo).ok).toBe(true);
    writeFileSync(join(repo, "notes.md"), "more notes\n");
    sh(repo, "commit", "-q", "-am", "docs");
    expect(codeCheck(first, repo)).toMatchObject({ ok: true, detail: ["checked out elsewhere, but the code is the same"] });
    writeFileSync(join(repo, "a.ts"), "export const a = 3;\n");
    const check = codeCheck(first, repo);
    expect(check.ok).toBe(false);
    expect(check.detail![0]).toContain("a.ts");
    expect(codeCheck("0".repeat(40), repo).detail![0]).toContain("isn't on this computer");
  });
});

describe("with real (tiny) videos", () => {
  const ffmpeg = findBin("ffmpeg");
  it.skipIf(!ffmpeg || !findBin("ffprobe"))("pins a recording and rejects another take with the same name", () => {
    const make = (dir: string, source: string) => {
      mkdirSync(dir, { recursive: true });
      const out = join(dir, "take.mp4");
      const res = spawnSync(ffmpeg!, ["-v", "error", "-y", "-f", "lavfi", "-i", `${source}=d=1:s=160x90:r=25`, "-pix_fmt", "yuv420p", out]);
      if (res.status !== 0) throw new Error(String(res.stderr));
      return out;
    };
    const mine = make(join(TMP, "vid-a"), "testsrc");
    const theirs = make(join(TMP, "vid-b"), "smptebars");
    const pin = pinRecording(mine);
    expect(pin).toMatchObject({ name: "take.mp4", fps: 25, width: 160, height: 90 });
    expect(pin.duration).toBeCloseTo(1, 1);
    expect(recordingProblems(pin, mine)).toEqual([]);
    expect(recordingProblems(pin, theirs)[0]).toStartWith("WRONG RECORDING");
    expect(probeRecording(theirs)).toMatchObject({ width: 160, height: 90 });
  });
});

describe("the result", () => {
  it("compares with the sharer's render for information only", () => {
    const out = { file: "x.mp4", bytes: 1, sha256: "a".repeat(64), loudness: { i: -14, tp: -1.2 } };
    expect(compare({}, out)).toContain("no render of its own");
    expect(compare({ reference: out }, out)).toContain("Byte-for-byte");
    expect(compare({ reference: { ...out, sha256: "b".repeat(64), loudness: { i: -14.1, tp: -1 } } }, out)).toContain("Not byte-identical");
  });
});
