"""Build the organ sample corpus for the browser from VSCO 2 CE recordings.

    python3 tools/build_corpus.py <folder with NT5_Man3Quiet_*_rr1.wav>

Source: Versilian Studios Chamber Orchestra 2: Community Edition (CC0),
https://github.com/sgossner/VSCO-2-CE, Keys/Organ/Quiet: a chapel organ
sampled by Simon Dalzell (Ivy Audio), manual 3, quiet stop, one note every
three semitones. File number minus 86 is the MIDI note.

For each note it:
  - takes one microphone (summing the spaced pair would comb-filter),
  - trims the silence before the pipe speaks,
  - measures the real pitch (the organ isn't exactly A440),
  - picks a steady stretch whose length is a whole number of periods and
    bakes a crossfade into its end, so a sustained note can loop forever
    without a click,
  - evens out the level, and encodes it as Ogg Opus.
It also measures each note's harmonic balance and attack time, which the
SuperCollider synth uses so it sounds like this organ.

Writes app/static/corpus/organ-*.ogg and app/static/corpus/corpus.json.
Needs ffmpeg (with libopus); otherwise standard library only.
"""
from __future__ import annotations

import array
import cmath
import hashlib
import json
import math
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "app" / "static" / "corpus"
SR = 48000                 # Opus decodes at 48 kHz anyway
NOTE_RANGE = range(36, 85, 3)
NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

LOOP_START = 1.5           # s after the pipe speaks: past the attack
LOOP_TARGET = 2.5          # s of steady tone to loop
CROSSFADE = 0.2            # s baked into the end of the loop
TARGET_RMS_DB = -22.0      # steady level of every note
HARMONICS = 8


def note_name(m: int) -> str:
    return f"{NAMES[m % 12]}{m // 12 - 1}"


def decode(path: Path) -> array.array:
    """One channel (left microphone) as float32 at 48 kHz."""
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-af", "pan=mono|c0=c0",
         "-ar", str(SR), "-f", "f32le", "-"],
        check=True, capture_output=True).stdout
    return array.array("f", raw)


def rms(x, a, b) -> float:
    s = 0.0
    for i in range(a, b):
        s += x[i] * x[i]
    return math.sqrt(s / max(1, b - a))


def measure_f0(x, start: int, nominal: float) -> float:
    """Autocorrelation peak near the nominal period, refined by a parabola."""
    period = SR / nominal
    lo, hi = int(period * 0.97), int(period * 1.03) + 1
    n = int(0.25 * SR)
    seg = x[start:start + n + hi + 1]

    def ac(lag):
        s = 0.0
        for i in range(n):
            s += seg[i] * seg[i + lag]
        return s

    vals = {lag: ac(lag) for lag in range(lo - 1, hi + 2)}
    best = max(range(lo, hi + 1), key=vals.get)
    a, b, c = vals[best - 1], vals[best], vals[best + 1]
    shift = 0.5 * (a - c) / (a - 2 * b + c) if (a - 2 * b + c) != 0 else 0.0
    return SR / (best + shift)


def harmonics(x, start: int, f0: float) -> list:
    """Relative amplitude of harmonics 1..N over 1 s of steady tone (Hann window)."""
    n = SR
    w = [0.5 - 0.5 * math.cos(2 * math.pi * i / (n - 1)) for i in range(n)]
    seg = x[start:start + n]
    amps = []
    for h in range(1, HARMONICS + 1):
        if h * f0 > SR / 2 * 0.9:
            amps.append(0.0)
            continue
        step = cmath.exp(-2j * math.pi * h * f0 / SR)
        z, acc = 1 + 0j, 0j
        for i in range(n):
            acc += seg[i] * w[i] * z
            z *= step
        amps.append(abs(acc))
    top = amps[0] or 1.0
    return [round(a / top, 4) for a in amps]


def attack_time(x, onset: int, steady: float) -> float:
    """Seconds from the onset until the level first reaches 90% of steady."""
    frame = int(0.005 * SR)
    for k in range(0, int(1.5 * SR), frame):
        if rms(x, onset + k, onset + k + frame) >= 0.9 * steady:
            return round(k / SR, 3)
    return 1.5


def write_wav(path: Path, x) -> None:
    pcm = array.array("h", (max(-32767, min(32767, int(v * 32767))) for v in x))
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def build(src_dir: Path) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("organ-*.ogg"):
        old.unlink()
    samples = []
    for midi in NOTE_RANGE:
        src = src_dir / f"NT5_Man3Quiet_{midi + 86}_rr1.wav"
        x = decode(src)
        peak = max(abs(v) for v in x)

        # where the pipe starts to speak (-40 dB below the peak), minus 10 ms
        thresh = peak * 10 ** (-40 / 20)
        onset = next(i for i, v in enumerate(x) if abs(v) > thresh)
        start = max(0, onset - int(0.01 * SR))
        x = x[start:]
        onset -= start

        nominal = 440 * 2 ** ((midi - 69) / 12)
        f0 = measure_f0(x, onset + int(LOOP_START * SR), nominal)
        steady = rms(x, onset + int(1.5 * SR), onset + int(4.0 * SR))

        # loop: a whole number of periods, starting LOOP_START after the onset
        ls = onset + int(LOOP_START * SR)
        periods = round(LOOP_TARGET * f0)
        le = ls + round(periods * SR / f0)
        xf = int(CROSSFADE * SR)
        y = array.array("f", x[:le + int(0.05 * SR)])
        for k in range(xf):                    # bake the seam: end fades into what precedes ls
            wgt = k / xf
            y[le - xf + k] = (1 - wgt) * x[le - xf + k] + wgt * x[ls - xf + k]
        for k in range(le, len(y)):            # after le, continue as after ls (for interpolation)
            y[k] = x[ls + (k - le)]

        gain = 10 ** (TARGET_RMS_DB / 20) / steady
        gain = min(gain, 0.95 / max(abs(v) for v in y))
        for i in range(int(0.005 * SR)):       # 5 ms fade-in against clicks
            y[i] *= i / (0.005 * SR)
        y = array.array("f", (v * gain for v in y))

        name = f"organ-{note_name(midi).replace('#', 's')}.ogg"
        with tempfile.TemporaryDirectory() as tmp:
            tmp_wav = Path(tmp) / "note.wav"
            write_wav(tmp_wav, y)
            subprocess.run(
                ["ffmpeg", "-v", "error", "-y", "-i", str(tmp_wav), "-c:a", "libopus",
                 "-b:a", "80k", "-application", "audio", str(OUT / name)],
                check=True)

        measured_midi = 69 + 12 * math.log2(f0 / 440)
        samples.append({
            "file": name,
            "note": note_name(midi),
            "midi": round(measured_midi, 3),
            "f0": round(f0, 3),
            "loopStart": round(ls / SR, 6),
            "loopEnd": round(le / SR, 6),
            "duration": round(len(y) / SR, 4),
            "attack": attack_time(x, onset, steady),
            "harmonics": harmonics(x, onset + int(1.5 * SR), f0),
            "source": src.name,
            "sourceSha256": hashlib.sha256(src.read_bytes()).hexdigest(),
        })
        s = samples[-1]
        print(f"{s['note']:4s} {name:16s} f0 {f0:8.3f} Hz ({measured_midi - midi:+.2f} st)  "
              f"loop {s['loopStart']:.3f}-{s['loopEnd']:.3f}s  attack {s['attack']:.3f}s  "
              f"h2 {s['harmonics'][1]:.2f} h3 {s['harmonics'][2]:.2f}  "
              f"{(OUT / name).stat().st_size // 1024} KB")

    # The synth's model of this organ: each note's harmonics and attack,
    # smoothed with a median over neighbouring notes (one recording can have
    # a room or microphone null, e.g. D#2's fundamental) and capped at the
    # fundamental's level.
    def median(v):
        v = sorted(v)
        return v[len(v) // 2]

    model = []
    for i, smp in enumerate(samples):
        near = samples[max(0, i - 2):i + 3]
        harm = [1.0] + [round(min(1.0, median([n["harmonics"][h] for n in near])), 4)
                        for h in range(1, HARMONICS)]
        attack = round(min(0.3, max(0.02, median([n["attack"] for n in near]))), 3)
        model.append({"midi": smp["midi"], "harmonics": harm, "attack": attack})

    corpus = {
        "name": "Chapel organ, manual 3, quiet stop",
        "credit": "Organ sampled by Simon Dalzell (Ivy Audio), Winter 2015-16, for "
                  "Versilian Studios Chamber Orchestra 2: Community Edition",
        "license": "CC0-1.0",
        "url": "https://github.com/sgossner/VSCO-2-CE/tree/master/Keys/Organ/Quiet",
        "processing": "tools/build_corpus.py: left microphone, trimmed, pitch measured, "
                      "loop with baked crossfade, levelled, Ogg Opus 80 kbps",
        "samples": samples,
        "model": model,
    }
    (OUT / "corpus.json").write_text(json.dumps(corpus, indent=1) + "\n")
    total = sum(p.stat().st_size for p in OUT.glob("organ-*.ogg"))
    print(f"\n{len(samples)} notes, {total // 1024} KB -> {OUT}")
    print("synth model (smoothed):")
    for m in model:
        print(f"  midi {m['midi']:6.2f}  attack {m['attack']:.3f}s  harmonics {m['harmonics']}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    build(Path(sys.argv[1]))
