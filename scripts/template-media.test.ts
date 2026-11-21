import { describe, expect, it } from "bun:test";
import { PRIVATE_MEDIA } from "./private-media";
import {
  checkRefs,
  checkTracked,
  findMediaRefs,
  MAX_FILE_BYTES,
  readSources,
  stripComments,
  trackedFiles,
  trackedMediaSizes,
} from "./template-media";

// A teammate makes a template, Dean pulls, it renders (#50). That breaks when
// the media a template uses is gitignored (as Fuse-Drums' mix.wav was), so:
// every public/ file a template uses is tracked or on the private list
// (scripts/private-media.ts), and tracked media stays small.

const paths = (files: Record<string, string>) =>
  findMediaRefs(Object.entries(files).map(([path, text]) => ({ path, text }))).map((r) => r.candidates[0]);

const problems = (files: Record<string, string>, tracked: string[]) =>
  checkRefs(
    findMediaRefs(Object.entries(files).map(([path, text]) => ({ path, text }))),
    new Set(tracked),
  ).map((p) => p.path);

describe("findMediaRefs", () => {
  it("finds literal paths, but not URLs, imports, comments or bare extensions", () => {
    expect(
      paths({
        "src/A.tsx": [
          `const A = "ident/audio/a/mix.wav";`,
          `const url = "https://cdn.example.com/x.png";`,
          `import b from "./b.wav";`,
          `// "ident/audio/old/mix.wav"`,
          `const out = name.replace(".webm", "-matte.mp4");`,
          `const t = <p>Don't use "audio/private/x.mp3" here</p>;`,
        ].join("\n"),
      }),
    ).toEqual(["ident/audio/a/mix.wav", "audio/private/x.mp3"]);
  });

  it("resolves helper calls, including exported helpers used in other files", () => {
    const refs = paths({
      "src/shared.ts": "export const kit = (name: string) =>\n  staticFile(`audio/kit/${name}.wav`);",
      "src/B.tsx": [
        "const sfx = (key: string, f: number, file: string) => (",
        "  <Audio src={staticFile(`audio/${file}.wav`)} />",
        ");",
        `sfx("a", 1, b.id === "house" ? "recap/slam" : "bumper/thump");`,
        `<Audio src={kit("click")} />`,
      ].join("\n"),
    });
    expect(refs).toContain("audio/recap/slam.wav");
    expect(refs).toContain("audio/bumper/thump.wav");
    expect(refs).toContain("audio/kit/click.wav");
    expect(refs).not.toContain("audio/house.wav");
  });

  it("finds paths with spaces and a leading / or ./", () => {
    expect(
      paths({
        "src/N.tsx": [
          `staticFile("audio/neon/Kick 01.wav");`,
          `staticFile("/audio/neon/snare.wav");`,
          `staticFile("./audio/neon/hat.wav");`,
          `import tick from "./sounds/tick.wav";`,
        ].join("\n"),
      }),
    ).toEqual(["audio/neon/Kick 01.wav", "audio/neon/snare.wav", "audio/neon/hat.wav"]);
  });

  it("only counts a bare file name as the argument of staticFile()", () => {
    expect(
      paths({
        "src/P.tsx": `const defaults = { fileName: "cover.png" };\n<Img src={staticFile("logo.svg")} />`,
      }),
    ).toEqual(["logo.svg"]);
  });

  it("strips comments without touching strings that contain //", () => {
    expect(stripComments(`a = "x//y"; // gone\nb`)).toBe(`a = "x//y";        \nb`);
  });
});

describe("checkRefs", () => {
  it("flags a template's media that is on disk but not in git (the case that hit Fuse-Drums)", () => {
    const fuse = {
      "src/ident/Fuse.tsx": `export const DRUMS_AUDIO = "audio/drums/mix.wav";\nconst A = "ident/audio/splice/mix.wav";`,
    };
    expect(problems(fuse, ["public/ident/audio/splice/mix.wav"])).toEqual(["public/audio/drums/mix.wav"]);
    expect(problems(fuse, ["public/ident/audio/splice/mix.wav", "public/audio/drums/mix.wav"])).toEqual([]);
  });

  it("accepts a partial path a helper completes", () => {
    const press = {
      "src/ident/Press.tsx": "const sfx = (name: string) => staticFile(`audio/${name}`);\n<Sfx src=\"recap/tick.wav\" />",
    };
    expect(problems(press, ["public/audio/recap/tick.wav"])).toEqual([]);
    expect(problems(press, [])).toEqual(["public/recap/tick.wav"]);
  });

  it("needs at least one tracked match for a path with a variable part", () => {
    const lines = { "src/I.tsx": "make(`ident/audio/lines/mix-${semitones}.wav`);" };
    expect(problems(lines, [])).toEqual(["public/ident/audio/lines/mix-${semitones}.wav"]);
    expect(problems(lines, ["public/ident/audio/lines/mix-4.wav"])).toEqual([]);
  });

  it("lets private media through, and only that", () => {
    const files = { "src/R.tsx": `staticFile("session/head.mp4"); staticFile("session2/head.mp4");` };
    expect(problems(files, [])).toEqual(["public/session2/head.mp4"]);
  });
});

describe("checkTracked", () => {
  it("flags oversized files and folders, and committed private media", () => {
    const sizes = new Map([
      ["public/ident/audio/a/mix.wav", 1_000_000],
      ["public/ident/audio/b/song.wav", MAX_FILE_BYTES + 1],
      ...Array.from({ length: 4 }, (_, i) => [`public/audio/c/${i}.wav`, 3_000_000] as [string, number]),
      ["public/audio/private/track.mp3", 500_000],
      ["src/ident/notes.md", 99_000_000],
    ]);
    expect(checkTracked(sizes).map((p) => p.path)).toEqual([
      "public/ident/audio/b/song.wav",
      "public/audio/private/track.mp3",
      "public/audio/c/",
    ]);
  });
});

describe("this repo", () => {
  const tracked = trackedFiles();

  it("has every public/ file a template uses in git or on the private list", () => {
    if (!tracked) return; // not a git checkout (e.g. a tarball): nothing to guard
    // If this fails: commit the file (small and ours), or add it to scripts/private-media.ts
    // with where it comes from. Third-party music only ever goes on the private list.
    expect(checkRefs(findMediaRefs(readSources()), new Set(tracked))).toEqual([]);
  });

  it("keeps tracked media under the size rule, and no private media in git", () => {
    if (!tracked) return;
    // If this fails: shrink the file (cut it to what the template uses, mono, web-sized),
    // or `git rm --cached` it if it is private.
    expect(checkTracked(trackedMediaSizes(tracked))).toEqual([]);
  });

  it("says where every private file comes from", () => {
    for (const m of PRIVATE_MEDIA) {
      expect(m.why.length).toBeGreaterThan(10);
      expect(m.from.length).toBeGreaterThan(10);
    }
  });
});
