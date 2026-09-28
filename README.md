# Ambience Sandbox

A sandbox for building personal ambient worlds: evolving generative music, nature soundscapes and procedural visuals, all driven by one shared world state.

Status: pre-alpha. The plan is in [docs/PLAN.md](docs/PLAN.md). Current work: **Tarn Sandbox**, the first playable world.

## Run it

```sh
npm install
npm run dev
```

Open the URL Vite prints and go to **Tarn Sandbox** (`/spikes/sandbox/`). Use desktop Chrome, Firefox or Safari.

Other scripts: `npm test` (unit tests), `npm run typecheck`, `npm run build`, `npm run build:artifact` (the sandbox as one self-contained HTML file, for publishing as a claude.ai Artifact).

## Tarn Lab (listening tests)

`/spikes/lab/` (or `npm run build:lab` for a single-file page). One sound at a time, isolated, with what to listen for, ratings, problem tags, "too quiet / too loud" nudges, sliders for the parameters worth tuning, and a live level meter. Feedback is saved in the browser; **Report** produces a text summary (ratings, notes, slider values you settled on, measured levels) to paste back so the synth constants can be tuned from it. The test catalogue is `spikes/lab/tests.ts`.

## Tarn Sandbox

Four layers, all synthesised live and sharing one world state:

| Layer | What it is | Coupled to |
|---|---|---|
| Rain | Every drop synthesised (Marshall–Palmer sizes, impact + bubble, 7 surfaces, near/mid/far) | Wind gusts push rain in sheets; can snap to the key |
| Wind | Noise body, whistles, leaf rustle; the source of the world's gusts | Drives rain and chimes |
| Wind chimes | Tuned tubes with real chime overtones; a clapper the wind swings | Only ring when the wind reaches them; tuned to the key |
| Music | Gliding pad chords and sparse FM keys with a slow "breath" | Plays in the key |

Plus a shared reverb, scene presets, a key selector (including microtonal ones), and "New seed" (a different but equally valid version of the same world). The safety limiter is always on.

The scene is a 2D placeholder. Each sound has its own visual, and pitch maps to colour (the same note is always the same hue). That mapping is the seed of the planned 3D synaesthetic view.

## Layout

```
src/core/rng.ts                      seeded PRNG streams, shuffle bag
src/audio/world/WorldSynth.ts        all layers together: shared wind, key, reverb; events + features
src/audio/nature/rain/               RainSynth, physics (Marshall–Palmer, Minnaert), surfaces, ResonatorBank
src/audio/nature/wind/               WindSynth
src/audio/nature/chimes/             ChimeSynth
src/audio/music/                     MusicSynth, scales
src/audio/dsp/Reverb.ts              8-line FDN reverb
src/audio/nature/BedPlayer.ts        endless bed from a finite recording (for later recorded layers)
src/audio/dsp/limiter.ts             lookahead brick-wall limiter + NaN guard (always on)
src/audio/dsp/loudness.ts            BS.1770 K-weighted loudness
src/audio/worklets/                  AudioWorklet wrappers for the above
spikes/sandbox/                      the Tarn Sandbox page (throwaway UI)
tests/                               Vitest unit tests
```
