"""Measure the offline render from tools/check_synthdefs.scd.

    sclang tools/check_synthdefs.scd /tmp/organ_check.wav
    python3 tools/check_synthdefs.py /tmp/organ_check.wav

Checks that the pipe SynthDef places sound where the stage says: louder and
earlier in the near ear, quieter when far, silent with the valve closed.
Standard library only.
"""
from __future__ import annotations

import array
import math
import sys
import wave

SCENARIOS = ["right_headphones", "left_headphones", "front_2m", "front_8m",
             "valve_closed", "right_speakers", "behind_2m"]


def load(path):
    with wave.open(path) as w:
        assert w.getnchannels() == 2 and w.getsampwidth() == 2
        sr = w.getframerate()
        data = array.array("h", w.readframes(w.getnframes()))
    return sr, data[0::2], data[1::2]


def rms_db(x):
    if not x:
        return -math.inf
    r = math.sqrt(sum(v * v for v in x) / len(x)) / 32768
    return 20 * math.log10(r) if r > 0 else -math.inf


def lag_samples(left, right, max_lag=60):
    """Positive = the left channel arrives later than the right."""
    best, best_lag = -math.inf, 0
    n = len(left)
    for lag in range(-max_lag, max_lag + 1):
        s = 0
        for i in range(max_lag, n - max_lag):
            s += right[i] * left[i + lag]
        if s > best:
            best, best_lag = s, lag
    return best_lag


def main(path):
    sr, L, R = load(path)
    m = {}
    for i, name in enumerate(SCENARIOS):
        a, b = int((i * 1.5 + 0.3) * sr), int((i * 1.5 + 0.9) * sr)
        m[name] = (rms_db(L[a:b]), rms_db(R[a:b]))
    print(f"{'scenario':18s} {'left dB':>8s} {'right dB':>9s}")
    for name, (l, r) in m.items():
        print(f"{name:18s} {l:8.1f} {r:9.1f}")

    a = int(0.4 * sr)
    itd = lag_samples(L[a:a + 4800], R[a:a + 4800])
    print(f"\nright_headphones: left ear lags by {itd} samples ({itd / sr * 1000:.2f} ms)")

    checks = [
        ("pipe on the right is louder in the right ear (>6 dB)",
         m["right_headphones"][1] - m["right_headphones"][0] > 6),
        ("pipe on the left is louder in the left ear (>6 dB)",
         m["left_headphones"][0] - m["left_headphones"][1] > 6),
        ("left/right mirror each other (within 0.5 dB)",
         abs(m["right_headphones"][1] - m["left_headphones"][0]) < 0.5),
        ("pipe in front is centred (within 0.5 dB)",
         abs(m["front_2m"][0] - m["front_2m"][1]) < 0.5),
        ("8 m away is quieter than 2 m (>6 dB)",
         m["front_2m"][0] - m["front_8m"][0] > 6),
        ("closed valve is silent (< -70 dB)",
         max(m["valve_closed"]) < -70),
        ("speakers: right pipe louder on the right (>6 dB)",
         m["right_speakers"][1] - m["right_speakers"][0] > 6),
        ("behind is duller/quieter than in front",
         m["behind_2m"][0] < m["front_2m"][0]),
        # ~0.66 ms from the head model + ~0.1 ms group delay of the shadow filter
        ("far ear hears it 0.5-0.9 ms later",
         0.5 <= itd / sr * 1000 <= 0.9),
    ]
    print()
    ok = True
    for label, passed in checks:
        print(("PASS " if passed else "FAIL ") + label)
        ok &= passed
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
