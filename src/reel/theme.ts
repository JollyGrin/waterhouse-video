/**
 * Vertical promo reel cut out of a finished session episode.
 *
 * The episode is a locked-off wide two-shot, so a centre crop of the whole frame often
 * lands on the empty floor between the two chairs. A reel therefore punches in on
 * whoever is talking and cuts between them, which is also what makes it read as an
 * edit rather than a clipped-out lump of podcast. The crop windows are per episode
 * and live in each reel definition (`shots`, see crop.ts), not here.
 */

export const FPS = 30;
export const WIDTH = 1080;
export const HEIGHT = 1920;

/**
 * A slow push over each segment. The camera never moves in the source, and on a
 * vertical crop of a static wide shot that stillness reads as a freeze-frame after a
 * few seconds. 4% over the segment is enough to feel alive and small enough that it
 * never looks like a zoom.
 */
export const PUSH = 1.04;

/**
 * Captions sit clear of Instagram's own furniture: the caption/CTA block eats roughly
 * the bottom 420px of the frame and the action rail the right ~120px. Anything below
 * y1500 is liable to be covered on someone's phone.
 */
export const CAPTIONS = {
  fontSize: 60,
  fontWeight: 800,
  lineHeight: 1.22,
  /** Vertical centre of the caption block. */
  centreY: 1330,
  /** Widest a line may run before it wraps. */
  maxWidth: 880,
  /** Lines per page; a third line pushes into Instagram's UI. */
  maxLines: 2,
  activeBackground: "#2b9bf4",
  upcomingOpacity: 0.5,
  wordGap: 14,
  boxPaddingX: 12,
  boxPaddingY: 5,
  boxRadius: 7,
};

/** The channel bug, top-left, clear of Instagram's top furniture. */
export const BUG = { top: 96, left: 72, width: 132, opacity: 0.9 };

/** Seconds of end card after the last frame of picture. */
export const END_CARD_SECONDS = 1.6;
