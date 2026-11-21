import React from "react";
import { AbsoluteFill, Audio, Easing, interpolate, interpolateColors, staticFile, useCurrentFrame } from "remotion";
import { C, FONT_DISPLAY, FONT_MONO, rand } from "../../ident/brand";
import { Grain } from "../../ident/common";
import { CAP, layoutHandle } from "./layout";

/**
 * REEL OUTRO · YOUTUBE: the end of a Sessions reel, 1080×1920. Fuse's scope, switched off.
 *
 * Every reel opens on Fuse: a dot, a flat line, the beam. This closes the loop the other way round.
 *
 *   f0–8     SIGNAL. Hard cut from the picture to the scope glass (graticule, readouts, scanlines). The
 *            trace still carries the last of the clip's signal and goes flat.
 *   f8–20    OPEN. The flat line opens into type, the way a tube comes on: the beam's energy leaves the line
 *            and the handle stands there as a traced outline, phosphor-bright.
 *   f20      LOCK, on the hit: a snap (1.08 → 1) and the camera's kick, like Fuse's lock on the mark.
 *   f20–90   PRINT. The outline gives way to the print (paper on black, as Fuse's beam gives way to the label);
 *            the line types in above it as a readout, the yellow rule and the guest's name land below.
 *            Nothing else moves but grain, scanlines and the glow's flicker.
 *   f90–113  OFF. The readouts die; the type collapses back into the line, bright; the line shrinks to a dot;
 *            the dot goes. Black at f113, so a looping reel cuts cleanly back to frame 1 of its clip.
 *
 * Sound: public/audio/reel-outro/youtube-tail.wav (src/reel/outro/gen-audio.py; the hit is from "hu", the
 * rest synthesised; true peak −1.5 dBTP).
 */
export const YOUTUBE_OUTRO_FRAMES = 114;
export const YOUTUBE_OUTRO_AUDIO = "audio/reel-outro/youtube-tail.wav";
export const YOUTUBE_OUTRO_DEFAULTS = { handle: "@Waterhouse_Studios", line: "Full interview on YouTube" } as const;

export type YouTubeOutroProps = {
  /** The channel handle, set big. Upper-cased and, if long, broken after its separator. */
  handle: string;
  /** The line above it ("Full interview on YouTube"). */
  line: string;
  /** The guest; shows as "WITH <ARTIST>" under the rule. Empty (the default) hides the line; the reel pipeline passes it. */
  artist?: string;
  /** Gain on its sound; the reel pipeline sets it so the tail lands at its designed level after mastering (#55). */
  volume?: number;
};

// ---- timeline (frames) ----
const T = {
  open: [8, 20] as const,
  lock: 20,
  print: [22, 34] as const, // the paper fill comes in
  beamOut: [24, 48] as const, // the traced outline fades off the print
  type: [22, 36] as const, // the line types in
  rule: 30,
  artist: 34,
  off: 90,
  collapse: [90, 100] as const,
  line: [100, 107] as const,
  dot: [107, 113] as const,
};

// ---- layout ----
const W = 1080;
const H = 1920;
const CX = 540;
const LY = 930; // the scope's centre line: the type opens out of it and collapses back into it
const GRAT = { x0: 60, y0: LY - 5 * 120, div: 120, cols: 8, rows: 10 };
const TRACE_HALF = (GRAT.cols * GRAT.div) / 2;
const RO = { l: 72, r: W - 72, t1: 96, t2: 134, b: 1420 };
const LINE_ADVANCE = 1.12;
const MONO = { size: 30, spacing: 10, color: "#a3a19b" };

// ---- the beam, Fuse's colours ----
const CORE = "#f7faff";
const GLOW = "#cddcff";
const HALO = "#7f9fe6";

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const heavy = Easing.bezier(0.65, 0, 0.25, 1);
const easeIO = Easing.bezier(0.65, 0, 0.35, 1);
const decay = (t: number, tau: number) => (t < 0 ? 0 : Math.exp(-t / tau));
type Pt = [number, number];
const pathOf = (pts: Pt[]) => (pts.length ? "M" + pts.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join("L") : "");

/** The trace at frame f: the clip's last signal dying into a flat line, then (f ≥ T.line) the line shrinking to the dot. */
const trace = (f: number): Pt[] => {
  const half = f < T.line[0] ? TRACE_HALF : interpolate(f, T.line, [TRACE_HALF, 0], { ...clamp, easing: Easing.in(Easing.cubic) });
  if (half < 1) return [];
  const amp = 44 * decay(f, 3.2);
  const n = 200;
  const pts: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    const sig = 0.6 * Math.sin(2 * Math.PI * (u * 6.5 + f * 0.31)) + 0.4 * Math.sin(2 * Math.PI * (u * 15 - f * 0.53)) + (rand(i * 1.37 + f * 97.1) - 0.5) * 0.7;
    const hum = 1.4 * Math.sin(2 * Math.PI * u * 12 + f * 0.7) + (rand(i * 2.11 + f * 13.7) - 0.5) * 1.2;
    pts.push([CX - half + 2 * half * u, LY - (amp * sig + hum)]);
  }
  return pts;
};

const Beam: React.FC<{ f: number; gain: number }> = ({ f, gain }) => {
  const now = pathOf(trace(f));
  const trails = f < 16 ? [1, 2, 3, 4].filter((k) => f - k >= 0).map((k) => ({ k, a: [0, 0.42, 0.22, 0.11, 0.05][k], d: pathOf(trace(f - k)) })) : [];
  const g = gain * (0.95 + rand(f * 2.3) * 0.05);
  if (!now || g <= 0.001) return null;
  return (
    <g fill="none" strokeLinecap="round" strokeLinejoin="round">
      <path d={now} filter="url(#yo-halo)" stroke={HALO} strokeWidth={14} opacity={Math.min(1, 0.5 * g)} />
      {trails.map(({ k, a, d }) => (
        <path key={k} d={d} stroke={GLOW} strokeWidth={3} opacity={a * Math.min(1, g)} />
      ))}
      <path d={now} filter="url(#yo-glow)" stroke={GLOW} strokeWidth={7} opacity={Math.min(1, 0.88 * g)} />
      <path d={now} stroke={CORE} strokeWidth={2.8} opacity={Math.min(1, g)} />
    </g>
  );
};

const Graticule: React.FC = () => {
  const { x0, y0, div, cols, rows } = GRAT;
  const x1 = x0 + cols * div;
  const lines: React.ReactNode[] = [];
  for (let i = 0; i <= cols; i++) lines.push(<line key={`v${i}`} x1={x0 + i * div} y1={y0} x2={x0 + i * div} y2={y0 + rows * div} />);
  for (let j = 0; j <= rows; j++) lines.push(<line key={`h${j}`} x1={x0} y1={y0 + j * div} x2={x1} y2={y0 + j * div} />);
  const tick = div / 5;
  for (let t = 0; t <= cols * 5; t++) lines.push(<line key={`tx${t}`} x1={x0 + t * tick} y1={LY - 7} x2={x0 + t * tick} y2={LY + 7} />);
  for (let t = 0; t <= rows * 5; t++) lines.push(<line key={`ty${t}`} x1={CX - 7} y1={y0 + t * tick} x2={CX + 7} y2={y0 + t * tick} />);
  return (
    <svg width={W} height={H} style={{ position: "absolute", inset: 0 }}>
      <g stroke="rgb(190,205,235)" strokeOpacity={0.06} strokeWidth={1.5}>
        {lines}
      </g>
    </svg>
  );
};

const READOUT = "rgba(200,210,230,0.5)";
const Readout: React.FC<{ x: number; y: number; align?: "left" | "right"; children: React.ReactNode }> = ({ x, y, align = "left", children }) => (
  <div
    style={{
      position: "absolute",
      top: y,
      ...(align === "left" ? { left: x } : { right: W - x }),
      display: "flex",
      alignItems: "center",
      gap: 12,
      fontFamily: FONT_MONO,
      fontWeight: 500,
      fontSize: 24,
      letterSpacing: "0.18em",
      color: READOUT,
      whiteSpace: "pre",
    }}
  >
    {children}
  </div>
);

/** The scope's glass: black, graticule, readouts, scanlines, vignette. The readouts die at OFF; the glass itself fades after. */
const Glass: React.FC<{ f: number }> = ({ f }) => {
  const glass = 1 - interpolate(f, [T.off + 6, T.off + 16], [0, 1], { ...clamp, easing: easeIO });
  const ui = f < T.off;
  const trig = [T.lock, T.off].some((k) => f - k >= 0 && f - k < 4);
  const mode = f < T.lock ? "Y–T   50ms/DIV" : "Y–T   END · SIDE A";
  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ backgroundColor: "#000" }} />
      <AbsoluteFill style={{ opacity: glass, background: "radial-gradient(ellipse 85% 60% at 50% 48%, #0e1116 0%, #07080b 55%, #020203 100%)" }} />
      <AbsoluteFill style={{ opacity: glass }}>
        <Graticule />
      </AbsoluteFill>
      {ui ? (
        <>
          <Readout x={RO.l} y={RO.t1}>
            {mode}
          </Readout>
          <Readout x={RO.r} y={RO.t1} align="right">
            <svg width={11} height={14} viewBox="0 0 11 14" style={{ display: "block" }}>
              <path d="M0 0 L11 7 L0 14 Z" fill={READOUT} />
            </svg>
            {"YOUTUBE"}
          </Readout>
          <Readout x={RO.l} y={RO.t2}>
            <span style={{ color: trig ? "rgba(240,245,255,0.95)" : "rgba(200,210,230,0.35)" }}>TRIG'D</span>
            {"   CH1·L  CH2·R"}
          </Readout>
          <Readout x={RO.l} y={RO.b}>
            {"WATERHOUSE STUDIOS"}
          </Readout>
          <Readout x={RO.r} y={RO.b} align="right">
            {"AMS"}
          </Readout>
        </>
      ) : null}
      <AbsoluteFill
        style={{
          opacity: 0.5 * glass,
          background: "repeating-linear-gradient(0deg, rgba(0,0,0,0.35) 0px, rgba(0,0,0,0.35) 1px, transparent 1px, transparent 3px)",
        }}
      />
      <Grain opacity={0.07 * glass} blend="screen" />
      <AbsoluteFill
        style={{
          opacity: glass,
          background:
            "linear-gradient(118deg, transparent 18%, rgba(255,255,255,0.025) 30%, transparent 44%), radial-gradient(ellipse 120% 90% at 50% 48%, transparent 55%, rgba(0,0,0,0.65) 100%)",
        }}
      />
    </AbsoluteFill>
  );
};

export const YouTubeOutro: React.FC<Partial<YouTubeOutroProps>> = ({ handle = YOUTUBE_OUTRO_DEFAULTS.handle, line = YOUTUBE_OUTRO_DEFAULTS.line, artist, volume = 1 }) => {
  const f = useCurrentFrame();
  const audio = <Audio src={staticFile(YOUTUBE_OUTRO_AUDIO)} volume={volume} />;
  if (f >= T.dot[1]) return <AbsoluteFill style={{ backgroundColor: "#000" }}>{audio}</AbsoluteFill>;

  // the handle block, centred on the scope's line
  const { lines, size } = layoutHandle(handle);
  const cap = CAP * size;
  const advance = LINE_ADVANCE * size;
  const firstBase = LY + cap / 2 - ((lines.length - 1) * advance) / 2;
  const bases = lines.map((_, i) => firstBase + i * advance);
  const eyebrowBase = firstBase - cap - 56;
  const ruleY = (bases[bases.length - 1] ?? LY) + 54;
  const artistBase = ruleY + 5 + 58;

  // open: a flat line unsquashes into type; collapse: the type squashes back into it
  const open = f < T.lock ? interpolate(f, T.open, [0, 1], { ...clamp, easing: heavy }) : 1;
  const col = interpolate(f, T.collapse, [0, 1], { ...clamp, easing: Easing.in(Easing.quad) });
  const sy = Math.max(0.004, open * (1 - col));
  const lockS = 1 + 0.08 * decay(f - T.lock, 3.5);
  // the camera's kick on the lock (Fuse)
  const tk = f - T.lock;
  const dy = tk >= 0 && tk <= 8 ? 7 * Math.exp(-tk / 2) * (tk === 0 ? 1 : Math.cos(tk * 1.7) * 0.6) : 0;

  // the outline glow: on through the open, a flash on the lock, off the print by beamOut; back as it collapses
  const gIn = f < T.open[0] ? 0 : f < T.lock ? 1 : (1 + 0.6 * decay(f - T.lock, 4)) * interpolate(f, T.beamOut, [1, 0], { ...clamp, easing: easeIO });
  const gOut = f >= T.off ? interpolate(col, [0, 1], [0.25, 1.6]) : 0;
  const gText = Math.max(gIn, gOut) * (0.95 + rand(f * 2.3) * 0.05);
  // the print
  const printO = interpolate(f, T.print, [0, 1], { ...clamp, easing: easeIO });
  const fill = col > 0 ? interpolateColors(col, [0, 1], [C.paper, CORE]) : C.paper;
  // the trace: the signal, bright as the line opens, gone under the print, back to take the type at OFF
  const gTrace =
    f < T.open[0]
      ? 1
      : f < T.lock
        ? interpolate(f, [T.open[0], T.open[0] + 2, T.open[1] - 2], [1, 1.7, 0], clamp)
        : f < T.off
          ? 0
          : f < T.line[0]
            ? interpolate(f, [T.off + 4, T.line[0]], [0, 1.7], { ...clamp, easing: Easing.in(Easing.quad) })
            : interpolate(f, T.line, [1.7, 2.2], clamp);
  // the dot, the last of it
  const dotT = f - T.dot[0];
  const dotO = dotT >= 0 ? Math.exp(-dotT / 1.6) : 0;

  const typed = line.toUpperCase();
  const shown = typed.slice(0, Math.floor(interpolate(f, T.type, [0, typed.length + 1], clamp)));
  const typedW = typed.length * (0.6 * MONO.size + MONO.spacing) - MONO.spacing;
  const blockOn = f >= T.open[0] && f < T.line[0];
  const extras = f >= T.lock && f < T.off;

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {audio}
      <Glass f={f} />
      <svg width={W} height={H} style={{ position: "absolute", inset: 0, overflow: "visible", transform: dy ? `translateY(${dy}px)` : undefined }}>
        <defs>
          <filter id="yo-halo" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation={20} />
          </filter>
          <filter id="yo-glow" x="-10%" y="-10%" width="120%" height="120%">
            <feGaussianBlur stdDeviation={4.5} />
          </filter>
          <filter id="yo-dot">
            <feGaussianBlur stdDeviation={10} />
          </filter>
        </defs>

        {blockOn ? (
          <g transform={`translate(${CX} ${LY}) scale(${lockS} ${lockS * sy}) translate(${-CX} ${-LY})`}>
            {extras && shown ? (
              <text x={CX - typedW / 2} y={eyebrowBase} fontFamily={FONT_MONO} fontWeight={500} fontSize={MONO.size} letterSpacing={MONO.spacing} fill={MONO.color}>
                {shown}
              </text>
            ) : null}
            <g fontFamily={FONT_DISPLAY} fontSize={size} textAnchor="middle">
              {printO > 0.001 ? (
                <g fill={fill} opacity={printO}>
                  {lines.map((l, i) => (
                    <text key={i} x={CX} y={bases[i]}>
                      {l}
                    </text>
                  ))}
                </g>
              ) : null}
              {gText > 0.01 ? (
                <g fill="none" strokeLinejoin="round">
                  <g filter="url(#yo-halo)" stroke={HALO} strokeWidth={12} opacity={Math.min(1, 0.4 * gText)}>
                    {lines.map((l, i) => (
                      <text key={i} x={CX} y={bases[i]}>
                        {l}
                      </text>
                    ))}
                  </g>
                  <g filter="url(#yo-glow)" stroke={GLOW} strokeWidth={5} opacity={Math.min(1, 0.8 * gText)}>
                    {lines.map((l, i) => (
                      <text key={i} x={CX} y={bases[i]}>
                        {l}
                      </text>
                    ))}
                  </g>
                  <g stroke={CORE} strokeWidth={2.4} opacity={Math.min(1, gText)}>
                    {lines.map((l, i) => (
                      <text key={i} x={CX} y={bases[i]}>
                        {l}
                      </text>
                    ))}
                  </g>
                </g>
              ) : null}
            </g>
            {extras && f >= T.rule ? <rect x={CX - 64} y={ruleY} width={128} height={5} fill={C.yellow} /> : null}
            {extras && artist?.trim() && f >= T.artist ? (
              <text x={CX} y={artistBase} textAnchor="middle" fontFamily={FONT_MONO} fontWeight={500} fontSize={MONO.size} letterSpacing={MONO.spacing} fill={MONO.color}>
                {`WITH ${artist.toUpperCase()}`}
              </text>
            ) : null}
          </g>
        ) : null}

        <Beam f={f} gain={gTrace} />

        {dotO > 0.01 ? (
          <g opacity={dotO}>
            <circle cx={CX} cy={LY} r={interpolate(dotT, [0, 6], [22, 10], clamp)} fill={GLOW} opacity={0.8} filter="url(#yo-dot)" />
            <circle cx={CX} cy={LY} r={5} fill="#fff" />
          </g>
        ) : null}
      </svg>
    </AbsoluteFill>
  );
};
