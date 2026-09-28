# Session handoff (2026-09-28)

Where things stand, so the next session can pick up without re-reading the whole chat.

## Built

- **Tarn Sandbox** (`spikes/sandbox/`, published as a private claude.ai Artifact): four live-synthesised layers in one world.
  - **Rain**: `RainSynth`. Marshall–Palmer drop sizes, impact + Minnaert bubble, near/mid/far tiers, 7 surfaces (water, leaves, grass, stone, tin roof, window glass, "Bells (unreal)"), rain in key, rain on a grid, time stretch.
  - **Wind**: `WindSynth` + `Leaves`. Body, whistle, a canopy wash and fluttering leaves. It is the world's gust source.
  - **Wind chimes**: `ChimeSynth`. Tuned tubes with free–free bar partials; the clapper is driven by the wind.
  - **Music**: `MusicSynth`. Gliding pad chords and sparse FM keys with a slow "breath".
  - A shared FDN `Reverb`, and `WorldSynth` coupling it all in one AudioWorklet (about 9% of a core).
  - An always-on lookahead limiter with a NaN guard.
- 41 unit tests (`npm test`). `npm run build:artifact` produces the single-file page.

## Decisions made

Desktop-first; non-commercial; rain fully synthetic (no recordings); layers are Rain / Wind / Chimes / Music; visual direction is a synaesthetic 3D object with floating dials (PLAN §11, D1–D10).

## User feedback so far

- Rain overall: "sounds good".
- Old tin/glass sounded like fast wind chimes or a xylophone. They were rebuilt as a short clatter and ticks, and the old sound is kept as "Bells (unreal)". **The rebuild hasn't been listened to yet.**
- Wind leaves sounded like static or shuffling sand. They were rebuilt as canopy + flutters. **Not listened to yet.**
- Wind, chimes and music have had no specific feedback yet.

## Known gaps

- Scene changes cut instantly; a smooth morph is planned but not built. Scenes are level-trimmed, but not loudness-matched.
- All synth constants are initial guesses; only the leaves are level-calibrated by measurement. Nothing has been tuned by listening beyond the user's comments above.
- There's no persistence, no save/share link and no Focus mode or timer yet (PLAN M6/M7).
- The visual is a 2D placeholder with a pitch → hue mapping.

## Suggested next steps

1. Get listening feedback on the new tin, glass and leaves, and on wind, chimes and music, then tune.
2. Design pass for the 3D synaesthetic object and floating dials: per-layer visual grammar, Focus-mode calming, reduced motion, flash safety, and keyboard/screen-reader access for the dials. Prototype in Three.js/WebGL, driven by `WorldSynth` events and features.
3. Scene morphing (parameter interpolation) and loudness-matched scenes.
4. Save/share: URL-encoded world + seed (PLAN §7.8).
