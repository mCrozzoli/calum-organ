"""Measure the offline render from tools/check_synthdefs.scd.

    sclang tools/check_synthdefs.scd /tmp/organ_check.wav /tmp/organ-C3.wav
    python3 tools/check_synthdefs.py /tmp/organ_check.wav

Checks that the pipes are placed where the stage says (louder and earlier in
the near ear, quieter when far, silent with the valve closed), that a held
recorded note loops without clicks or dips, and compares the loudness of the
synth and the recording. Standard library only.
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

    # ---- recorded C3, held 9 s on the right (gate opens at 11 s)
    g0 = int(11 * sr)
    held_l, held_r = rms_db(L[g0 + sr:g0 + 8 * sr]), rms_db(R[g0 + sr:g0 + 8 * sr])
    seams = [4.011083 + k * (4.011083 - 1.51) for k in range(3)]     # loop wraps after the gate
    d2 = [abs(R[i + 1] - 2 * R[i] + R[i - 1]) for i in range(g0 + int(2.0 * sr), g0 + int(9.0 * sr))]
    base = g0 + int(2.0 * sr)
    near_seam = set()
    for t in seams:
        c = g0 + int(t * sr) - base
        near_seam.update(range(c - int(0.003 * sr), c + int(0.003 * sr)))
    seam_peak = max(d2[i] for i in near_seam if 0 <= i < len(d2))
    rest = sorted(d2[i] for i in range(len(d2)) if i not in near_seam)
    ref = rest[int(len(rest) * 0.999)]
    win = int(0.25 * sr)
    levels = [rms_db(R[a:a + win]) for a in range(g0 + int(1.0 * sr), g0 + int(8.75 * sr), win)]
    print(f"\nrecorded C3 held on the right: left {held_l:.1f} dB, right {held_r:.1f} dB")
    print(f"loop seams: sharpest change {seam_peak:.0f} vs {ref:.0f} elsewhere (99.9th pct)")
    print(f"level over 7.75 s of holding: {min(levels):.1f} .. {max(levels):.1f} dB")

    # ---- loudness: synth (stopped model) vs recording, same place
    synth_db = rms_db(L[int(21.5 * sr):int(22.9 * sr)])
    rec_db = rms_db(L[int(24.5 * sr):int(25.9 * sr)])
    print(f"loudness at C3, front 2 m: synth {synth_db:.1f} dB, recording {rec_db:.1f} dB "
          f"(recording {rec_db - synth_db:+.1f} dB)")

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
        ("recorded pipe on the right is louder on the right (>6 dB)", held_r - held_l > 6),
        ("held recording loops without clicks (seams < 2x the sharpest normal change)",
         seam_peak < 2 * ref),
        ("held recording keeps a steady level (within 3 dB)", max(levels) - min(levels) < 3),
    ]
    print()
    ok = True
    for label, passed in checks:
        print(("PASS " if passed else "FAIL ") + label)
        ok &= passed
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
