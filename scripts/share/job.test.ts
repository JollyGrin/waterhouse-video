import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findBin } from "../lib/ff";
import {
  cleanCheck,
  cleanFileName,
  cleanMethod,
  codeCheck,
  readFully,
  safeRelPath,
  stampMatches,
  STAMP_FILE,
  packagesCheck,
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
import { cleanSizeProblem, compare, localDecisions, rebuildStamp } from "./rerender";
import { ROOT } from "../template-media";

// Everything here is made up and tiny: no real recordings, no renders (#60).

const TMP = mkdtempSync(join(tmpdir(), "share-test-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const INFO: RecordingInfo = { duration: 1500, fps: 25, width: 1280, height: 720 };
/** Every made-up file is the recording's size, except an upscale. */
const probe = (file: string): RecordingInfo => (/1080p/.test(file) ? { ...INFO, width: 1920, height: 1080 } : INFO);
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
  writeFileSync(join(dir, "guest.clean.mp4"), bytes(100, 4));
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

  it("survives short reads (network drives, Dropbox Smart Sync)", () => {
    const a = join(TMP, "a.bin");
    const short: typeof readSync = ((fd: number, buf: Buffer, off: number, len: number, pos: number) =>
      readSync(fd, buf, off, Math.min(len, 7), pos)) as typeof readSync;
    expect(fingerprint(a, 1000, short)).toBe(fingerprint(a, 1000));
    const fd = openSync(a, "r");
    expect(readFully(fd, 50, 9_990, short).length).toBe(10); // stops at the end of the file
    closeSync(fd);
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

  it("refuses a bundle folder inside the repo", async () => {
    await expect(buildBundle({ input: reel, to: join(ROOT, "out", "shares"), probe, checkCode: false })).rejects.toThrow("inside the repo");
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

describe("re-sharing a received bundle", () => {
  it("Dean shares, Denzo changes it in place and shares it back: still reproducible", async () => {
    const { rec, reel } = episode(join(TMP, "dean"));
    const shares = join(TMP, "roundtrip");
    const { dir } = await buildBundle({ input: reel, to: shares, link: "https://example.com/rec", probe, checkCode: false });

    // Denzo keeps his copy of the raw in the bundle, rerenders (rebuild/), and tweaks a span
    writeFileSync(join(dir, "guest.mp4"), readFileSync(rec));
    mkdirSync(join(dir, "rebuild"));
    writeFileSync(join(dir, "rebuild", "guest.clean.mp4"), bytes(100, 4));
    const defPath = join(dir, "guest-best-30.reel.json");
    const def = JSON.parse(readFileSync(defPath, "utf8"));
    def.segments = [{ start: 2, end: 24 }];
    writeFileSync(defPath, JSON.stringify(def));

    // no --recording: found through the bundle's own job.json
    const again = await buildBundle({ input: defPath, to: shares, replace: true, probe, checkCode: false });
    expect(again.dir).toBe(dir);
    expect(existsSync(join(dir, "guest.mp4"))).toBe(true); // not ours to delete
    expect(existsSync(join(dir, "rebuild", "guest.clean.mp4"))).toBe(true);
    expect(again.job.recording.link).toBe("https://example.com/rec");
    expect(JSON.parse(readFileSync(defPath, "utf8")).segments).toEqual([{ start: 2, end: 24 }]);
    expect(JSON.parse(readFileSync(join(dir, "guest.decisions.json"), "utf8")).inserts[0].path).toBe("media/inserts/1-broll.mp4");

    const checks = preflight(dir, readJob(dir), { recording: join(dir, "guest.mp4"), probe, tools: again.job.tools, config: {} }).checks.filter(
      (c) => !c.label.startsWith("code") && c.label !== "node packages",
    );
    expect(formatReport(checks).text).toEndWith("REPRODUCIBLE");
  });

  it("leaves the old bundle untouched when the new share fails", async () => {
    const { reel } = episode(join(TMP, "dean2"));
    const shares = join(TMP, "roundtrip2");
    const { dir } = await buildBundle({ input: reel, to: shares, probe, checkCode: false });
    const before = readFileSync(join(dir, "job.json"), "utf8");
    unlinkSync(join(TMP, "dean2", "broll.mp4"));
    await expect(buildBundle({ input: reel, to: shares, replace: true, probe, checkCode: false })).rejects.toThrow("isn't on this computer");
    expect(readFileSync(join(dir, "job.json"), "utf8")).toBe(before);
    expect(existsSync(join(dir, "media", "inserts", "1-broll.mp4"))).toBe(true);
  });
});

describe("a reel cut from an upscaled clean cut", () => {
  it("tells how a clean cut was made", () => {
    const rec = { width: 1280, height: 720 };
    const hd = { width: 1920, height: 1080 };
    expect(cleanMethod("/x/ep.clean.mp4", rec, rec)).toBe("none");
    expect(cleanMethod("/x/ep.clean.x4plus1080p.mp4", hd, rec)).toBe("x4plus");
    expect(cleanMethod("/x/ep.clean.lanczos1080p.mp4", hd, rec)).toBe("lanczos");
    const dir = join(TMP, "upscaled");
    mkdirSync(join(dir, "ep.clean.1080p.upscale-work"), { recursive: true });
    expect(cleanMethod(join(dir, "ep.clean.1080p.mp4"), hd, rec)).toBeNull();
    writeFileSync(join(dir, "ep.clean.1080p.upscale-work", "status.json"), JSON.stringify({ settings: { method: "lanczos" } }));
    expect(cleanMethod(join(dir, "ep.clean.1080p.mp4"), hd, rec)).toBe("lanczos");
    expect(cleanFileName("ep", { width: 1920, height: 1080, method: "x4plus" })).toBe("ep.clean.x4plus1080p.mp4");
    expect(cleanFileName("ep", { width: 1280, height: 720, method: "none" })).toBe("ep.clean.mp4");
  });

  it("pins the upscale, and the rerender redoes it and checks its size", async () => {
    const src = join(TMP, "hd");
    const { reel } = episode(src);
    writeFileSync(join(src, "guest.clean.x4plus1080p.mp4"), bytes(100, 5));
    const def = JSON.parse(readFileSync(reel, "utf8"));
    def.episode.clean = "guest.clean.x4plus1080p.mp4";
    writeFileSync(reel, JSON.stringify(def));
    const { dir, job } = await buildBundle({ input: reel, to: join(TMP, "hd-shares"), probe, checkCode: false });
    expect(job.clean).toEqual({ width: 1920, height: 1080, method: "x4plus" });
    expect(JSON.parse(readFileSync(join(dir, "guest-best-30.reel.json"), "utf8")).episode.clean).toBe("rebuild/guest.clean.x4plus1080p.mp4");
    expect(cleanCheck(job.clean!)).toMatchObject({ ok: false, warn: true });
    expect(cleanSizeProblem(job.clean!, { width: 1280, height: 720 })).toContain("crops would be wrong");
    expect(cleanSizeProblem(job.clean!, { width: 1920, height: 1080 })).toBeNull();
  });

  it("refuses an upscale it can't name", async () => {
    const src = join(TMP, "hd2");
    const { reel } = episode(src);
    writeFileSync(join(src, "guest.clean.1080p.mp4"), bytes(100, 5));
    const def = JSON.parse(readFileSync(reel, "utf8"));
    def.episode.clean = "guest.clean.1080p.mp4";
    writeFileSync(reel, JSON.stringify(def));
    await expect(buildBundle({ input: reel, to: join(TMP, "hd2-shares"), probe, checkCode: false })).rejects.toThrow("can't tell how");
  });
});

describe("reusing rebuild/", () => {
  it("only when it was made from the same decisions, recording and clean cut", async () => {
    const { reel } = episode(join(TMP, "stamp"));
    const { job } = await buildBundle({ input: reel, to: join(TMP, "stamp-shares"), probe, checkCode: false });
    const rebuild = join(TMP, "stamp-rebuild");
    mkdirSync(rebuild, { recursive: true });
    const stamp = rebuildStamp(job);
    expect(stampMatches(rebuild, stamp)).toBe(false); // nothing there yet
    writeFileSync(join(rebuild, STAMP_FILE), JSON.stringify(stamp));
    expect(stampMatches(rebuild, stamp)).toBe(true);
    const changed = { ...job, files: job.files.map((f) => (f.role === "decisions" ? { ...f, sha256: "c".repeat(64) } : f)) };
    expect(stampMatches(rebuild, rebuildStamp(changed))).toBe(false);
    expect(stampMatches(rebuild, rebuildStamp({ ...job, clean: { width: 1920, height: 1080, method: "lanczos" } }))).toBe(false);
  });
});

describe("a damaged or hostile job.json", () => {
  it("refuses paths that could leave the bundle or public/ on any OS", () => {
    for (const p of ["../x", "a/../../x", "/etc/x", "C:/x", "C:\\x", "media\\inserts\\x.mp4", "audio/private/..\\..\\src\\x.tsx", "a//b", ""])
      expect(safeRelPath(p)).toBe(false);
    expect(safeRelPath("media/inserts/1-broll.mp4")).toBe(true);
  });

  it("checks names and the entries the rerender reads", async () => {
    const { reel } = episode(join(TMP, "hostile"));
    const { job } = await buildBundle({ input: reel, to: join(TMP, "hostile-shares"), probe, checkCode: false });
    expect(jobProblems({ ...job, name: "../evil" })[0]).toContain("letters, digits");
    expect(jobProblems({ ...job, files: [{ ...job.files[0], publicPath: "audio/private/..\\..\\src\\x.tsx" }] }).join()).toContain("private list");
    expect(jobProblems({ ...job, files: job.files.filter((f) => f.role !== "reel") }).join()).toContain("no reel entry guest-best-30.reel.json");
    expect(jobProblems({ ...job, clean: undefined }).join()).toContain("clean cut isn't pinned");
  });
});

describe("node packages", () => {
  it("compares what's installed with package.json's pins", () => {
    const root = join(TMP, "pkgs");
    mkdirSync(join(root, "node_modules", "remotion"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { remotion: "4.0.410", zod: "^3.0.0" } }));
    writeFileSync(join(root, "node_modules", "remotion", "package.json"), JSON.stringify({ version: "4.0.400" }));
    expect(packagesCheck(root).detail![0]).toBe("remotion 4.0.400 (want 4.0.410)");
    writeFileSync(join(root, "node_modules", "remotion", "package.json"), JSON.stringify({ version: "4.0.410" }));
    expect(packagesCheck(root).ok).toBe(true);
    expect(dirname(root)).toBe(TMP);
  });
});
