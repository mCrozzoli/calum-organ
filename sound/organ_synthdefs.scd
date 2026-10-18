// =============================================================================
//  Calum Organ: the simulated pipes, as SuperCollider SynthDefs.
//
//  The web app plays these in the browser with SuperSonic (scsynth compiled
//  to WebAssembly) for the demo organ and the preview. They run unchanged on
//  a desktop scsynth too.
//
//    build:  sclang tools/build_synthdefs.scd   -> app/static/synthdefs/
//    check:  sclang tools/check_synthdefs.scd   (renders offline, measures)
//
//  Two ways to make a pipe, one way to place it:
//    organPipe    synthesis: a flue pipe's harmonics (`harm`, 8 levels),
//                 breath noise and attack chiff. The app sets `harm` and
//                 `attack` to an open pipe (principal) or to a stopped pipe
//                 measured from the recorded organ (tools/build_corpus.py).
//    organSample  a recorded organ note (app/static/corpus/): plays the
//                 attack, then cycles the steady part for as long as the
//                 valve stays open.
//    organMaster  reverb, volume, limiter.
//
//  Signal path:
//    8 pipe synths (head group; the valve is `gate`) -> dry bus 16-17
//      + reverb bus 18-19 -> organMaster (tail group) -> out 0-1
//
//  Space: `azimuth` in radians (0 = in front of the listener, +pi/2 = right,
//  -pi/2 = left, pi = behind), `distance` in metres. `binaural` 1 =
//  headphones (time difference + head shadow between the ears), 0 =
//  speakers (plain stereo panning).
// =============================================================================
(
var place, pipe, sample, master;

// ---- the space: shared by both pipe kinds ----------------------------------
place = { |sig, azimuth, distance, binaural, reverb, out, revOut|
    var az, dist, sinAz, lat, back, gain, itd, near, far, binL, binR, panned, out2;
    az = Lag.kr(azimuth, 0.08);                 // smooth while dragging
    dist = Lag.kr(distance, 0.08).max(0.3);
    sinAz = az.sin;                             // -1 left .. +1 right
    lat = sinAz.abs.asin;                       // 0 .. pi/2, same in front and behind
    back = az.cos.neg.max(0);                   // 0 in front .. 1 straight behind

    // Distance: a softened inverse law (1 at 1 m, 0.5 at 3 m, ~0.2 at 9 m),
    // and air absorbs the highs of far sources. Behind the head the outer
    // ears make it a little duller and quieter: only a hint, since telling
    // front from back needs a measured head model (HRTF) to be convincing.
    gain = (1 / (1 + (0.5 * (dist - 1).max(0)))).min(1.4) * (1 - (0.2 * back));
    sig = LPF.ar(sig, min(dist.linexp(1, 20, 18000, 4500), back.linexp(0, 1, 19000, 2500)));

    // Headphones: the far ear hears the pipe later (Woodworth's interaural
    // time difference, up to ~0.66 ms) and duller and quieter (head shadow).
    // The level difference is a little stronger than a real head gives for
    // low notes (~7 dB at the side), so placement is easy to hear.
    itd = (0.0875 / 343) * (lat + lat.sin);
    near = sig;
    far = LPF.ar(DelayC.ar(sig, 0.001, itd), sinAz.abs.linexp(0, 1, 18000, 1600))
        * (1 - (0.55 * sinAz.abs));
    binL = Select.ar(sinAz > 0, [near, far]);   // pipe on the right: left ear is far
    binR = Select.ar(sinAz > 0, [far, near]);

    // Speakers: plain stereo panning by left/right position.
    panned = Pan2.ar(sig, sinAz, 1.2);

    out2 = (([binL, binR] * binaural) + (panned * (1 - binaural))) * gain;
    Out.ar(out, out2);
    // The reverb share grows with distance: the strongest "far away" cue.
    Out.ar(revOut, out2 * reverb * dist.linlin(0.5, 12, 0.4, 2.5));
};

// ---- a synthesised pipe ------------------------------------------------------
pipe = SynthDef(\organPipe, {
    |out = 16, revOut = 18, freq = 220, gate = 0, amp = 0.2, attack = 0.04,
     azimuth = 0, distance = 2, binaural = 1, reverb = 0.25|

    // Harmonic levels 1..8 (fundamental first). Default: an open pipe.
    var harm = \harm.kr([1, 0.42, 0.2, 0.11, 0.06, 0.035, 0.02, 0.01]);
    var env, chiffEnv, wobble, tone, breath, chiff;

    // The valve: the pipe "speaks" in `attack` seconds (slower for low
    // pipes) and dies away in ~90 ms.
    env = EnvGen.kr(Env.asr(attack, 1, 0.09, [2, -4]), gate);
    // Chiff: the short breathy transient each time the valve opens.
    chiffEnv = EnvGen.kr(Env.perc(0.004, 0.07, 1, -4), gate);
    // Wind pressure is never perfectly steady.
    wobble = 1 + LFNoise2.kr(0.7, 0.0007);

    // The harmonics, normalised so every spectrum has the same loudness.
    tone = SinOsc.ar(freq * wobble * (1..8), 0, harm).sum / harm.squared.sum.sqrt.max(0.001);
    // Breath noise around the pitch, louder during the chiff.
    breath = BPF.ar(PinkNoise.ar, freq * [1, 2], 0.12).sum * (0.35 + (chiffEnv * 1.5));
    chiff = BPF.ar(WhiteNoise.ar, (freq * 4).min(9000), 0.4) * chiffEnv * 1.5;

    place.(((tone * 0.3) + breath + chiff) * env * amp,
           azimuth, distance, binaural, reverb, out, revOut);
});

// ---- a recorded pipe -----------------------------------------------------------
sample = SynthDef(\organSample, {
    |out = 16, revOut = 18, buf = 0, rate = 1, loopStart = 1.5, loopEnd = 4.0,
     gate = 0, amp = 0.5, azimuth = 0, distance = 2, binaural = 1, reverb = 0.12|

    var env, sr, ls, le, attackPos, loopPos;
    // The recording has its own attack: the envelope only avoids clicks,
    // and releases like a closing valve.
    env = EnvGen.kr(Env.asr(0.003, 1, 0.12, [0, -4]), gate);
    sr = BufSampleRate.kr(buf);
    ls = loopStart * sr;                        // loop points come in seconds:
    le = loopEnd * sr;                          // browsers resample on decoding
    // Frames since the valve opened. From the loop start on, a Phasor cycles
    // the steady part: started at 0 on the same trigger, its wrap into
    // [ls, le) lands exactly on ls when the attack reaches ls, so there's no
    // jump; the crossfade baked into the file hides the wrap at le.
    attackPos = Sweep.ar(gate, sr * rate);
    loopPos = Phasor.ar(gate, BufRateScale.kr(buf) * rate, ls, le, 0);

    place.(BufRd.ar(1, buf, Select.ar(attackPos < ls, [loopPos, attackPos]), 0, 4) * env * amp,
           azimuth, distance, binaural, reverb, out, revOut);
});

master = SynthDef(\organMaster, {
    |in = 16, revIn = 18, out = 0, amp = 0.8, room = 0.6|
    var dry = In.ar(in, 2), wet = In.ar(revIn, 2);
    wet = FreeVerb2.ar(wet[0], wet[1], 1, Lag.kr(room, 0.2), 0.45);
    Out.ar(out, Limiter.ar((dry + wet) * Lag.kr(amp, 0.05), 0.9, 0.005));
});

[pipe, sample, master]
)
