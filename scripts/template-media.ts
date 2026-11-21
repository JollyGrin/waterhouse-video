/**
 * Which files under public/ do the templates use, and are they in git? (#50)
 *
 * A teammate makes a template, Dean pulls, it renders: that only works when
 * the media a template needs is committed. This reads the source under src/
 * (no rendering) and finds every public/ path it can see:
 *
 *  - string literals that look like a path and end in a media extension
 *    ("ident/audio/x/Kick 01.wav"; a leading "/" or "./" is dropped). A bare
 *    file name ("cover.png") only counts as the argument of staticFile(), so a
 *    default file name elsewhere can't fail the check. Partial paths a helper
 *    completes count too (Press: sfx("recap/tick.wav"));
 *  - calls to one-argument-to-path helpers such as
 *    `const sfx = (name: string) => staticFile(\`audio/pullup/${name}.wav\`)`,
 *    resolved for every literal argument (sfx("click") → audio/pullup/click.wav);
 *  - template paths with a variable part (`.../mix-${semitones}.wav`, and each
 *    helper's own template): at least one tracked or private file must match,
 *    which catches a template whose whole folder was never committed. This is
 *    a weak check: a new sound added to a kit that already has tracked files
 *    passes even if it isn't committed, and so do calls to helpers written as
 *    `function sfx(...)` rather than an arrow `const`.
 *
 * Run it to see the list: `bun scripts/template-media.ts`.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { isPrivate, PRIVATE_MEDIA, type PrivateMedia } from "./private-media";

/**
 * The size rule: per file, and per folder (one template's media lives in its own
 * folder). The folder limit counts the files directly in it, not its subfolders.
 */
export const MAX_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_FOLDER_BYTES = 10 * 1024 * 1024;

export const MEDIA_EXT = /\.(wav|mp3|flac|ogg|m4a|aac|aiff?|mp4|mov|webm|mkv|png|jpe?g|gif|webp|svg)$/i;

export type SourceFile = { path: string; text: string };

export type MediaRef = {
  /** "src/ident/Fuse.tsx:787" */
  at: string;
  /** Path(s) under public/ this could be; the first is the one reported. */
  candidates: string[];
  /** Set for a template path with a variable part: any match will do. */
  pattern?: RegExp;
};

export type Problem = { at: string; path: string; message: string };

/** Blank out comments (keeping newlines, so line numbers hold) without touching strings. */
export function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (quote) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (c === quote || (c === "\n" && quote !== "`")) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length;

/**
 * The plain string literals in a piece of code ('x', "x", or `x` without ${}).
 * Quotes end at a line break, so an apostrophe in JSX text can't swallow the file.
 */
function literals(code: string): { value: string; index: number }[] {
  const found: { value: string; index: number }[] = [];
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < code.length && code[j] !== c && code[j] !== "\n") j += code[j] === "\\" ? 2 : 1;
      if (code[j] !== c) {
        i++; // unclosed at the line break: an apostrophe in text, not a string
        continue;
      }
      found.push({ value: code.slice(i + 1, j), index: i });
      i = j + 1;
    } else if (c === "`") {
      let j = i + 1;
      let plain = true;
      while (j < code.length && code[j] !== "`") {
        if (code[j] === "\\") j += 2;
        else if (code[j] === "$" && code[j + 1] === "{") {
          plain = false;
          let depth = 0;
          for (; j < code.length; j++) {
            if (code[j] === "{") depth++;
            else if (code[j] === "}" && --depth === 0) break;
          }
          j++;
        } else j++;
      }
      if (plain) found.push({ value: code.slice(i + 1, j), index: i });
      i = j + 1;
    } else i++;
  }
  return found;
}

/** Arguments of the call whose "(" is at `open`, split at top-level commas. */
function callArgs(code: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  let quote: string | null = null;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) {
      depth--;
      if (depth === 0) {
        args.push(code.slice(start, i));
        return args;
      }
    } else if (c === "," && depth === 1) {
      args.push(code.slice(start, i));
      start = i + 1;
    }
  }
  return args;
}

type Helper = { name: string; arg: number; prefix: string; suffix: string; exported: boolean };

/**
 * `const sfx = (a: string, b = 1) => ... staticFile(`prefix${a}suffix`)`: the
 * path is prefix + one argument + suffix.
 */
function findHelpers(code: string): Helper[] {
  const helpers: Helper[] = [];
  const re =
    /(export\s+)?const\s+(\w+)\s*=\s*\(([^)]*)\)[^=;]*=>[\s\S]{0,300}?staticFile\(\s*`(([^`$]*)\$\{\s*(\w+)\s*\}([^`$]*))`\s*\)/g;
  for (const m of code.matchAll(re)) {
    const params = m[3].split(",").map((p) => p.trim().split(/[\s:=?]/)[0]);
    const arg = params.indexOf(m[6]);
    if (arg === -1) continue;
    helpers.push({ name: m[2], arg, prefix: m[5], suffix: m[7], exported: Boolean(m[1]) });
  }
  return helpers;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "/audio/x.wav" and "./audio/x.wav" mean public/audio/x.wav to staticFile(). */
const normalise = (s: string) => s.replace(/^\.?\//, "");

/**
 * A string that looks like a path under public/: has a folder, ends in a media
 * extension, isn't a URL, a relative import ("../x.wav") or a "public/..." note.
 * Spaces are fine ("audio/neon/Kick 01.wav"). `bare` allows a file name without
 * a folder, for the argument of staticFile() itself.
 */
const looksLikePublicPath = (s: string, bare = false) =>
  MEDIA_EXT.test(s) &&
  (bare || s.includes("/")) &&
  /^[A-Za-z0-9_]/.test(s) &&
  !/^[a-z]+:/i.test(s) &&
  !/[\n\t]/.test(s) &&
  !s.startsWith("public/");

/** Every public/ path the source files use. */
export function findMediaRefs(files: SourceFile[]): MediaRef[] {
  const stripped = files.map((f) => ({ path: f.path, code: stripComments(f.text) }));
  const helpersByFile = new Map(stripped.map((f) => [f.path, findHelpers(f.code)]));
  const shared = [...helpersByFile.values()].flat().filter((h) => h.exported);
  const refs: MediaRef[] = [];

  for (const { path, code } of stripped) {
    const own = helpersByFile.get(path) ?? [];
    const inScope = [...own, ...shared.filter((h) => !own.some((o) => o.name === h.name))];
    const prefixes = [...new Set(own.map((h) => h.prefix))].filter(Boolean);
    const at = (index: number) => `${path}:${lineOf(code, index)}`;

    // Helper calls: sfx("click") → audio/pullup/click.wav.
    for (const h of inScope) {
      for (const m of code.matchAll(new RegExp(`(?<![\\w.])${h.name}\\s*\\(`, "g"))) {
        const open = (m.index ?? 0) + m[0].length - 1;
        if (/const\s+$/.test(code.slice(Math.max(0, (m.index ?? 0) - 20), m.index))) continue; // the definition
        const arg = callArgs(code, open)[h.arg];
        if (!arg) continue;
        for (const lit of literals(arg)) {
          // skip empties and the compared side of a condition (b.id === "house" ? "bumper/thump" : ...)
          if (!lit.value || /[=!]==?\s*$/.test(arg.slice(0, lit.index))) continue;
          const full = `${h.prefix}${lit.value}${h.suffix}`;
          if (MEDIA_EXT.test(full) && !MEDIA_EXT.test(lit.value)) refs.push({ at: at(open), candidates: [full] });
        }
      }
    }

    // Literal paths, completed by this file's helper prefixes when partial.
    for (const lit of literals(code)) {
      const before = code.slice(Math.max(0, lit.index - 30), lit.index);
      if (lit.value.startsWith("../") || /(\bfrom|\bimport\s*\(|\brequire\s*\()\s*$/.test(before)) continue; // an import
      const value = normalise(lit.value);
      const inStaticFile = /staticFile\(\s*$/.test(before);
      if (!looksLikePublicPath(value, inStaticFile)) continue;
      refs.push({ at: at(lit.index), candidates: [value, ...prefixes.map((p) => p + value)] });
    }

    // Template paths with a variable part, e.g. `ident/audio/fuselines/mix-${semitones}.wav`.
    for (const m of code.matchAll(/`([^`]*\$\{[^`]*)`/g)) {
      const body = m[1];
      if (!MEDIA_EXT.test(body) || !body.includes("/") || /^[a-z]+:/i.test(body)) continue;
      const head = body.slice(0, body.indexOf("${"));
      if (!/^[A-Za-z0-9_]/.test(head)) continue;
      const pattern = new RegExp(`^${body.split(/\$\{[^}]*\}/).map(escapeRe).join(".+")}$`);
      refs.push({ at: at(m.index ?? 0), candidates: [body], pattern });
    }
  }
  return refs;
}

/** Problems: media a template uses that a fresh clone won't have. */
export function checkRefs(refs: MediaRef[], tracked: Set<string>, list: PrivateMedia[] = PRIVATE_MEDIA): Problem[] {
  const problems: Problem[] = [];
  const trackedPublic = [...tracked].filter((f) => f.startsWith("public/")).map((f) => f.slice("public/".length));
  for (const ref of refs) {
    const ok = ref.pattern
      ? trackedPublic.some((f) => ref.pattern!.test(f)) ||
        list.some((m) => ref.pattern!.test(m.path) || (m.path.endsWith("/") && ref.candidates[0].startsWith(m.path)))
      : ref.candidates.some((c) => tracked.has(`public/${c}`) || isPrivate(c, list));
    if (!ok)
      problems.push({
        at: ref.at,
        path: `public/${ref.candidates[0]}`,
        message: "used by a template but not in git: commit it (if small and ours) or add it to scripts/private-media.ts",
      });
  }
  return problems;
}

/** Problems: tracked media over the size rule, or private media that got committed. */
export function checkTracked(sizes: Map<string, number>, list: PrivateMedia[] = PRIVATE_MEDIA): Problem[] {
  const problems: Problem[] = [];
  const folders = new Map<string, number>();
  for (const [file, bytes] of sizes) {
    if (!MEDIA_EXT.test(file)) continue;
    if (file.startsWith("public/") && isPrivate(file.slice("public/".length), list))
      problems.push({ at: file, path: file, message: "on the private list (scripts/private-media.ts) but tracked: `git rm --cached` it" });
    if (bytes > MAX_FILE_BYTES)
      problems.push({ at: file, path: file, message: `${mb(bytes)} is over the ${mb(MAX_FILE_BYTES)} per-file limit: shrink it` });
    const folder = file.slice(0, file.lastIndexOf("/") + 1);
    folders.set(folder, (folders.get(folder) ?? 0) + bytes);
  }
  for (const [folder, bytes] of folders)
    if (bytes > MAX_FOLDER_BYTES)
      problems.push({ at: folder, path: folder, message: `${mb(bytes)} of media is over the ${mb(MAX_FOLDER_BYTES)} per-folder limit (subfolders not counted)` });
  return problems;
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

// --- reading the repo --------------------------------------------------------

/** The repo's root (this file is in scripts/; `import.meta` is off limits under this tsconfig). */
export const ROOT = join(__dirname, "..");

/** Every .ts/.tsx under src/ except tests, tracked or not (a new template counts before it's committed). */
export function readSources(root = ROOT): SourceFile[] {
  const out: SourceFile[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
        out.push({ path: relative(root, full).replace(/\\/g, "/"), text: readFileSync(full, "utf8") });
    }
  };
  walk(join(root, "src"));
  return out;
}

/** Tracked files (repo-relative, forward slashes), or null outside a git checkout. */
export function trackedFiles(root = ROOT): string[] | null {
  const git = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (git.status !== 0) return null;
  return git.stdout.split("\0").filter(Boolean);
}

/** Sizes of tracked media files as they are on disk. */
export function trackedMediaSizes(tracked: string[], root = ROOT): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const f of tracked) {
    if (!MEDIA_EXT.test(f)) continue;
    try {
      sizes.set(f, statSync(join(root, f)).size);
    } catch {
      // deleted in the working tree but not yet in git: nothing to measure
    }
  }
  return sizes;
}

if (/template-media\.ts$/.test(process.argv[1] ?? "")) {
  const tracked = trackedFiles();
  if (!tracked) throw new Error("not a git checkout");
  const refs = findMediaRefs(readSources());
  const set = new Set(tracked);
  for (const r of refs) {
    const c = r.candidates.find((x) => set.has(`public/${x}`)) ?? r.candidates[0];
    const state = r.pattern ? "pattern" : set.has(`public/${c}`) ? "tracked" : isPrivate(c) ? "private" : "MISSING";
    console.log(`${state.padEnd(8)} public/${c}  (${r.at})`);
  }
  const problems = [...checkRefs(refs, set), ...checkTracked(trackedMediaSizes(tracked))];
  for (const p of problems) console.log(`\n✗ ${p.path}: ${p.message}  (${p.at})`);
  process.exit(problems.length ? 1 : 0);
}
