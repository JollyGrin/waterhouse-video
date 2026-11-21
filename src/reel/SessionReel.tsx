import React from "react";
import {
  AbsoluteFill,
  OffthreadVideo,
  Sequence,
  staticFile,
  interpolate,
  useCurrentFrame,
  Easing,
} from "remotion";
import type { CaptionWord } from "../session/Captions";
import { WhMark, MARK_ASPECT } from "../session/WhMark";
import { FUSE_FRAMES, FuseDrums } from "../ident/Fuse";
import { YouTubeOutro, YOUTUBE_OUTRO_DEFAULTS, YOUTUBE_OUTRO_FRAMES } from "./outro/YouTubeOutro";
import { ReelCaptions } from "./ReelCaptions";
import type { Crop, SourceSize } from "./crop";
import { BUG, END_CARD_SECONDS, FPS, HEIGHT, PUSH, WIDTH } from "./theme";

export type ReelSegment = {
  /** First frame of this segment on the clip's own timeline (0 = first frame of the clip). */
  fromFrame: number;
  durationInFrames: number;
  /** Window into the source, in source pixels, 9:16. */
  crop: Crop;
};

/** "fuse-drums": Fuse-Drums 9:16 in front, the clip opening under its tail. */
export type ReelIntro = "fuse-drums" | "none";
/**
 * "youtube": the YouTube end bumper (ReelOutro-YouTube, #54: "Full interview on
 * YouTube", @Waterhouse_Studios, "WITH <ARTIST>"). "card": the old end card (mark,
 * artist, CTA), kept as a fallback.
 */
export type ReelOutro = "youtube" | "card" | "none";

export type SessionReelProps = {
  /** The concatenated cut, relative to public/ (reel/<slug>-cut.mp4): still 16:9, still the full two-shot. */
  cutFile: string;
  /** Pixel size of the cut, which the crops are measured in. */
  source: SourceSize;
  segments: ReelSegment[];
  /** Word timings rebased onto the clip's timeline (0 = first frame of the clip). */
  captions: CaptionWord[];
  /** Frames of clip. */
  pictureFrames: number;
  intro: ReelIntro;
  /** Gain on the intro's soundtrack so it sits at the clip's loudness (make-reel measures it). */
  introGainDb: number;
  outro: ReelOutro;
  /** Gain on the YouTube bumper's sound (make-reel sets it; see outroGainDb there). */
  outroGainDb?: number;
  /** The guest, in capitals: the bumper's "WITH" line and the old card's name. */
  artist: string;
  episodeLabel: string;
  cta: string;
};

/**
 * Fuse frame where the rings start to open onto the interview: the clip starts playing
 * underneath here, as sesh-edit does with the 16:9 intro (scripts/render-intro.ts).
 */
export const INTRO_OPEN_FRAME = 118;

export const END_CARD_FRAMES = Math.round(END_CARD_SECONDS * FPS);

/** Where things sit on the reel's timeline, in frames. */
export const reelTiming = (p: Pick<SessionReelProps, "intro" | "outro" | "pictureFrames">) => {
  const clipFrom = p.intro === "fuse-drums" ? INTRO_OPEN_FRAME : 0;
  const introEnd = p.intro === "fuse-drums" ? FUSE_FRAMES : 0;
  const outroFrom = clipFrom + p.pictureFrames;
  const outroFrames = p.outro === "youtube" ? YOUTUBE_OUTRO_FRAMES : p.outro === "card" ? END_CARD_FRAMES : 0;
  return { clipFrom, introEnd, outroFrom, total: Math.max(introEnd, outroFrom + outroFrames) };
};

/**
 * The crop for a given clip frame: which window into the source is on screen, and how
 * far through its push it is. Segments are contiguous and cover the whole clip, so the
 * fallback only matters on the very last frame.
 */
const frameCrop = (frame: number, segments: ReelSegment[], source: SourceSize) => {
  const segment =
    segments.find(
      (s) => frame >= s.fromFrame && frame < s.fromFrame + s.durationInFrames,
    ) ?? segments[segments.length - 1];

  const shot = segment.crop;
  const progress = interpolate(
    frame,
    [segment.fromFrame, segment.fromFrame + segment.durationInFrames],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  // Scale so the crop window exactly fills the canvas, then push in a little.
  const scale = (WIDTH / shot.width) * interpolate(progress, [0, 1], [1, PUSH]);

  // Put the centre of the crop window at the centre of the canvas.
  const centreX = shot.x + shot.width / 2;
  const centreY = shot.y + shot.height / 2;

  return {
    width: source.width * scale,
    height: source.height * scale,
    left: WIDTH / 2 - centreX * scale,
    top: HEIGHT / 2 - centreY * scale,
  };
};

const EndCard: React.FC<{
  artist: string;
  episodeLabel: string;
  cta: string;
}> = ({ artist, episodeLabel, cta }) => {
  const localFrame = useCurrentFrame();
  const appear = interpolate(localFrame, [0, 10], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.quad),
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: "black",
        alignItems: "center",
        justifyContent: "center",
        gap: 56,
        opacity: appear,
        fontFamily: "Inter, system-ui, sans-serif",
        color: "white",
        textAlign: "center",
      }}
    >
      <div style={{ width: 420, height: 420 / MARK_ASPECT }}>
        <WhMark />
      </div>
      <div>
        <div
          style={{
            fontSize: 34,
            fontWeight: 700,
            letterSpacing: "0.22em",
            opacity: 0.75,
          }}
        >
          {episodeLabel}
        </div>
        <div style={{ fontSize: 96, fontWeight: 800, letterSpacing: "0.02em" }}>
          {artist}
        </div>
      </div>
      <div
        style={{
          fontSize: 30,
          fontWeight: 700,
          letterSpacing: "0.2em",
          opacity: 0.6,
        }}
      >
        {cta}
      </div>
    </AbsoluteFill>
  );
};

/** The clip: cropped picture, caption floor, captions and the channel bug. */
const Clip: React.FC<
  Pick<SessionReelProps, "cutFile" | "source" | "segments" | "captions" | "pictureFrames"> & {
    /** Clip frames still under the intro: captions and bug wait until it has gone. */
    holdFrames: number;
  }
> = ({ cutFile, source, segments, captions, pictureFrames, holdFrames }) => {
  const frame = useCurrentFrame();
  const crop = frameCrop(Math.min(frame, pictureFrames - 1), segments, source);
  const overlays = frame >= holdFrames;

  return (
    <AbsoluteFill>
      {/* One video element for the whole clip: the cuts are changes of crop, not of
          source, so seeking per segment would only add hitches. */}
      <AbsoluteFill style={{ overflow: "hidden" }}>
        <OffthreadVideo
          src={staticFile(cutFile)}
          style={{
            position: "absolute",
            width: crop.width,
            height: crop.height,
            left: crop.left,
            top: crop.top,
            maxWidth: "none",
          }}
          volume={(f) =>
            interpolate(f, [pictureFrames - 12, pictureFrames], [1, 0], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            })
          }
        />
      </AbsoluteFill>

      {/* A soft floor under the captions so white type never lands on a pale
          wall or a bare leg and disappears. */}
      <AbsoluteFill
        style={{
          background:
            "linear-gradient(to bottom, rgba(0,0,0,0) 52%, rgba(0,0,0,0.55) 68%, rgba(0,0,0,0.75) 100%)",
        }}
      />

      {overlays ? (
        <>
          <ReelCaptions words={captions} />
          <div
            style={{
              position: "absolute",
              top: BUG.top,
              left: BUG.left,
              width: BUG.width,
              height: BUG.width / MARK_ASPECT,
              opacity: BUG.opacity,
              filter: "drop-shadow(0 2px 10px rgba(0,0,0,0.6))",
            }}
          >
            <WhMark />
          </div>
        </>
      ) : null}
    </AbsoluteFill>
  );
};

export const SessionReel: React.FC<SessionReelProps> = (props) => {
  const { clipFrom, introEnd, outroFrom } = reelTiming(props);

  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      <Sequence from={clipFrom} durationInFrames={props.pictureFrames} name="Clip">
        <Clip {...props} holdFrames={introEnd - clipFrom} />
      </Sequence>

      {/* Over the clip: its rings open onto the interview from INTRO_OPEN_FRAME. */}
      {props.intro === "fuse-drums" ? (
        <Sequence durationInFrames={FUSE_FRAMES} name="Fuse-Drums">
          <FuseDrums volume={10 ** (props.introGainDb / 20)} />
        </Sequence>
      ) : null}

      {props.outro === "youtube" ? (
        <Sequence from={outroFrom} durationInFrames={YOUTUBE_OUTRO_FRAMES} name="YouTube outro">
          <YouTubeOutro
            handle={YOUTUBE_OUTRO_DEFAULTS.handle}
            line={YOUTUBE_OUTRO_DEFAULTS.line}
            artist={props.artist.toUpperCase()}
            volume={10 ** ((props.outroGainDb ?? 0) / 20)}
          />
        </Sequence>
      ) : null}

      {props.outro === "card" ? (
        <Sequence from={outroFrom} durationInFrames={END_CARD_FRAMES} name="End card">
          <EndCard artist={props.artist} episodeLabel={props.episodeLabel} cta={props.cta} />
        </Sequence>
      ) : null}
    </AbsoluteFill>
  );
};
