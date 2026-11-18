import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";

// The repo is public. sesh-batch manifests hold Dropbox share links (anyone with
// a link can download the recording), and its status files, review lists,
// captions and decisions name or quote private interviews (#47). None of it
// belongs in git; this guard catches it if `.gitignore` is bypassed.

const PRIVATE = [
  /(^|\/)batch[^/]*\.json$/i, // batch.json, batch-week47.json
  /\.batch\.json$/i,
  /\.status\.json$/i,
  /\.decisions\.json$/i,
  /\.review\.txt$/i,
  /\.srt$/i,
  /\.part$/i,
  /\.work\//i,
];

// A real share link: rlkey= followed by the long random key (placeholders like
// `rlkey=<key>` or test fakes like `rlkey=fakekey` don't match).
const SHARE_LINK = /dropbox\.com\/[^\s"'`)]*rlkey=[A-Za-z0-9]{15,}/i;
const GIT_SHARE_LINK = "dropbox\\.com/[^[:space:]\"'`)]*rlkey=[A-Za-z0-9]{15,}"; // the same, for git grep -E

function privateFiles(files: string[]): string[] {
  return files.filter((f) => PRIVATE.some((rx) => rx.test(f)));
}

function git(args: string[]) {
  return spawnSync("git", args, { encoding: "utf8" });
}

describe("no private batch material in git", () => {
  it("flags manifests, status files, transcripts and work folders", () => {
    expect(
      privateFiles([
        "longform/batch.json",
        "week47.batch.json",
        "longform/week47.batch.status.json",
        "oscar.decisions.json",
        "out/oscar.review.txt",
        "oscar.edited.srt",
        "oscar.part",
        "longform/oscar.work/transcript.json",
        "package.json",
        "longform/src/sesh_edit/batch.py",
        "longform/tests/test_batch.py",
        "src/ident/ids.ts",
      ]),
    ).toEqual([
      "longform/batch.json",
      "week47.batch.json",
      "longform/week47.batch.status.json",
      "oscar.decisions.json",
      "out/oscar.review.txt",
      "oscar.edited.srt",
      "oscar.part",
      "longform/oscar.work/transcript.json",
    ]);
  });

  it("tells a real share link from a placeholder", () => {
    expect(SHARE_LINK.test("https://www.dropbox.com/scl/fi/<id>/<name>.mp4?rlkey=<key>&dl=1")).toBe(false);
    expect(SHARE_LINK.test("https://www.dropbox.com/scl/fi/abc/x.mp4?rlkey=fakekey&dl=0")).toBe(false);
    // built at runtime, so this file doesn't trip the tracked-files check below
    const fake = "https://www.dropbox.com/scl/fi/a1b2/x.mp4?rlkey=" + "k3j4h5g6f7d8s9a0q1w2e3r4t" + "&dl=0";
    expect(SHARE_LINK.test(fake)).toBe(true);
  });

  it("finds none tracked in this repo", () => {
    const ls = git(["ls-files", "-z", "--full-name", "--", ":/"]);
    if (ls.status !== 0) return; // not a git checkout: nothing to guard
    // If this fails: `git rm --cached <file>`; keep manifests outside the repo.
    expect(privateFiles(ls.stdout.split("\0").filter(Boolean))).toEqual([]);
  });

  it("finds no Dropbox share links in tracked files", () => {
    const grep = git(["grep", "-I", "-l", "-E", GIT_SHARE_LINK, "--", ":/"]);
    if (grep.status === 128) return; // not a git checkout
    // git grep exits 1 when nothing matches. If this fails: remove the link and expire it in Dropbox.
    expect(grep.stdout.split("\n").filter(Boolean)).toEqual([]);
  });
});
