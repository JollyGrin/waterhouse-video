# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy"]
# ///
# FUSE-DRUMS: Fuse's picture on a 5 s cut of a drum track.
# Source: "hu", made for Waterhouse by Denzo's brother, used with permission.
#
# The committed public/ident/audio/fusedrums/mix.wav is the source of truth: the full song is not in the
# repo, so this script is only needed to re-cut it from the song (Denzo has it). It is how that file was made:
#
#   uv run src/ident/fusedrums/gen-audio.py <song.wav> [--start 62.407]   # cut, fades, gain
#   uv run src/ident/fusedrums/gen-audio.py --clip <cut.wav>              # gain only, on an existing 5 s cut
#
# The cut starts at --start seconds into the song; the default puts the track's big hit at 64.24 s on
# Fuse's lock (f55 = 1.833 s). 30 ms fade-in, 0.6 s fade-out at the end. Then a fixed GAIN_DB so the
# true peak stays under -1 dBTP (sesh-edit's ceiling; the raw cut peaks at +0.08 dBTP). The committed
# file is Denzo's cut (sha256 b95a88a0...) through `--clip`. Reads 16/24/32-bit PCM WAV, writes 16-bit
# stereo at the source's sample rate (44.1 kHz).
import os, sys, wave
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "..", "..", "public", "ident", "audio", "fusedrums", "mix.wav")
DUR = 5.0  # = FUSE_FRAMES / 30
GAIN_DB = -1.3  # +0.08 dBTP -> about -1.2 dBTP, after 16-bit rounding

args = sys.argv[1:]
clip = "--clip" in args
if clip:
    args.remove("--clip")
if not args or args[0].startswith("-"):
    sys.exit("usage: uv run src/ident/fusedrums/gen-audio.py <song.wav> [--start SECONDS]\n"
             "       uv run src/ident/fusedrums/gen-audio.py --clip <cut.wav>")
src = args[0]
start = 0.0 if clip else (float(args[args.index("--start") + 1]) if "--start" in args else 62.407)

with wave.open(src) as w:
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
    sys.exit(f"{src}: {8 * sw}-bit WAV not supported, export 16 or 24-bit PCM")
x = x.reshape(-1, ch)
if ch == 1:
    x = np.repeat(x, 2, axis=1)
x = x[:, :2].copy()
if len(x) < int(DUR * sr) - 1:
    sys.exit(f"{src}: shorter than {start + DUR:.1f} s" + ("" if clip else ", pick an earlier --start"))

if not clip:  # an existing cut already has its fades
    fi, fo = int(0.03 * sr), int(0.6 * sr)
    x[:fi] *= np.linspace(0, 1, fi)[:, None]
    x[-fo:] *= (np.linspace(1, 0, fo) ** 2)[:, None]
x *= 10 ** (GAIN_DB / 20)

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with wave.open(OUT, "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(sr)
    w.writeframes(np.round(np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())
what = "the cut" if clip else f"{start:.3f}-{start + DUR:.3f} s"
print(f"wrote {os.path.normpath(OUT)}: {what} of {os.path.basename(src)}, {GAIN_DB:+.1f} dB")
