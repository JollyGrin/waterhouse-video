/**
 * How the handle is set in the YouTube outro, as plain data so it can be tested without React.
 *
 * Rubik Mono One (the display face in src/ident/brand.ts) is monospaced, unicase and 0.85 em per glyph,
 * so the width of a line is exact: 0.85 × characters × size. The column is 840 px (x 120–960), the same
 * width as Fuse's title and clear of Instagram's right-hand rail, and the type never goes over 96 px
 * (Fuse's title size). A long handle that would drop under 64 px on one line breaks after the separator
 * nearest its middle ("@WATERHOUSE_" / "STUDIOS") so it stays big enough to read on a phone.
 */
export const COLUMN = 840;
export const ADVANCE = 0.85;
export const CAP = 0.7;
export const MAX_SIZE = 96;
export const ONE_LINE_MIN = 64;

export type HandleLayout = { lines: string[]; size: number };

const fit = (chars: number) => Math.min(MAX_SIZE, Math.floor(COLUMN / (ADVANCE * chars)));

export const layoutHandle = (handle: string): HandleLayout => {
  const text = handle.trim().toUpperCase();
  if (!text) return { lines: [], size: MAX_SIZE };
  const one = fit(text.length);
  if (one >= ONE_LINE_MIN) return { lines: [text], size: one };
  const seps = [...text].map((c, i) => (/[_.-]/.test(c) ? i : -1)).filter((i) => i > 0 && i < text.length - 1);
  if (!seps.length) return { lines: [text], size: Math.max(40, one) };
  const mid = text.length / 2;
  const at = seps.reduce((best, i) => (Math.abs(i + 1 - mid) < Math.abs(best + 1 - mid) ? i : best));
  const lines = [text.slice(0, at + 1), text.slice(at + 1)];
  return { lines, size: fit(Math.max(...lines.map((l) => l.length))) };
};

/** Width of a line of the display face at `size`. */
export const lineWidth = (text: string, size: number) => text.length * ADVANCE * size;
