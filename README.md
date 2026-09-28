# Ambience Sandbox

A sandbox for building personal ambient worlds: evolving generative music, nature soundscapes and procedural visuals, all driven by one shared world state.

Status: pre-alpha. The plan is in [docs/PLAN.md](docs/PLAN.md). Current work is **M0-S1, the rain bake-off**.

## Run it

```sh
npm install
npm run dev
```

Then open the URL Vite prints and go to **Rain bake-off** (`/spikes/rain-bakeoff/`). Use desktop Chrome, Firefox or Safari.

Other scripts: `npm test` (unit tests), `npm run typecheck`, `npm run build`.

## Rain bake-off

Compares three candidates for the rain layer:

| | Candidate | What it is |
|---|---|---|
| A | Recorded | Your MP3/WAV, played as an endless bed: random segments with matched equal-power crossfades, shuffled so nothing repeats soon |
| B | Synthetic | The procedural `RainSynth`: Marshall–Palmer drop sizes, impact + bubble per drop, near/mid/far tiers |
| C | Hybrid | Your recording as the wash, plus synthetic near and mid drops on top |

**Explore tab:** load your recording (file picker, or drag it onto the page), press Start, switch A/B/C (keys `1` `2` `3`), and play with every synth control. That includes the non-physical ones: rain in key, rain on a rhythmic grid, time stretch and giant drops. The lake shows a ripple for each near drop you hear.

**Blind test tab:** X/Y/Z are A/B/C in random order, loudness-matched to −30 LUFS, with visuals hidden. Listen to each for 5+ minutes (ideally while reading), press `R` when you hear a repeat, and rate realism and "would I study to this". "Reveal and save" stores the result in the browser and applies the plan's rule: **synthetic becomes the default if its realism is within 0.5 of the recording.** "Download all results" exports JSON.

**About your recording:**
- MP3 is fine; use 192 kbps or better. WAV is better if your recorder gives it.
- Longer is better: 3+ minutes minimum, 10+ ideal. Under a minute and the recorded candidate will repeat and lose unfairly.
- One continuous take in one spot. Trim out voices, cars and handling noise first.
- Recordings stay local: the page never uploads anything, and `assets-raw/` is git-ignored if you want to keep files in the repo folder.

## Layout

```
src/core/rng.ts                      seeded PRNG streams, shuffle bag
src/audio/nature/rain/               RainSynth, physics (Marshall–Palmer, Minnaert), surfaces, ResonatorBank
src/audio/nature/BedPlayer.ts        endless bed from a finite recording
src/audio/dsp/limiter.ts             lookahead brick-wall limiter + NaN guard (always on)
src/audio/dsp/loudness.ts            BS.1770 K-weighted loudness
src/audio/worklets/                  AudioWorklet wrappers for the above
spikes/rain-bakeoff/                 the bake-off page (throwaway UI)
tests/                               Vitest unit tests
```
