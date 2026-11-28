import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findBin } from "../lib/ff";
import {
  checkOutsideRepo,
  cleanCheck,
  cleanFileName,
  cleanMethod,
  codeCheck,
  readFully,
  safeRelPath,
  parts,
  readStamp,
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
import { buildBundle, publish } from "./share";
import { autoBundle } from "./auto";
import { baseStamp, cleanSizeProblem, compare, localDecisions, selectParts } from "./rerender";
import { ROOT } from "../template-media";

// Everything here is made up and tiny: no real recordings, no renders (#60, #62).

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
function episode(dir: string, slug = "guest-best-30") {
  mkdirSync(dir, { recursive: true });
  const rec = join(dir, "guest.mp4");
  writeFileSync(rec, bytes(5000, 1));
  const clip = join(dir, "broll.mp4");
  writeFileSync(clip, bytes(300, 2));
  writeFileSync(join(dir, "guest.clean.mp4"), bytes(100, 4));
  writeFileSync(join(dir, "intro.webm"), bytes(200, 6));
  writeFileSync(join(dir, "intro.json"), JSON.stringify({ open_s: 1 }));
  writeFileSync(
    join(dir, "guest.decisions.json"),
    JSON.stringify({
      input: rec,
      input_info: INFO,
      stats: { input_duration_s: INFO.duration },
      keep_segments: [[0, 10], [12, 20]],
      inserts: [{ kind: "clip", path: clip, before: 1, dur_s: 2 }],
      intro: { file: join(dir, "intro.webm"), open_s: 1 },
      caption_words: [],
    }),
  );
  writeFileSync(
    join(dir, "guest.reel.json"),
    JSON.stringify({
      slug,
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
    expect(job.version).toBe(2);
    expect(job.name).toBe("guest");
    expect(dir).toBe(join(TMP, "shares", "guest"));
    expect(job.recording).toMatchObject({ name: "guest.mp4", bytes: 5000, link: "https://example.com/rec", ...INFO });
    expect(job.files.map((f) => [f.role, f.path])).toEqual([
      ["insert", "media/inserts/1-broll.mp4"],
      ["intro", "media/intro/intro.json"],
      ["intro", "media/intro/intro.webm"],
      ["decisions", "guest.decisions.json"],
      ["reel", "reels/guest-best-30.reel.json"],
    ]);
    expect(job.reels).toEqual({ "guest-best-30": { clean: { width: 1280, height: 720, method: "none" } } });
    expect(parts(job)).toMatchObject({ edit: true, noIntro: false, reels: [{ slug: "guest-best-30", def: "reels/guest-best-30.reel.json" }] });
  });

  it("points the reel and the edit into the bundle", () => {
    const def = JSON.parse(readFileSync(join(dir, "reels", "guest-best-30.reel.json"), "utf8"));
    expect(def.episode).toEqual({ clean: "../rebuild/guest.clean.mp4", decisions: "../guest.decisions.json" });
    expect(def.output).toBeUndefined();
    const dec = JSON.parse(readFileSync(join(dir, "guest.decisions.json"), "utf8"));
    expect(dec.inserts[0].path).toBe("media/inserts/1-broll.mp4");
    const local = localDecisions(dir, dec);
    expect(local.inserts![0].path).toBe(join(dir, "media", "inserts", "1-broll.mp4"));
    expect(local.intro!.file).toBe(join(dir, "media", "intro", "intro.webm"));
    expect(readFileSync(join(dir, "README.txt"), "utf8")).toContain("guest.mp4");
  });

  it("refuses a bundle folder inside the repo", async () => {
    await expect(buildBundle({ input: reel, to: join(ROOT, "docs", "shares"), probe, checkCode: false })).rejects.toThrow("inside the repo");
  });

  it("refuses to overwrite a share of another recording unless asked", async () => {
    const other = join(TMP, "sharer-other");
    const { rec: otherRec, reel: otherReel } = episode(other);
    writeFileSync(otherRec, bytes(5000, 8)); // same name, another take
    await expect(buildBundle({ input: otherReel, to: join(TMP, "shares"), probe, checkCode: false })).rejects.toThrow("--replace");
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
  it("refuses an intro that isn't on this computer (now part of every bundle)", async () => {
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
    expect(compare(undefined, out)).toContain("no render of its own");
    expect(compare(out, out)).toContain("Byte-for-byte");
    expect(compare({ ...out, sha256: "b".repeat(64), loudness: { i: -14.1, tp: -1 } }, out)).toContain("Not byte-identical");
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
    const defPath = join(dir, "reels", "guest-best-30.reel.json");
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
    const clean = job.reels!["guest-best-30"].clean;
    expect(clean).toEqual({ width: 1920, height: 1080, method: "x4plus" });
    expect(JSON.parse(readFileSync(join(dir, "reels", "guest-best-30.reel.json"), "utf8")).episode.clean).toBe("../rebuild/guest.clean.x4plus1080p.mp4");
    expect(cleanCheck(clean)).toMatchObject({ ok: false, warn: true });
    expect(cleanSizeProblem(clean, { width: 1280, height: 720 })).toContain("crops would be wrong");
    expect(cleanSizeProblem(clean, { width: 1920, height: 1080 })).toBeNull();
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
  it("only when it was made from the same decisions and recording, and each upscale only once made", async () => {
    const { reel } = episode(join(TMP, "stamp"));
    const { job } = await buildBundle({ input: reel, to: join(TMP, "stamp-shares"), probe, checkCode: false });
    const rebuild = join(TMP, "stamp-rebuild");
    mkdirSync(rebuild, { recursive: true });
    const base = baseStamp(job);
    expect(readStamp(rebuild, base)).toBeNull(); // nothing there yet
    writeFileSync(join(rebuild, STAMP_FILE), JSON.stringify({ ...base, upscales: ["guest.clean.lanczos1080p.mp4"] }));
    expect(readStamp(rebuild, base)?.upscales).toEqual(["guest.clean.lanczos1080p.mp4"]);
    const changed = { ...job, files: job.files.map((f) => (f.role === "decisions" ? { ...f, sha256: "c".repeat(64) } : f)) };
    expect(readStamp(rebuild, baseStamp(changed))).toBeNull();
    expect(readStamp(rebuild, { ...base, recording: "d".repeat(64) })).toBeNull();
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
    expect(jobProblems({ ...job, files: job.files.filter((f) => f.role !== "reel") }).join()).toContain("no reel entry reels/guest-best-30.reel.json");
    expect(jobProblems({ ...job, reels: { "guest-best-30": { clean: undefined as never } } }).join()).toContain("clean cut of reel guest-best-30 isn't pinned");
    expect(jobProblems({ ...job, reels: { "../x": job.reels!["guest-best-30"] } }).join()).toContain("letters, digits");
    expect(jobProblems({ ...job, version: 3 }).join()).toContain("versions 1 and 2");
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

describe("one bundle per episode: the edit and several reels", () => {
  const src = join(TMP, "multi");
  const { rec, reel } = episode(src, "first-reel");
  // a second reel next to the edit, and a third one elsewhere (not picked up by itself)
  episodeReel(src, "second-reel", join(src, "second.reel.json"), "guest.decisions.json");
  mkdirSync(join(src, "elsewhere"));
  const third = episodeReel(src, "third-reel", join(src, "elsewhere", "third.reel.json"), "../guest.decisions.json");
  const shares = join(TMP, "multi-shares");

  it("picks up the reels next to the edit, and adds another without dropping them", async () => {
    const one = await buildBundle({ input: reel, to: shares, probe, checkCode: false });
    expect(Object.keys(one.job.reels!)).toEqual(["first-reel", "second-reel"]);
    const two = await buildBundle({ input: third, to: shares, probe, checkCode: false });
    expect(Object.keys(two.job.reels!)).toEqual(["first-reel", "second-reel", "third-reel"]);
    // the second reel is gone from the sharer's folder: re-sharing the first keeps it from the bundle
    unlinkSync(join(src, "second.reel.json"));
    const three = await buildBundle({ input: reel, to: shares, probe, checkCode: false });
    expect(Object.keys(three.job.reels!)).toEqual(["first-reel", "second-reel", "third-reel"]);
    expect(existsSync(join(three.dir, "reels", "second-reel.reel.json"))).toBe(true);
    expect(jobProblems(three.job)).toEqual([]);
  });

  it("preflights everything in it, and --only picks what the rerender does", async () => {
    const dir = join(shares, "guest");
    const job = readJob(dir);
    const checks = preflight(dir, job, { recording: rec, probe, tools: job.tools, config: {} }).checks;
    const labels = checks.map((c) => c.label);
    for (const slug of ["first-reel", "second-reel", "third-reel"]) expect(labels).toContain(`reel reels/${slug}.reel.json`);
    expect(labels).toContain("decisions guest.decisions.json");
    expect(labels).toContain("clean cut 1280x720 (sesh-edit's own)"); // once, though three reels use it
    expect(labels.filter((l) => l.startsWith("clean cut")).length).toBe(1);
    const p = parts(job);
    expect(selectParts(p, []).reels.length).toBe(3);
    expect(selectParts(p, ["edit"])).toMatchObject({ edit: true, reels: [] });
    expect(selectParts(p, ["second-reel"])).toMatchObject({ edit: false, reels: [{ slug: "second-reel" }] });
    expect(() => selectParts(p, ["nope"])).toThrow("this bundle has edit, first-reel, second-reel, third-reel");
  });
});

/** Another reel definition of the episode in `dir`, written to `at`. */
function episodeReel(dir: string, slug: string, at: string, decisions: string) {
  const def = JSON.parse(readFileSync(join(dir, "guest.reel.json"), "utf8"));
  def.slug = slug;
  def.episode = { clean: join(dir, "guest.clean.mp4"), decisions };
  delete def.output;
  writeFileSync(at, JSON.stringify(def));
  return at;
}

describe("an old (#61) bundle", () => {
  /** A version 1 bundle as #61 wrote it: one reel, its definition at the top, no intro. */
  function v1Bundle(dir: string, kind: "reel" | "edit") {
    mkdirSync(join(dir, "media", "inserts"), { recursive: true });
    writeFileSync(join(dir, "media", "inserts", "1-broll.mp4"), bytes(300, 2));
    writeFileSync(join(dir, "guest.decisions.json"), JSON.stringify({ input: "/x/guest.mp4", inserts: [{ kind: "clip", path: "media/inserts/1-broll.mp4" }] }));
    const files = [
      { path: "media/inserts/1-broll.mp4", role: "insert" },
      { path: "guest.decisions.json", role: "decisions" },
    ];
    if (kind === "reel") {
      writeFileSync(join(dir, "old-reel.reel.json"), JSON.stringify({ slug: "old-reel", episode: { clean: "rebuild/guest.clean.mp4", decisions: "guest.decisions.json" } }));
      files.push({ path: "old-reel.reel.json", role: "reel" });
    }
    const rec = join(dir, "guest.mp4");
    writeFileSync(rec, bytes(5000, 1));
    const job = {
      version: 1,
      kind,
      created: "2026-11-28T00:00:00.000Z",
      name: kind === "reel" ? "old-reel" : "guest",
      episode: "guest",
      repo: { commit: "a".repeat(40) },
      tools: { ffmpeg: null, bun: null, uv: null },
      recording: pinRecording(rec, undefined, probe),
      files: files.map((f) => ({ ...f, bytes: 1, sha256: sha256(join(dir, f.path)) })),
      ...(kind === "reel" ? { clean: { width: 1280, height: 720, method: "none" } } : {}),
    };
    writeFileSync(join(dir, "job.json"), JSON.stringify(job));
    return rec;
  }

  it("still reads, preflights and renders as it did (a reel: no intro, its definition at the top)", () => {
    const dir = join(TMP, "v1-reel");
    const rec = v1Bundle(dir, "reel");
    const job = readJob(dir);
    expect(parts(job)).toEqual({ edit: false, noIntro: true, reels: [{ slug: "old-reel", def: "old-reel.reel.json", clean: { width: 1280, height: 720, method: "none" }, reference: undefined }] });
    const checks = preflight(dir, job, { recording: rec, probe, tools: job.tools, config: {} }).checks.filter((c) => !c.label.startsWith("code") && c.label !== "node packages");
    expect(formatReport(checks).text).toEndWith("REPRODUCIBLE");
    expect(baseStamp(job).intro).toBe(false);
  });

  it("an edit: the edit only", () => {
    const dir = join(TMP, "v1-edit");
    v1Bundle(dir, "edit");
    expect(parts(readJob(dir))).toMatchObject({ edit: true, noIntro: false, reels: [] });
  });
});

describe("the auto-bundle after a render", () => {
  it("writes the local bundle next to the outputs", async () => {
    const src = join(TMP, "auto");
    const { reel } = episode(src);
    const line = await autoBundle(reel, { checkCode: false, probe });
    expect(line).toBe(`Bundled for sharing (nothing sent yet): ${join(src, "guest.share")}`);
    expect(readJob(join(src, "guest.share")).reels!["guest-best-30"]).toBeDefined();
  });

  it("never throws: a failure is one line", async () => {
    const src = join(TMP, "auto-fail");
    const { reel } = episode(src);
    const dirty = join(TMP, "auto-repo");
    mkdirSync(dirty, { recursive: true });
    sh(dirty, "init", "-q", "-b", "main");
    writeFileSync(join(dirty, "a.ts"), "1\n");
    sh(dirty, "add", "a.ts");
    sh(dirty, "commit", "-q", "-m", "one");
    expect(await autoBundle(reel, { root: dirty, probe })).toStartWith("Not bundled for sharing: Can't share yet: this version of the code isn't backed up online");
    expect(await autoBundle(join(src, "missing.reel.json"), { checkCode: false, probe })).toStartWith("Not bundled for sharing:");
    unlinkSync(join(src, "broll.mp4"));
    const line = await autoBundle(reel, { checkCode: false, probe });
    expect(line).toStartWith("Not bundled for sharing: the edit inserts a clip that isn't on this computer");
    expect(line).not.toContain("\n");
  });

  it("doesn't nest a local bundle inside a received one", async () => {
    const shared = await buildBundle({ input: join(TMP, "auto", "guest.reel.json"), to: join(TMP, "auto-received"), checkCode: false, probe });
    writeFileSync(join(shared.dir, "guest.mp4"), bytes(5000, 1));
    mkdirSync(join(shared.dir, "rebuild"), { recursive: true });
    writeFileSync(join(shared.dir, "rebuild", "guest.clean.mp4"), bytes(100, 4));
    const line = await autoBundle(join(shared.dir, "reels", "guest-best-30.reel.json"), { checkCode: false, probe });
    expect(line).toContain("is a share bundle already");
    expect(existsSync(join(shared.dir, "guest.share"))).toBe(false);
  });

  it("allows a local bundle inside the repo only where git ignores it", () => {
    expect(checkOutsideRepo(join(ROOT, "out", "x", "guest.share"))).toBe(join(ROOT, "out", "x", "guest.share"));
    expect(() => checkOutsideRepo(join(ROOT, "docs", "guest"))).toThrow("inside the repo");
  });
});

describe("publishing a local bundle to the shared folder", () => {
  it("refuses with no shared folder set, saying what to set", async () => {
    const root = join(TMP, "no-config");
    mkdirSync(root, { recursive: true });
    await expect(publish({ source: join(TMP, "auto", "guest.share"), root, checkCode: false })).rejects.toThrow('Set "bundles" in share.local.json');
  });

  it("copies it in, keeps a teammate's reel that's only there, and refuses a tampered bundle", async () => {
    const src = join(TMP, "pub");
    const { reel } = episode(src);
    const shared = join(TMP, "dropbox");
    // a teammate already shared another reel of this episode there
    mkdirSync(join(src, "theirs"));
    const theirs = episodeReel(src, "their-reel", join(src, "theirs", "their.reel.json"), "../guest.decisions.json");
    renameSync(reel, `${reel}.aside`); // their computer doesn't have our reel
    const before = await buildBundle({ input: theirs, to: shared, probe, checkCode: false });
    renameSync(`${reel}.aside`, reel);
    expect(Object.keys(before.job.reels!)).toEqual(["their-reel"]);

    const out = await publish({ source: reel, to: shared, checkCode: false, probe });
    expect(out.dir).toBe(join(shared, "guest"));
    expect(out.notes).toEqual(["kept reel their-reel, which was only in the shared folder"]);
    expect(Object.keys(readJob(out.dir).reels!).sort()).toEqual(["guest-best-30", "their-reel"]);
    expect(existsSync(join(src, "guest.share", "job.json"))).toBe(true); // the local bundle stays
    const checks = preflight(out.dir, readJob(out.dir), { recording: join(src, "guest.mp4"), probe, config: {}, tools: out.job.tools }).checks;
    expect(checks.filter((c) => !c.ok && !c.warn && !c.label.startsWith("code") && c.label !== "node packages")).toEqual([]);

    writeFileSync(join(src, "guest.share", "reels", "guest-best-30.reel.json"), "{}");
    await expect(publish({ source: join(src, "guest.share"), to: shared, checkCode: false })).rejects.toThrow("changed or is missing");
  });
});

function sha256(file: string) {
  return new Bun.CryptoHasher("sha256").update(readFileSync(file)).digest("hex");
}

