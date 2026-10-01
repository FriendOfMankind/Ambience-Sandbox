# Handoff: Tarn Sandbox (updated 2026-09-30, end of session 2)

Read this first, then the doc for whatever you're working on:
- Visuals: **docs/VISUALS.md**
- Music: **docs/MUSIC.md**
- Research on how ambient is made: **docs/AMBIENT-RESEARCH.md**
- The original product plan: **docs/PLAN.md** (long; decisions in §11)

## 1. Where things stand

Tarn Sandbox is a browser toy: generative ambient music with natural ambience (rain, wind, chimes) underneath, all synthesised live in an AudioWorklet (no samples). It comes with a Three.js world. **The music shapes a glowing object; the ambience is the weather; the object travels through an alien valley.**

- **Live artifact (private to the user):** https://claude.ai/artifact/EmgHKG7SRPbddKAt3WWwQw. Republish with `npm run build:artifact`, then publish `dist-artifact/sandbox.html` to that URL (from a new chat, pass it as `url`; read it first).
- **Tarn Lab** (listening test bench, older): https://claude.ai/artifact/9R9E3oy5W6uiaPzY38eThq
- **Branch:** `claude/kind-clarke-lpoa37` (continues `claude/sleepy-ptolemy-04oiyd`). Everything is committed and pushed. No PR exists.

**Built so far, in order:**
1. **Session 1:** audio engine: rain, wind, chimes, music, reverb, limiter; the Lab.
2. **Session 2:**
   - visuals v1 (object and floating dials)
   - music engine v2: 7 voices, mood and movement dials, Music/Ambience split, Blend
   - Perform processors: looper, tape Age, grains, Swell, Freeze, Orbit, piano, voicings
   - 24 vibes plus Surprise me
   - world v2 phase 1: valley, lakes with reflection, ringed-planet sky, chime trees, object travel, Trip fold fix
   - screensaver mode
   - **fire layer** (ambience, off by default): procedural crackle, pops, roar and hiss (`src/audio/nature/fire/FireSynth.ts`), fanned by wind gusts and sizzling in rain. Its dial is Fire in the Ambience cluster (0 = off), with Crackle, Roar and Tone under More. In the world it shows as embers rising around the object (pops kick them) and a faint warm glow in the fog. New vibes: "Hearth" (Calm) and "Campfire under the planet" (Moody); Surprise me lights a fire 25% of the time. **Unheard: tuned by measurement only.**

## 2. The user and how to work with them

- **Ask before designing.** They want to be asked, not guessed at. Offer a recommendation with each question. They answer tersely ("c", "yes", "lets do it").
- **Be honest and push back** (their standing preference). Say what's unverified. Don't flatter.
- **Casual tone, concise.** A little swearing is fine; never "fuck".
- **They make decisions from screenshots.** Send renders at each milestone.
- **They have not reported listening to anything built in session 2**, and they have never given an fps number. Everything musical has been tuned by measurement only. Keep asking for both, briefly.

## 3. Map of the code

| Path | What |
|---|---|
| `src/audio/world/WorldSynth.ts` | All layers in one worklet; bus: Blend and the ambience "support" dip under music |
| `src/audio/music/MusicSynth.ts` | Composer (chords, voicings, pedal, free/loops/pulse rhythms, Breath) plus pad and FM keys |
| `src/audio/music/voices.ts` | Drone, Bowls, Plucks (Karplus–Strong), Piano, Choir (formants), Beat (lo-fi), Shimmer, Biquad |
| `src/audio/music/fx.ts` | Looper (sound-on-sound), Tape (Age), Granular (Texture) |
| `src/audio/music/scales.ts` | `buildScale` (root, family, Light → mode, Purity → just intonation, 432 Hz) |
| `src/audio/nature/*` | Rain, wind, chimes (session 1); fire (session 2, `fire/FireSynth.ts`) |
| `spikes/sandbox/main.ts` | UI: dial clusters (Mood, Movement, Instruments, Perform, Ambience), Advanced drawer, vibes, Surprise me, screensaver |
| `spikes/sandbox/scenes.ts` | Vibes (`SCENES`), `randomVibe`, state ↔ worklet patch, the Space and Purity macros |
| `spikes/sandbox/view3d.ts` | The view: object, event → visual mapping, travel and camera, post (feedback, fold, bloom), flash guard |
| `spikes/sandbox/world.ts` / `worldShaders.ts` | Path, distance field, height bake, terrain grids, water and reflection, sky, chime trees |
| `spikes/sandbox/shaders.ts` | Object, particles, rain and haze, post shaders |
| `spikes/sandbox/flash.ts` | WCAG 2.3.1 flash meter (runtime guard and tests) |
| `spikes/sandbox/dials.ts` | Accessible dials (a native range input under a drawn ring) |
| `spikes/lab/` | The Lab (uses `scenes.ts`) |

## 4. Build, test, verify

- `npm test`: 66 tests, about 3 minutes; the Lab render test is the slow one (300 s timeout).
- `npm run build:artifact` → `dist-artifact/sandbox.html` (about 777 KB, single file).
- `node scripts/flash-check.mjs`: renders the real scene on a fixed clock with worst-case event bursts. A deliberate strobe control **must fail** (it proves the meter works); every other scenario must stay at 3 flashes/s or below. Run it after any visual change.
- `node scripts/visual-preview.mjs <outDir> [trip] [w] [h] [ui]`: deterministic stills. Environment variables: `SHOTS=40,90`, `SCALE=0.7`, `THETA=0.8` (jump along the path; 0 = the Tarn, about 0.17 = a chime tree, 0.8 = meadows), `HIDE=shell,cage,core,terrain,lake,sky,rain,haze,trees`, `TAG`.
- `node scripts/visual-check.mjs <outDir> <sec>`: a real-time run with audio (checks for console errors).
- **This container has software GL only (SwiftShader, about 0.5–2 fps).** Real frame rates can't be measured here; use fixed-step renders. It auto-selects the Low quality tier. Screenshots of 960×540 take about 1 minute; run them in parallel.
- **Test hooks** on `window.__tarnVisual`: `pinScale`, `step(dt)`, `measureEveryProbe`, `debugStrobe`, `hide`, `teleport(theta)`, `stats()`.
- **Gotchas:**
  - `AudioWorkletNode.disconnect()` doesn't stop a processor; post `{type:'stop'}` first.
  - Artifacts only allow inline code (three is bundled) and downloads are inert.
  - Any particle or point visual must stay at 1.5 px or larger with conserved energy, or it shimmers and trips the flash meter.

## 5. Not verified yet (be upfront about these)

- Real-GPU frame rate, especially the world with its reflection pass (a second scene render).
- Every sound from session 2: the new voices, beat, processors, vibes. Levels are matched by measurement only.
- A screen reader actually run on the dials (structure only has been checked).
- Whether fullscreen engages inside the claude.ai artifact frame. The screensaver falls back to just hiding the UI.
- The mist thickness over the valley floor, and straight-looking lake edges from low angles.

## 6. Next steps (recommended order)

1. **Get the user's reaction** to world v2 and their fps (`__tarnVisual.stats()` in the console). Ask what sounds worst in "Deep rest" and "Rain study".
2. **World Phase 2 (agreed):**
   - instanced grass, bushes and conifers pushed by the real wind values
   - streams and waterfalls into the lakes
   - snowfall for cold vibes
   - rain splashes on land
   - quality tiers: Low/Medium/High selectable, plus auto-upgrade
3. **World Phase 3 (agreed concept): the Perform processors glitch the world.**

   | Processor | What it does to the world |
   |---|---|
   | Freeze | Time stops (partly done: rain, travel, water) |
   | Layers | Ghost echoes of trees and ridges |
   | Age | VHS wear, and terrain dissolving into wireframe |
   | Texture | Surfaces break into grains or fireflies |
   | Trip | Mirrored mountains in the sky |

   Also a world preset per vibe: time of day, snowline, palette.
4. **Phase 4:** wildlife (bird flocks responding to plucks, fish, a deer).
5. **Audio tuning** by ear, once the user listens (see §8).

## 7. Decisions on record

- Desktop first; non-commercial; rain fully synthetic.
- Layers are Rain, Wind, Chimes, Fire (the ambience) plus Music. Fire is optional and off unless a vibe or the dial turns it on.
- Visual direction (PLAN D10): a synaesthetic object plus floating dials.
- Dials replace the old layer strips; every control is also in Advanced.
- The kaleidoscope appears only at high Trip; Trip defaults to 60 (each vibe now suggests its own).
- **Music drives the object; ambience drives the background**; chimes belong to the ambience.
- Lo-fi beats are optional and mostly soft. 432 Hz and binaural beats are optional, labelled as weak-evidence extras. No solfeggio.
- **World:** hybrid art direction (painterly solids with glowing contour accents); the references are a ringed planet over crystalline snow peaks, and teal alien shores with turquoise shallows. The object glides, rolls and bounces along a path, and the camera follows. The Perform processors glitch reality.
- **Screensaver:** a button or the H key; Esc, H or the exit pill leaves it; it starts automatically after 3 idle minutes while playing (can be switched off in Advanced; remembered per browser).

## 8. Parked audio work (from Lab feedback, round 1, 2026-09-28)

These predate music v2 but still apply to the ambience:
- **Bug, fixed:** disconnected synth nodes kept rendering. Any "static / hiss" tags from before that fix are suspect.
- **Measured:** the far rain wash is surface-blind (leaves, grass and stone sound like the same hiss).
- **Opinions to act on:**
  - Water bubbles squeak high.
  - Wind leaves are too regular and "ticky".
  - Too loud: gale, whistle, downpour, wood and bright chimes.
  - Liked: drizzle, light breeze and glass.
- The instrument idea list (rain drum, Aeolian harp, shishi-odoshi, singing bowls…) is in **docs/INSTRUMENT-IDEAS.md**.
