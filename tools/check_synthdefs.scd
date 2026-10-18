// =============================================================================
//  Offline check of the pipe SynthDefs: renders pipes in several situations
//  with non-realtime scsynth, so tools/check_synthdefs.py can measure them.
//
//    sclang tools/check_synthdefs.scd /tmp/organ_check.wav /tmp/organ-C3.wav
//
//  The second file is one corpus note decoded to WAV (48 kHz mono), e.g.
//    ffmpeg -i app/static/corpus/organ-C3.ogg -ar 48000 -c:a pcm_f32le /tmp/organ-C3.wav
//
//  Timeline (reverb off: direct sound only):
//    0-10.5 s   synth pipe: 7 placements, scenario i from i*1.5 s for 1 s
//    11-20.5 s  recorded C3, right side, valve held 9 s (loops 3 times)
//    21-23 s    synth pipe, stopped-pipe model of C3, front 2 m
//    24-26 s    recorded C3, front 2 m (for comparing loudness with 21-23)
// =============================================================================
(
var root = thisProcess.nowExecutingPath.dirname.dirname;
var outPath = thisProcess.argv[0] ? (Platform.defaultTempDir +/+ "organ_check.wav");
var notePath = thisProcess.argv[1];
var defs = (root +/+ "sound" +/+ "organ_synthdefs.scd").load;
var byName = ();
// name, azimuth, distance, binaural, gate
var scenarios = [
    ["right_headphones", 0.5pi, 2, 1, 1],
    ["left_headphones", -0.5pi, 2, 1, 1],
    ["front_2m", 0, 2, 1, 1],
    ["front_8m", 0, 8, 1, 1],
    ["valve_closed", 0, 2, 1, 0],
    ["right_speakers", 0.5pi, 2, 0, 1],
    ["behind_2m", pi, 2, 1, 1],
];
// C3 in the corpus: loop points (s) and the stopped-pipe model (corpus.json)
var loopStart = 1.51, loopEnd = 4.011083, rate = 2 ** ((48 - 47.991) / 12);
var stopped = [1.0, 0.0022, 0.1223, 0.0028, 0.0245, 0.0011, 0.0021, 0.0006];
var score;
defs.do { |d| byName[d.name.asSymbol] = d };
if (notePath.isNil) { "usage: sclang tools/check_synthdefs.scd out.wav organ-C3.wav".postln; 1.exit };

score = Score(
    [
        [0, [\d_recv, byName[\organPipe].asBytes]],
        [0, [\d_recv, byName[\organSample].asBytes]],
        [0, [\d_recv, byName[\organMaster].asBytes]],
        [0, [\b_allocRead, 0, notePath]],
        [0, [\g_new, 1, 0, 0]],
        [0, [\g_new, 2, 1, 0]],
        [0, [\s_new, \organMaster, 1000, 0, 2, \amp, 0.8, \room, 0.6]],
    ]
    ++ scenarios.collect { |s, i|
        [i * 1.5, [\s_new, \organPipe, 2000 + i, 0, 1, \freq, 220, \gate, s[4],
            \azimuth, s[1], \distance, s[2], \binaural, s[3], \reverb, 0]]
    }
    ++ scenarios.collect { |s, i| [i * 1.5 + 1.0, [\n_set, 2000 + i, \gate, 0]] }
    ++ [
        [11, [\s_new, \organSample, 3000, 0, 1, \buf, 0, \rate, rate, \loopStart, loopStart,
            \loopEnd, loopEnd, \gate, 1, \azimuth, 0.5pi, \distance, 2, \binaural, 1, \reverb, 0]],
        [20, [\n_set, 3000, \gate, 0]],
        [21, [\s_new, \organPipe, 3001, 0, 1, \freq, 130.81, \attack, 0.265, \gate, 1,
            \azimuth, 0, \distance, 2, \binaural, 1, \reverb, 0]],
        [21, [\n_setn, 3001, \harm, 8] ++ stopped],
        [23, [\n_set, 3001, \gate, 0]],
        [24, [\s_new, \organSample, 3002, 0, 1, \buf, 0, \rate, rate, \loopStart, loopStart,
            \loopEnd, loopEnd, \gate, 1, \azimuth, 0, \distance, 2, \binaural, 1, \reverb, 0]],
        [26, [\n_set, 3002, \gate, 0]],
        [26.5, [\c_set, 0, 0]],
    ]
);
("rendering -> " ++ outPath).postln;
score.recordNRT(
    outputFilePath: outPath,
    sampleRate: 48000,
    headerFormat: "WAV",
    sampleFormat: "int16",
    options: ServerOptions.new.numOutputBusChannels_(2),
    duration: 26.5,
    action: { "RENDERED".postln; 0.exit }
);
)
