/**
 * The auto-bundle (#62): after a reel or an edit renders, write or refresh the episode's
 * local share bundle next to its outputs (<name>.share/), nothing shared yet.
 *
 *   bun scripts/share/auto.ts <name>.reel.json | <name>.decisions.json [--recording <file>]
 *
 * Called by `bun run reel` and by sesh-edit after a render (both skip it with --no-share).
 * It uses the same code and checks as `bun run share --local`, prints exactly one line,
 * and never fails the render: unsaved or unpushed code, a missing file, anything, is that
 * one line saying why there's no bundle. It always exits 0.
 */

import { buildBundle, type ShareOptions } from "./share";

/** The one line to print. Never throws. */
export async function autoBundle(input: string, opts: Omit<ShareOptions, "input" | "local" | "quiet"> = {}): Promise<string> {
  try {
    const { dir, notes } = await buildBundle({ ...opts, input, local: true, quiet: true });
    return `Bundled for sharing (nothing sent yet): ${dir}${notes.length ? ` (${notes.join("; ")})` : ""}`;
  } catch (err) {
    const why = (err instanceof Error ? err.message : String(err)).split("\n")[0];
    return `Not bundled for sharing: ${why}`;
  }
}

if (/auto\.ts$/.test(process.argv[1] ?? "")) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--recording");
  const recording = i >= 0 ? argv[i + 1] : undefined;
  const input = argv.find((a, k) => !a.startsWith("--") && argv[k - 1] !== "--recording");
  (input ? autoBundle(input, { recording }) : Promise.resolve("Not bundled for sharing: no reel or decisions file given"))
    .then((line) => console.log(line))
    .catch(() => console.log("Not bundled for sharing: unexpected error"))
    .finally(() => process.exit(0));
}
