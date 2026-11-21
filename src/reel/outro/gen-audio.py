# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy"]
# ///
# REEL OUTRO · YOUTUBE: the sound under src/reel/outro/YouTubeOutro.tsx
#   -> public/audio/reel-outro/youtube-tail.wav (44.1 kHz mono s16, 3.8 s = YOUTUBE_OUTRO_FRAMES / 30)
#
# Everything in it is ours. The one drum hit is cut from "hu" (public/ident/audio/fusedrums/mix.wav, made
# for Waterhouse by Denzo's brother: the Fuse-Drums intro), the rest is synthesised here. Re-make it with
#
#   uv run src/reel/outro/gen-audio.py
#
# Timeline (frames at 30 fps; the same constants as the picture):
#   f0-8     the scope is still on under the dying trace: mains hum, a little static
#   f8-20    the flat line opens into the type: the static swells into it
#   f20      LOCK: the hit from "hu" (onset 1.189 s in mix.wav, the one hit in the quiet bar before the big
#            kick, so it comes out clean), with a short sub under it for weight
#   f20-90   hold: hum, sparse vinyl crackle, the run-out tick once a turn (1.8 s at 33 1/3)
#   f90      OFF: the thump of a set switched off; the hum cuts, the static dies
#   f100-107 the line shrinks to a dot: a thin pip that falls and goes
#   f113     silence, so the reel loops cleanly back into picture
#
# Level: it prints its true peak (4x oversampled); the target is about -1.5 dBTP, ceiling -1 (sesh-edit's).
import os, wave
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..", "..", "..")
HIT_SRC = os.path.join(ROOT, "public", "ident", "audio", "fusedrums", "mix.wav")
OUT = os.path.join(ROOT, "public", "audio", "reel-outro", "youtube-tail.wav")

FPS = 30
FRAMES = 114
SR = 44100  # the source of the hit is 44.1 kHz: keep it, no resampling
DUR = FRAMES / FPS
n = int(DUR * SR)
t = np.arange(n) / SR
rng = np.random.default_rng(54)

LOCK, OFF, LINE, DOT, BLACK = 20, 90, 100, 107, 113  # frames
HIT_ONSET = 1.1888  # s into mix.wav
HIT_LEN = 0.635  # to just before the big kick at 1.824 s


def at(f):
    return int(f / FPS * SR)


def lp(x, fc, order=2):
    X = np.fft.rfft(x)
    fq = np.fft.rfftfreq(len(x), 1 / SR)
    X *= 1 / np.sqrt(1 + (fq / fc) ** (2 * order))
    return np.fft.irfft(X, len(x))


def hp(x, fc, order=2):
    X = np.fft.rfft(x)
    fq = np.fft.rfftfreq(len(x), 1 / SR)
    X *= 1 / np.sqrt(1 + (fc / np.maximum(fq, 1e-3)) ** (2 * order))
    return np.fft.irfft(X, len(x))


def env(a, b, x, power=1.0):
    """0 before a, 1 after b, smooth between."""
    s = np.clip((x - a) / (b - a), 0, 1) ** power
    return s * s * (3 - 2 * s)


def place(buf, x, sec, gain=1.0):
    i = int(sec * SR)
    m = min(len(x), len(buf) - i)
    if m > 0:
        buf[i:i + m] += x[:m] * gain


out = np.zeros(n)

# ---- the hit, from "hu" ----
with wave.open(HIT_SRC) as w:
    assert w.getframerate() == SR and w.getsampwidth() == 2, "mix.wav is expected 44.1 kHz 16-bit"
    w.setpos(int((HIT_ONSET - 0.003) * SR))
    raw = w.readframes(int(HIT_LEN * SR))
hit = np.frombuffer(raw, "<i2").reshape(-1, w.getnchannels()).mean(1) / 32768.0
hit = hit.copy()
hit[: int(0.002 * SR)] *= np.linspace(0, 1, int(0.002 * SR))
fo = int(0.3 * SR)
hit[-fo:] *= np.linspace(1, 0, fo) ** 2
hit /= np.abs(hit).max()
# a short sub under it (the lock in Fuse is a kick; "hu"'s hit here is a mid hit, so give it the floor)
ts = np.arange(int(0.35 * SR)) / SR
fsub = 44 + (120 - 44) * np.exp(-ts / 0.03)
sub = np.sin(2 * np.pi * np.cumsum(fsub) / SR) * np.exp(-ts / 0.11) * np.minimum(1, ts / 0.002)
lock_s = LOCK / FPS
place(out, hit, lock_s - 0.003, 0.74)
place(out, sub, lock_s, 0.42)

# ---- mains hum: the scope is on until OFF ----
hum = (np.sin(2 * np.pi * 50 * t) + 0.45 * np.sin(2 * np.pi * 100 * t + 0.6) + 0.18 * np.sin(2 * np.pi * 150 * t + 1.1))
hum *= 1 + 0.08 * np.sin(2 * np.pi * 0.9 * t)  # a slow breathe
hum_env = env(0, 0.02, t) * (1 - env(OFF / FPS, OFF / FPS + 0.008, t))
out += hum * hum_env * 0.012  # about -40 dBFS

# ---- static: swells into the open, dies after OFF ----
static = hp(lp(rng.standard_normal(n), 6000), 900)
st_env = 0.15 * env(0, 0.05, t) * (1 - env(LOCK / FPS - 0.02, LOCK / FPS, t))  # a floor under the dying trace
st_env += env(8 / FPS, LOCK / FPS, t, power=2.2) * (1 - env(LOCK / FPS, LOCK / FPS + 0.015, t))  # the swell, cut on the hit
st_env += 0.9 * env(OFF / FPS, OFF / FPS + 0.004, t) * np.exp(-np.maximum(t - OFF / FPS, 0) / 0.09)  # the burst as it goes off
out += static * st_env * 0.045

# ---- vinyl crackle through the hold, sparse ----
crackle = np.zeros(n)
for _ in range(int(7 * (OFF - LOCK) / FPS)):
    sec = rng.uniform(LOCK / FPS + 0.08, OFF / FPS - 0.02)
    k = np.arange(int(0.004 * SR)) / SR
    click = rng.standard_normal(len(k)) * np.exp(-k / 0.0007)
    place(crackle, click, sec, rng.uniform(0.2, 1.0) ** 2)
out += lp(crackle, 5000) * 0.05


# ---- the run-out tick, once a turn (1.8 s), a little thump with a click on it ----
def tick():
    k = np.arange(int(0.08 * SR)) / SR
    body = np.sin(2 * np.pi * (140 + 60 * np.exp(-k / 0.01)) * k) * np.exp(-k / 0.018)
    c = hp(rng.standard_normal(len(k)) * np.exp(-k / 0.0012), 1800)
    return (body + 0.5 * c) * np.minimum(1, k / 0.0008)


for sec in [LOCK / FPS + 0.6, LOCK / FPS + 0.6 + 1.8]:  # 1.27 s and 3.07 s; the second lands just after OFF, as the set dies
    if sec < OFF / FPS + 0.1:
        place(out, tick(), sec, 0.08)

# ---- OFF: the thump of the set switched off ----
to = np.arange(int(0.3 * SR)) / SR
fth = 36 + (110 - 36) * np.exp(-to / 0.04)
thump = np.tanh(2.2 * np.sin(2 * np.pi * np.cumsum(fth) / SR) * np.exp(-to / 0.085)) / np.tanh(2.2)
thump *= np.minimum(1, to / 0.0015)
place(out, thump, OFF / FPS, 0.3)
# the hum's own cut: a tiny click, then nothing
place(out, hp(np.exp(-np.arange(int(0.01 * SR)) / SR / 0.0005) * rng.standard_normal(int(0.01 * SR)), 2500), OFF / FPS, 0.03)

# ---- the dot: a pip that falls as the line shrinks, gone with the dot ----
tp = np.arange(int((DOT - LINE) / FPS * SR + 0.12 * SR)) / SR
fpip = 300 + (1900 - 300) * np.exp(-tp / 0.09)
pip = np.sin(2 * np.pi * np.cumsum(fpip) / SR) * np.exp(-tp / 0.07) * np.minimum(1, tp / 0.004)
place(out, pip, LINE / FPS, 0.035)
# the last of the phosphor: a dying breath of static, then true silence before BLACK
tail = np.arange(int((BLACK - DOT) / FPS * SR)) / SR
place(out, lp(rng.standard_normal(len(tail)), 2500) * np.exp(-tail / 0.04), DOT / FPS, 0.01)
out[at(BLACK) - int(0.01 * SR):] *= np.linspace(1, 0, n - at(BLACK) + int(0.01 * SR)) ** 2
out[at(BLACK):] = 0

# ---- gentle ceiling, then level ----
out = np.tanh(out * 1.1) / np.tanh(1.1)
up = np.fft.irfft(np.fft.rfft(out), 4 * n) * 4  # 4x oversampled for the true peak
tp_db = 20 * np.log10(np.abs(up).max() + 1e-9)
target = -1.5
out *= 10 ** ((target - tp_db) / 20)
up = np.fft.irfft(np.fft.rfft(out), 4 * n) * 4
rms_db = 20 * np.log10(np.sqrt((out ** 2).mean()) + 1e-9)

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with wave.open(OUT, "wb") as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(np.round(np.clip(out, -1, 1) * 32767).astype("<i2").tobytes())
print(f"wrote {os.path.normpath(OUT)}: {DUR:.2f} s mono {SR} Hz, true peak {20 * np.log10(np.abs(up).max()):.2f} dBTP, rms {rms_db:.1f} dBFS, "
      f"{os.path.getsize(OUT) / 1024:.0f} KB")
