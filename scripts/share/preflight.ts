/**
 * Can this computer render exactly what was shared? (#60)
 *
 *   bun run preflight <bundle> [--recording <file>]
 *
 * Checks the pinned code, the raw recording (fingerprint, size, length, frame rate, frame
 * size), every file in the bundle (sha256) and the tool versions (a warning only). Ends
 * with REPRODUCIBLE, or NOT REPRODUCIBLE and the list of what's missing or different, and
 * then exits 1. Without --recording it looks for the file by name in the bundle, the
 * "recordings" folders in share.local.json, ~/Movies/waterhouse/in, Videos/sesh-in and
 * Downloads.
 */

import { resolve } from "node:path";
import { formatReport, parts, preflight, readJob } from "./job";

export function parseBundleArgs(argv: string[], usage: string) {
  const out: { bundle?: string; recording?: string; flags: Set<string>; only: string[] } = { flags: new Set(), only: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--recording") out.recording = argv[++i];
    else if (a === "--only") out.only.push(...(argv[++i] ?? "").split(",").filter(Boolean));
    else if (a.startsWith("--")) out.flags.add(a);
    else out.bundle = a;
  }
  if (!out.bundle) throw new Error(`usage: ${usage}`);
  return { ...out, bundle: resolve(out.bundle) };
}

/** Prints the report; true when reproducible. */
export function runPreflight(bundle: string, recording?: string) {
  const job = readJob(bundle);
  const p = parts(job);
  const what = [p.edit ? "the edit" : "", ...p.reels.map((r) => `reel ${r.slug}`)].filter(Boolean).join(", ");
  console.log(`Share "${job.episode}": ${what}${job.by ? `, by ${job.by}` : ""}, ${job.created.slice(0, 10)}\n`);
  const res = preflight(bundle, job, { recording });
  const report = formatReport(res.checks);
  console.log(report.text);
  return { job, recording: res.recording, reproducible: report.reproducible };
}

if (/preflight\.ts$/.test(process.argv[1] ?? "")) {
  try {
    const args = parseBundleArgs(process.argv.slice(2), "bun run preflight <bundle> [--recording <file>]");
    if (args.flags.size || args.only.length) throw new Error(`unknown option ${[...args.flags][0] ?? "--only"}`);
    if (!runPreflight(args.bundle, args.recording).reproducible) process.exit(1);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
