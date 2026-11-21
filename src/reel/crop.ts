/**
 * Crop windows into a reel's source, in source pixels (#55).
 *
 * The crops used to be hard-coded per old episode in theme.ts. Each reel definition now
 * names its own (`shots`), measured on stills of its own episode
 * (`bun scripts/reel/stills.ts`), and a span with no shot gets the centre crop.
 */

export type Crop = { x: number; y: number; width: number; height: number };
export type SourceSize = { width: number; height: number };

/** The name a span can use without defining it: the full-height 9:16 window in the middle. */
export const CENTRE = "centre";

/** Width / height of a reel frame; every crop has this shape so it fills the canvas exactly. */
export const REEL_ASPECT = 9 / 16;

export const centreCrop = (src: SourceSize): Crop => {
  const width = Math.round(src.height * REEL_ASPECT);
  return { x: Math.round((src.width - width) / 2), y: 0, width, height: src.height };
};

/**
 * Problems with a crop, as sentences (empty when it is fine): it must be 9:16 (within
 * half a percent), sit inside the source, and stay above `floorY` (a burned-in ticker,
 * for example).
 */
export function cropProblems(name: string, c: Crop, src: SourceSize, floorY = src.height): string[] {
  const out: string[] = [];
  const ratio = c.height / c.width;
  if (Math.abs(ratio - 1 / REEL_ASPECT) > 0.005 * (1 / REEL_ASPECT)) {
    out.push(`shot ${name} is ${c.width}x${c.height} (${ratio.toFixed(3)}:1), not 9:16 (1.778:1)`);
  }
  if (c.x < 0 || c.y < 0 || c.x + c.width > src.width || c.y + c.height > src.height) {
    out.push(`shot ${name} runs outside the ${src.width}x${src.height} source`);
  }
  if (c.y + c.height > floorY) {
    out.push(`shot ${name} reaches source row ${c.y + c.height}, below floorY ${floorY}`);
  }
  return out;
}
