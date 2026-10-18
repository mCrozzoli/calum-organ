// =============================================================================
//  Offline check of the pipe SynthDefs: renders one pipe in several places
//  with non-realtime scsynth, so tools/check_synthdefs.py can measure that
//  left/right, distance, the valve and the ear delay behave as intended.
//
//    sclang tools/check_synthdefs.scd /tmp/organ_check.wav
//
//  Scenario i plays from i*1.5 s to i*1.5+1 s (reverb off: direct sound only).
// =============================================================================
(
var root = thisProcess.nowExecutingPath.dirname.dirname;
var outPath = thisProcess.argv[0] ? (Platform.defaultTempDir +/+ "organ_check.wav");
var defs = (root +/+ "sound" +/+ "organ_synthdefs.scd").load;
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
var dur = scenarios.size * 1.5 + 0.5;
var score = Score(
    [
        [0, [\d_recv, defs[0].asBytes]],
        [0, [\d_recv, defs[1].asBytes]],
        [0, [\g_new, 1, 0, 0]],
        [0, [\g_new, 2, 1, 0]],
        [0, [\s_new, \organMaster, 1000, 0, 2, \amp, 0.8, \room, 0.6]],
    ]
    ++ scenarios.collect { |s, i|
        [i * 1.5, [\s_new, \organPipe, 2000 + i, 0, 1, \freq, 220, \gate, s[4],
            \azimuth, s[1], \distance, s[2], \binaural, s[3], \reverb, 0]]
    }
    ++ scenarios.collect { |s, i| [i * 1.5 + 1.0, [\n_set, 2000 + i, \gate, 0]] }
    ++ [[dur, [\c_set, 0, 0]]]
);
("rendering " ++ scenarios.size ++ " scenarios -> " ++ outPath).postln;
score.recordNRT(
    outputFilePath: outPath,
    sampleRate: 48000,
    headerFormat: "WAV",
    sampleFormat: "int16",
    options: ServerOptions.new.numOutputBusChannels_(2),
    duration: dur,
    action: { "RENDERED".postln; 0.exit }
);
)
