# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy"]
# ///
# FUSE-DRUMS: Fuse's picture on a 5 s cut of a drum track instead of its own soundtrack.
#
#   uv run src/ident/fusedrums/gen-audio.py <song.wav> [--start 62.407]
#
# Writes public/audio/fuse-drums/mix.wav (gitignored: the track is not ours to publish, so share the
# song itself privately, never through the repo). The cut starts at --start seconds into the song;
# the default puts the track's big hit at 64.24 s on Fuse's lock (f55 = 1.833 s). 30 ms fade-in,
# 0.6 s fade-out at the end. Reads 16/24/32-bit PCM WAV, writes 16-bit at the song's sample rate.
import os, sys, wave
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "..", "..", "public", "audio", "fuse-drums", "mix.wav")
DUR = 5.0  # = FUSE_FRAMES / 30

args = sys.argv[1:]
if not args or args[0].startswith("-"):
    sys.exit("usage: uv run src/ident/fusedrums/gen-audio.py <song.wav> [--start SECONDS]")
song = args[0]
start = float(args[args.index("--start") + 1]) if "--start" in args else 62.407

with wave.open(song) as w:
    sr, ch, sw = w.getframerate(), w.getnchannels(), w.getsampwidth()
    w.setpos(int(start * sr))
    raw = w.readframes(int(DUR * sr))
if sw == 3:
    b = np.frombuffer(raw, np.uint8).reshape(-1, 3)
    x = (b[:, 0].astype(np.int32) | (b[:, 1].astype(np.int32) << 8) | (b[:, 2].astype(np.int32) << 16))
    x = np.where(x >= 1 << 23, x - (1 << 24), x) / float(1 << 23)
elif sw in (2, 4):
    x = np.frombuffer(raw, np.int16 if sw == 2 else np.int32) / float(1 << (8 * sw - 1))
else:
    sys.exit(f"{song}: {8 * sw}-bit WAV not supported, export 16 or 24-bit PCM")
x = x.reshape(-1, ch)
if ch == 1:
    x = np.repeat(x, 2, axis=1)
x = x[:, :2].copy()
if len(x) < int(DUR * sr) - 1:
    sys.exit(f"{song}: shorter than {start + DUR:.1f} s, pick an earlier --start")

fi, fo = int(0.03 * sr), int(0.6 * sr)
x[:fi] *= np.linspace(0, 1, fi)[:, None]
x[-fo:] *= (np.linspace(1, 0, fo) ** 2)[:, None]

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with wave.open(OUT, "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(sr)
    w.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())
print(f"wrote {os.path.normpath(OUT)}: {start:.3f}-{start + DUR:.3f} s of {os.path.basename(song)}")
