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
//  Signal path:
//    organPipe x 8 (one per pipe, head group; the valve is its `gate`)
//      -> dry bus 16-17 + reverb bus 18-19
//    organMaster (tail group): reverb, volume, limiter -> out 0-1
//
//  Space: each pipe is placed by `azimuth` (radians: 0 = in front of the
//  listener, +pi/2 = right, -pi/2 = left, pi = behind) and `distance`
//  (metres). `binaural` 1 = headphones (time difference + head shadow
//  between the ears), 0 = speakers (plain stereo panning).
// =============================================================================
(
var pipe, master;

pipe = SynthDef(\organPipe, {
    |out = 16, revOut = 18, freq = 220, gate = 0, amp = 0.2,
     azimuth = 0, distance = 2, binaural = 1, reverb = 0.25|

    var env, chiffEnv, wobble, tone, breath, chiff, sig;
    var az, dist, sinAz, lat, back, gain, itd, near, far, binL, binR, panned, out2;

    // ---- the pipe ----------------------------------------------------------
    // The valve: a flue pipe "speaks" in ~40 ms and dies away in ~90 ms.
    env = EnvGen.kr(Env.asr(0.04, 1, 0.09, [2, -4]), gate);
    // Chiff: the short breathy transient each time the valve opens.
    chiffEnv = EnvGen.kr(Env.perc(0.004, 0.07, 1, -4), gate);
    // Wind pressure is never perfectly steady.
    wobble = 1 + LFNoise2.kr(0.7, 0.0007);

    // Strong fundamental, quickly falling harmonics (a soft diapason).
    tone = SinOsc.ar(freq * wobble * [1, 2, 3, 4, 5, 6], 0,
                     [1, 0.42, 0.2, 0.11, 0.06, 0.035]).sum;
    // Breath noise around the pitch, louder during the chiff.
    breath = BPF.ar(PinkNoise.ar, freq * [1, 2], 0.12).sum * (0.35 + (chiffEnv * 1.5));
    chiff = BPF.ar(WhiteNoise.ar, (freq * 4).min(9000), 0.4) * chiffEnv * 1.5;
    sig = ((tone * 0.3) + breath + chiff) * env * amp;

    // ---- the space ---------------------------------------------------------
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
});

master = SynthDef(\organMaster, {
    |in = 16, revIn = 18, out = 0, amp = 0.8, room = 0.6|
    var dry = In.ar(in, 2), wet = In.ar(revIn, 2);
    wet = FreeVerb2.ar(wet[0], wet[1], 1, Lag.kr(room, 0.2), 0.45);
    Out.ar(out, Limiter.ar((dry + wet) * Lag.kr(amp, 0.05), 0.9, 0.005));
});

[pipe, master]
)
