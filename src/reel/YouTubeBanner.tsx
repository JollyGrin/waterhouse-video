import React from "react";
import { Easing, interpolate } from "remotion";
import { C, FONT_DISPLAY, FONT_MONO } from "../ident/brand";
import { FPS } from "./theme";

/**
 * REEL BANNER · YOUTUBE: a "full interview on YouTube" tag that sits over the whole clip, so the
 * call to action is on screen from the first word instead of only on the end bumper.
 *
 * A smoked-glass strip with YouTube's play button and paper type, under the channel bug and clear of
 * Instagram's top bar and right rail. It wipes on hard when the intro has gone, then holds still apart
 * from a short scope flicker every few seconds (Fuse's beam, briefly brighter) so it keeps catching
 * the eye without moving around. The YouTube end bumper still plays after the clip.
 * Opt-in per reel: `"banner": "youtube"` in the reel definition.
 */

/** Where the banner sits, in reel pixels. Top clears the bug (BUG in theme.ts); right edge clears the rail. */
export const BANNER = {
  top: 214,
  left: 72,
  /** Right edge stays left of Instagram's action rail (~120 px). */
  maxRight: 1080 - 132,
  /** Width of the play button. */
  tab: 116,
  height: 128,
  titleSize: 50,
  subSize: 25,
} as const;

/** YouTube's own red, for its play button only (not a house colour). */
const YT_RED = "#FF0000";

const T = {
  /** Frames of the wipe-on. */
  wipe: 9,
  /** A flicker every this many frames, once it is on. */
  flickerEvery: Math.round(3.5 * FPS),
  flickerLength: 6,
};

export type YouTubeBannerProps = {
  /** Frames since the banner came on (0 = the first clip frame after the intro). */
  frame: number;
  /** Big line. */
  title?: string;
  /** Small line under it. */
  sub?: string;
};

export const YOUTUBE_BANNER_DEFAULTS = {
  title: "FULL INTERVIEW",
  sub: "ON YOUTUBE · @WATERHOUSE_STUDIOS",
} as const;

export const YouTubeBanner: React.FC<YouTubeBannerProps> = ({
  frame,
  title = YOUTUBE_BANNER_DEFAULTS.title,
  sub = YOUTUBE_BANNER_DEFAULTS.sub,
}) => {
  if (frame < 0) return null;

  // Hard wipe from the tab outwards, like a fader thrown open.
  const wipe = interpolate(frame, [0, T.wipe], [0, 100], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.65, 0, 0.25, 1),
  });

  // Scope flicker: a quick bright pulse on the tab and the type, then back.
  const since = frame - T.wipe;
  const phase = since > 0 ? since % T.flickerEvery : T.flickerEvery;
  const flick =
    phase < T.flickerLength
      ? interpolate(phase, [0, 1, T.flickerLength], [0, 1, 0], {
          extrapolateRight: "clamp",
        })
      : 0;

  const iconGlow = `drop-shadow(0 0 ${10 + 24 * flick}px rgba(255, 0, 0, ${0.35 + 0.55 * flick}))`;

  return (
    <div
      style={{
        position: "absolute",
        top: BANNER.top,
        left: BANNER.left,
        maxWidth: BANNER.maxRight - BANNER.left,
        height: BANNER.height,
        display: "flex",
        alignItems: "stretch",
        clipPath: `inset(0 ${100 - wipe}% 0 0)`,
        filter: "drop-shadow(0 6px 18px rgba(0,0,0,0.55))",
      }}
    >
      {/* The strip: smoked glass over the picture, a YouTube play button, paper type. */}
      <div
        style={{
          background: "rgba(0, 0, 0, 0.74)",
          borderTop: `3px solid rgba(250, 246, 246, ${0.18 + 0.4 * flick})`,
          borderBottom: `3px solid rgba(250, 246, 246, ${0.18 + 0.4 * flick})`,
          padding: "0 30px 0 24px",
          display: "flex",
          alignItems: "center",
          gap: 24,
        }}
      >
        {/* YouTube's play button (red rounded rectangle, white triangle): the one accent. */}
        <svg
          width={BANNER.tab}
          height={BANNER.tab * 0.7}
          viewBox="0 0 100 70"
          style={{ filter: iconGlow, flexShrink: 0 }}
        >
          <rect x={0} y={0} width={100} height={70} rx={18} fill={YT_RED} />
          <path d="M40 20 L68 35 L40 50 Z" fill="#ffffff" />
        </svg>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            gap: 8,
            whiteSpace: "nowrap",
          }}
        >
          <div
            style={{
              fontFamily: FONT_DISPLAY,
              fontSize: BANNER.titleSize,
              lineHeight: 1,
              color: C.paper,
              letterSpacing: "0.01em",
              textShadow:
                flick > 0
                  ? `0 0 ${14 * flick}px rgba(205, 220, 255, ${0.9 * flick})`
                  : undefined,
            }}
          >
            {title}
          </div>
          <div
            style={{
              fontFamily: FONT_MONO,
              fontWeight: 700,
              fontSize: BANNER.subSize,
              lineHeight: 1,
              color: "#c9c6c0",
              letterSpacing: "0.16em",
            }}
          >
            {sub}
          </div>
        </div>
      </div>
    </div>
  );
};
