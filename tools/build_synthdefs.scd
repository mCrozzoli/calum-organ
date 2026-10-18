// =============================================================================
//  Build the web SynthDefs (same pattern as the Dark Sonification web ports).
//
//    sclang tools/build_synthdefs.scd
//    (macOS: /Applications/SuperCollider.app/Contents/MacOS/sclang ...)
//
//  Compiles sound/organ_synthdefs.scd and writes .scsyndef binaries into
//  app/static/synthdefs/, which the browser loads into SuperSonic. Needs no
//  booted server: writeDefFile is a pure compile + write. Re-run after any
//  change to sound/organ_synthdefs.scd, then commit the results.
// =============================================================================
(
var root = thisProcess.nowExecutingPath.dirname.dirname;
var srcFile = root +/+ "sound" +/+ "organ_synthdefs.scd";
var outDir = root +/+ "app" +/+ "static" +/+ "synthdefs";
var defs, n = 0;

("source : " ++ srcFile).postln;
("target : " ++ outDir).postln;
if (File.exists(srcFile).not) { ("MISSING SOURCE: " ++ srcFile).postln; 1.exit };
File.mkdir(outDir);

defs = srcFile.load;
if (defs.isKindOf(Array).not) { "source did not return an Array of SynthDefs".postln; 1.exit };

defs.do { |d|
    d.writeDefFile(outDir);
    n = n + 1;
    ("  WROTE " ++ d.name.asString.padRight(12)
        ++ " controls: " ++ d.allControlNames.collect { |c| c.name }).postln;
};
("BUILT " ++ n ++ "/" ++ defs.size).postln;
if (n == defs.size) { "OK".postln; 0.exit } { "INCOMPLETE".postln; 1.exit };
)
