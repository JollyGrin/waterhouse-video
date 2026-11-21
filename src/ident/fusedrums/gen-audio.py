# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy==2.5.5"]  # pinned: a newer FFT could change the last bit of samples
# ///
# FUSE-DRUMS: Fuse's picture on its own drum track, synthesised here (no samples, nothing third-party),
# so it can be committed and published. Deterministic (fixed seed): re-running writes the same file.
#
#   uv run src/ident/fusedrums/gen-audio.py
#
# Writes public/ident/audio/fusedrums/mix.wav (48 kHz s16 stereo, 5.0 s), FUSE_DRUMS_AUDIO in Fuse.tsx.
#
# 120 bpm on Fuse's grid: beat = 15 f, and Fuse's beats fall on f10, 25, 40, 55, 70, 85, 100, 115, 130, 145
# (its scope kicks are f10/25/40, the lock f55). The track, in frames:
#   f0-55    the build, under a closed low-pass: a muffled kick on f10/25/40 with the picture's kicks,
#            a dusty 16th hat that creeps up, tape hiss and a little mains hum. The last beat pulls in:
#            a ghost-snare drag and a short noise riser that the hit cuts off.
#   f55      THE HIT, on Fuse's lock (1.833 s): a driven low kick (~45 Hz tail), a dry cracked snare,
#            a burst of tape noise, the filter thrown open. The loudest moment of the track.
#   f55-70   the record is caught dead in the picture: only the hit's tail and the hiss.
#   f70-107  the groove: kick on every beat, snare on f70/100, the hold kick on f85 a touch heavier,
#            offbeat open hats over the 16ths. Short, dry, saturated: club, not cinema.
#   f107-    Fuse's brake: the whole kit sinks under a closing low-pass while the hats thin out;
#   f115     one last low kick on the rings, a dub echo of the snare into the tail; 0.6 s fade to 5.0 s.
# Master: soft tanh saturation, then gain so the 4x-oversampled true peak sits at -2 dBTP
# (sesh-edit gains the intro to the speech's loudness and caps it at -1 dBTP; lossy previews stay under it too).
import os, wave
import numpy as np

SR = 48000
FPS = 30
DUR = 5.0  # = FUSE_FRAMES / FPS
N = int(DUR * SR)
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "..", "..", "public", "ident", "audio", "fusedrums", "mix.wav")
rng = np.random.default_rng(55)

# ---------------- timeline (frames; 120 bpm, beat = 15 f, 16th = 3.75 f) ----------------
BEAT = 15.0
S16 = BEAT / 4
KICKS_BUILD = [10, 25, 40]
HIT = 55  # Fuse's lock: LOCK_F in Fuse.tsx
GROOVE = (70, 107)  # kicks every beat in here
KICKS_GROOVE = [70, 85, 100]
HOLD = 85
SNARES = [70, 100]
BRAKE = 107
RINGS = 115
FADE_IN = 0.03  # s
TAIL = 0.6  # s: fade-out to the end
TP_TARGET = -2.0  # dBTP: the AAC in a preview mp4 overshoots ~0.8 dB, this keeps it under -1

ts = np.arange(N) / SR
fu = ts * FPS


# ---------------- helpers (as in the other idents' generators) ----------------
def onepole_lp(x, fc):
    fc = np.broadcast_to(np.asarray(fc, dtype=float), x.shape)
    a = 1 - np.exp(-2 * np.pi * np.minimum(fc, SR * 0.45) / SR)
    y = np.empty_like(x)
    s = 0.0
    for i in range(len(x)):
        s += a[i] * (x[i] - s)
        y[i] = s
    return y


def lp_fft(x, fc, order=2):
    X = np.fft.rfft(x)
    fq = np.fft.rfftfreq(len(x), 1 / SR)
    X *= 1 / np.sqrt(1 + (fq / fc) ** (2 * order))
    return np.fft.irfft(X, len(x))


def hp_fft(x, fc, order=2):
    X = np.fft.rfft(x)
    fq = np.fft.rfftfreq(len(x), 1 / SR)
    X *= 1 / np.sqrt(1 + (fc / np.maximum(fq, 1e-3)) ** (2 * order))
    return np.fft.irfft(X, len(x))


def bp_fft(x, lo, hi, order=2):
    return lp_fft(hp_fft(x, lo, order), hi, order)


def sm(a, b, x):
    s = np.clip((x - a) / (b - a), 0, 1)
    return s * s * (3 - 2 * s)


def place(buf, x, frame, gain=1.0):
    i0 = int(round(frame / FPS * SR))
    n = min(len(x), len(buf) - i0)
    if n > 0:
        buf[i0:i0 + n] += x[:n] * gain


def env_t(dur):
    return np.arange(int(dur * SR)) / SR


def kick(dur, f0, f1, sweep, decay, drive, click=0.3):
    t = env_t(dur)
    f = f1 + (f0 - f1) * np.exp(-t / sweep)
    ph = 2 * np.pi * np.cumsum(f) / SR
    body = np.sin(ph) * np.exp(-t / decay)
    body = np.tanh(body * drive) / np.tanh(drive)
    c = hp_fft(rng.standard_normal(len(t)) * np.exp(-t / 0.004), 2500) * click
    return (body + c) * np.minimum(1, t / 0.0015)


def snare(dur, tone=185.0, decay=0.11, snap=1.0, body=0.5):
    """Dry and cracked: a short pitched body under band-passed noise, driven."""
    t = env_t(dur)
    b = np.sin(2 * np.pi * np.cumsum(tone + 60 * np.exp(-t / 0.01)) / SR) * np.exp(-t / 0.05) * body
    n = bp_fft(rng.standard_normal(len(t)), 1200, 7500) * np.exp(-t / decay) * snap
    x = np.tanh((b + n) * 2.2) / np.tanh(2.2)
    return x * np.minimum(1, t / 0.0008)


def hat(dur, decay, fc=7500):
    t = env_t(dur)
    # metallic: a few inharmonic squares under the noise, like a cheap drum machine's hat
    m = sum(np.sign(np.sin(2 * np.pi * f * t)) for f in (317, 421, 538, 693, 811)) * 0.12
    x = hp_fft(rng.standard_normal(len(t)) + m, fc) * np.exp(-t / decay)
    return x * np.minimum(1, t / 0.0005)


# ---------------- the kit ----------------
drums = np.zeros(N)  # goes through the master filter
hiss = np.zeros(N)  # the tape bed, under its own envelope

# the build: muffled kicks with the picture's scope kicks
k_soft = kick(0.45, 140, 50, 0.03, 0.14, 1.8, click=0.15)
for f in KICKS_BUILD:
    place(drums, k_soft, f, 0.3 + 0.06 * KICKS_BUILD.index(f))

# 16th hats from f10, creeping up; none in the caught-dead gap after the hit
h_closed = hat(0.05, 0.012)
h_open = hat(0.26, 0.07, 6500)
f = 10.0
i = 0
while f < BRAKE + 6:
    in_build = f < HIT
    in_gap = HIT <= f < GROOVE[0] - 0.01
    if not in_gap:
        accent = 1.0 if i % 2 == 0 else 0.6
        if in_build:
            g = 0.10 + 0.25 * (f - 10) / (HIT - 10)
        else:
            g = 0.32 * (1 - sm(BRAKE, BRAKE + 6, f))
        jitter = (rng.random() - 0.5) * 0.12  # a few ms of slop, played not quantised
        if not in_build and i % 4 == 2:  # offbeat: open hat
            place(drums, h_open, f + jitter, g * 1.1)
        else:
            place(drums, h_closed, f + jitter, g * accent)
    f += S16
    i += 1

# the drag into the hit: ghost snares on the last beat's 32nds, swelling
for j, fg in enumerate(np.arange(HIT - BEAT / 2, HIT - 0.5, S16 / 2)):
    place(drums, snare(0.08, decay=0.03, body=0.2), fg, 0.06 + 0.05 * j)

# a short noise riser through a rising band, cut dead by the hit
rd = (HIT - (HIT - BEAT)) / FPS
tr = env_t(rd)
riser = rng.standard_normal(len(tr))
riser = onepole_lp(riser, 400 + 6000 * (tr / rd) ** 2) * (tr / rd) ** 2.5
riser = riser - onepole_lp(riser, 300)
place(drums, riser, HIT - BEAT, 0.35)

# THE HIT on f55
k_hit = kick(1.1, 150, 45, 0.04, 0.32, 3.6, click=0.45)
tk = env_t(1.1)
k_hit = k_hit + lp_fft(rng.standard_normal(len(tk)), 900) * np.exp(-tk / 0.12) * 0.25
s_hit = snare(0.5, tone=170, decay=0.16, snap=1.3, body=0.7)
burst_t = env_t(0.35)
burst = bp_fft(rng.standard_normal(len(burst_t)), 300, 9000) * np.exp(-burst_t / 0.06) * 0.5
place(drums, k_hit, HIT, 1.0)
place(drums, s_hit, HIT, 0.75)
place(drums, burst, HIT, 1.0)

# the groove
k_main = kick(0.55, 145, 48, 0.032, 0.17, 2.6, click=0.3)
k_hold = kick(0.8, 145, 46, 0.036, 0.24, 3.0, click=0.35)
for f in KICKS_GROOVE:
    place(drums, k_hold if f == HOLD else k_main, f, 0.72 if f == HOLD else 0.62)
s_main = snare(0.3, decay=0.09, snap=1.0)
for f in SNARES:
    place(drums, s_main, f, 0.5)

# the rings: a last low kick, the snare's dub echo into the tail
k_end = kick(1.2, 110, 40, 0.05, 0.35, 2.0, click=0.08)
place(drums, k_end, RINGS, 0.7)
s_dub = lp_fft(snare(0.3, decay=0.1, snap=0.9), 2500)
for j in range(6):
    place(drums, s_dub, RINGS + 7.5 * j, 0.32 * 0.55 ** j)

# ---------------- master filter: closed in the build, thrown open on the hit, sinking at the brake ----
cut_build = 700 + 1800 * sm(10, HIT, fu) ** 2
cut = np.where(fu < HIT, cut_build, 16000.0)
cut = np.where(fu >= BRAKE, 16000.0 * (1 - sm(BRAKE, RINGS + 6, fu)) + 900 * sm(BRAKE, RINGS + 6, fu), cut)
drums = onepole_lp(onepole_lp(drums, cut), cut * 1.2)

# the tape bed: hiss, a few crackles, quiet mains hum
h = hp_fft(rng.standard_normal(N), 2500) * 0.02 + lp_fft(rng.standard_normal(N), 250) * 0.03
for _ in range(int(DUR * 18)):
    j = int(rng.random() * (N - 200))
    w = int(2 + rng.random() * 14)
    h[j:j + w] += rng.standard_normal(w) * np.hanning(w) * ((rng.random() ** 3) * 0.25 + 0.02)
hum = sum(a * np.sin(2 * np.pi * 50 * k * ts) for k, a in [(1, 1), (2, 0.5), (3, 0.3), (5, 0.1)])
h += np.tanh(hum * 1.5) * 0.012
hiss = h * (0.6 + 0.4 * sm(HIT - 2, HIT + 1, fu))

# ---------------- stereo, master ----------------
# drums near mono; the hats and the hiss get a little width from a few ms of offset
d = int(0.0007 * SR)
L = drums + hiss
R = np.concatenate([np.zeros(d), drums[:-d]]) * 0.15 + drums * 0.85 + np.roll(hiss, int(0.011 * SR))
S = np.stack([L, R], 1)
S = np.tanh(S / np.max(np.abs(S)) * 1.6) / np.tanh(1.6)  # glue and grit

fi, fo = int(FADE_IN * SR), int(TAIL * SR)
S[:fi] *= np.linspace(0, 1, fi)[:, None]
S[-fo:] *= (np.linspace(1, 0, fo) ** 2)[:, None]


def true_peak(x):
    """4x-oversampled peak (FFT interpolation), like a dBTP meter."""
    n = len(x)
    X = np.fft.rfft(x, axis=0)
    up = np.fft.irfft(np.concatenate([X, np.zeros((3 * n // 2, x.shape[1]))]), 4 * n, axis=0) * 4
    return np.max(np.abs(up))


S = S * (10 ** (TP_TARGET / 20) / true_peak(S))
q = np.round(S * 32767).astype("<i2")

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with wave.open(OUT, "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(q.tobytes())

# ---------------- report ----------------
x = q.astype(float) / 32767
mono = np.abs(x).max(1)
pk = int(np.argmax(mono))
spf = SR // FPS
lv = [20 * np.log10(np.sqrt(np.mean(x[k * spf:(k + 1) * spf] ** 2)) + 1e-9) for k in range(int(DUR * FPS))]
loudest = int(np.argmax(lv))
print(f"wrote {os.path.normpath(OUT)}: {DUR:.1f} s, {SR} Hz s16 stereo")
print(f"sample peak at {pk / SR:.4f} s = f{pk / SR * FPS:.2f} (hit placed at f{HIT} = {HIT / FPS:.4f} s)")
print(f"loudest frame f{loudest}; true peak {20 * np.log10(true_peak(x)):.2f} dBTP; rms {20 * np.log10(np.sqrt(np.mean(x ** 2))):.1f} dBFS")
print("rms dB per 5 frames:", " ".join("%d" % round(np.mean(lv[k:k + 5])) for k in range(0, len(lv), 5)))
