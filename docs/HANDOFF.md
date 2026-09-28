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

## Tarn Lab (added after the first version of this handoff)

`spikes/lab/`: a listening test bench with 30 isolated tests (start here: tin, glass, leaves), ratings, problem tags, level/tone/density nudges, tweakable sliders, and a pasteable **Report**. Build with `npm run build:lab`. Tests are defined in `spikes/lab/tests.ts`; `tests/lab.test.ts` renders each one headlessly.

Objective levels measured while building it (20 s renders, RMS / peak before the limiter): the spread is large, and several tests are far too hot. Gale wind peaks at +15 dBFS, tin at +6, wind whistle at +5, bright chimes at +2.5, and scenes 2 (Storm), 3 and 6 at +8, +3 and +3.5. Drizzle sits at −44 dB RMS and Wind chimes (bronze) at −38 dB. Nothing has been level-calibrated across layers, so treat these as the first things to fix once listening feedback is in.

## Lab feedback, round 1 (2026-09-28) and what was found

19 of 30 tests were rated on desktop speakers. Findings, separating measured fact from listening opinion:

- **Bug (fixed): disconnected synth nodes kept rendering.** `node.disconnect()` does not stop an AudioWorklet processor, so every test switched away from kept a full `WorldSynth` running in the audio thread. After ~20 switches that is enough load to cause dropouts, which sound like static on *everything*, including layers whose offline render is clean (music pad: 4–8 kHz at −97 dB; chimes: silent between strikes). Fix: `world.worklet` now handles `{type:'stop'}` by returning `false` from `process()`, and the Lab and the sandbox's re-seed post it before disconnecting. Verified in Chromium: after 9 node switches only one processor is still posting. **Any "static / hiss" tag on chimes, pad, or wind from before this fix is suspect and should be re-rated.**
- **Real (measured, independent of the bug): the far-tier wash is surface-blind.** `renderFar` is pink noise through fixed filters, its level depends only on rain rate. At 6 mm/h it sits at about −35 dB RMS for every surface, while the actual drops on grass are ~28 dB below it (mid/near ≈ −63 dB), stone ~11 dB below, leaves ~5 dB below. So leaves, grass and stone tests are mostly the same generic hiss (spectra match to within 1 dB), which lines up with the "static / hiss, thin" tags. Tin's drops sit above the wash, and it wasn't flagged for the drops themselves.
- **Listening opinions to act on:** rain on water is a little high-pitched with "wet rubber squeaks" (bubble pitch/glide; rain-in-key is "too high pitched" too). Wind leaves sound like cards shuffling / a guiro scraped along a frog's back (the flutter clicks are too regular and ticky). Gale is too loud and harsh (RMS −7 dB, limiter touching); whistle too loud; downpour too loud; wood and bright chimes too loud. Drizzle 5/5 and light breeze 5/5. Glass 4/5 and 5/5 pleasant.
- Not yet heard: music keys / both / Lydian and all 8 scenes.

## Suggested next steps

1. Get listening feedback through the Lab on the new tin, glass and leaves, and on wind, chimes and music, then tune.
2. Design pass for the 3D synaesthetic object and floating dials: per-layer visual grammar, Focus-mode calming, reduced motion, flash safety, and keyboard/screen-reader access for the dials. Prototype in Three.js/WebGL, driven by `WorldSynth` events and features.
3. Scene morphing (parameter interpolation) and loudness-matched scenes.
4. Save/share: URL-encoded world + seed (PLAN §7.8).

## Idea list: ambient instruments to add (and show in 3D)

Requested at the end of the session. First written from general knowledge while web search was unavailable, then checked against sources once search came back (see "Verified notes" below). The tables are design ideas; the notes are the facts they rest on.

The strongest ideas are **driven by the world state that already exists** (rain events, wind speed and gusts, the key), so they play *themselves* and belong to the place rather than being pasted on. A second design idea: **the instruments can be the floating "dials"** around the central 3D object. Click the rain drum to open its controls.

### Tier 1: coupled to rain or wind, reuses existing engine parts

| Instrument | What it is | How it would play | Synthesis (reuse) | 3D representation |
|---|---|---|---|---|
| **Rain drum** (tongue drum left in the rain) | A steel tongue drum whose tongues are tuned to a scale. Real ones in real rain mostly sound like rain on metal; the melodic viral videos are usually dubbed (see notes) | Rain's near-drop events strike random tongues; heavier rain means more notes. Always in key. We can build the *imagined* version, which is a sandbox strength | Modal tongues via `ResonatorBank`, triggered by `RainEvent`s | A drum whose tongues light up (pitch → hue) as drops land on them |
| **Shishi-odoshi** (bamboo deer-scarer fountain) | A bamboo seesaw that fills with water, tips and knocks a stone | A hollow "tok" whose rhythm comes from the rain rate or stream flow; more water, faster knocks | A wood-knock modal hit, plus a water pour from the drop synth | A bamboo tube slowly filling (visible water level), tipping, splashing |
| **Suikinkutsu** (Japanese buried water harp) | An upturned buried pot; drips fall inside and ring like tiny bells, with echo | Drips from rain or a slow seeded rhythm | Existing bubble synth + a resonant cavity (comb filter or modal) | Droplets falling into a glowing underground chamber, with rings spreading on the inner water |
| **Rain chain** | A chain of cups down a gutter; water cascades cup to cup | Each cascade plays a falling run of pitched plinks, triggered by rain rate | Drop/bubble synth with pitch per cup and small delays | A vertical chain; water visibly steps down cup by cup |
| **Aeolian harp** (wind harp) | Strings that the wind makes sing; the wind excites whichever harmonic is nearest the vortex-shedding frequency | Driven entirely by wind speed and gusts: as the wind changes, the sounding harmonic hops up and down the series, and it goes quiet outside its speed range | Harmonic partial bank; excite the harmonic nearest f = 0.2·u/d (u = wind speed, d = string diameter) | Strings vibrating, with glowing standing-wave nodes; gusts ripple along them |
| **Bamboo / wooden chimes** | Hollow, dry, clacky chimes | Same wind clapper as the metal chimes | `ChimeSynth` with short, damped "wood" modes (mostly a material preset) | Bamboo tubes knocking together |
| **Rainstick** | A tube of pebbles cascading over internal pins | Slow cascades on gust peaks, or as a transition sound between scenes | Particle cascade of tiny clicks (like rain near-drops, with no bubbles) | A slowly turning tube, pebbles visible as streaming particles inside |

### Tier 2: musical voices for the music layer

| Instrument | Character | Synthesis | 3D representation |
|---|---|---|---|
| **Singing bowls / crystal bowls** | Long, beating, shimmering tones; asymmetry splits each mode into two close frequencies, and their beating is the "wah-wah" | Each mode as a pair detuned by a few Hz; strike or slow "rubbed" swell | A bowl whose surface shows standing-wave ripple patterns |
| **Handpan** | Warm, bell-like notes arranged around a central low note (the "ding") | Three partials per note at about 1:2:3 (fundamental, octave, compound fifth); generative patterns | A dome with note fields lighting in turn |
| **Kalimba / music box** | Plucked tines; delicate melodic fragments | Plucked modal tines; a seeded melody "cylinder" | A rotating pin cylinder plucking a comb; the cylinder *is* the melody, readable at a glance |
| **Glass harmonica / wine glasses** | Pure, glassy sustained tones with slow attack | Near-sine partials with slow swell | Rotating glass bowls with light refracting as they sound |
| **Shruti box / drone reeds** | A breathing harmonium drone | Reed-like wave through formant filters; the "bellows" follow wind or a slow breath | Bellows expanding and contracting in time with the sound |
| **Gong / tam-tam swells** | Slow, blooming shimmer; good for scene transitions | Modal bank with gradual energy transfer to upper partials | A disc whose surface shimmers outward from the strike point |
| **Distant cowbells** (fits the alpine Tarn) | A herd wandering on the far hillside | Short bell modal hits, distance-filtered, slowly wandering in stereo | Faint lights moving along the far slope |

### Tier 3: strange mode, for the "unrestricted sandbox"

| Instrument | Character | 3D representation |
|---|---|---|
| **Waterphone** | Bowed metal rods over a water-filled body: eerie, gliding, horror-film tones | A spiky crown whose rods glow and bend as they sound |
| **Spring drum / "thunder tube"** | Boingy, dispersive thunder-like sweeps; could *be* the thunder in strange storms | A coiled spring with a wave travelling along it |
| **Lithophone** (stone xylophone) | Dry, pitched stone clicks | Floating stones that ring when touched |
| **Insect / frog chorus as rhythm** | Polyrhythmic natural pulses locked (or not) to the music's tempo | Swarms of lights pulsing in rhythmic groups |

### Verified notes (sources)

- **Rain drum.** Outdoor "rain drums" are small, high-tuned steel tongue drums. A luthier's write-up says real rain on one sounds like rain on a metal roof, not melodies; viral clips are usually dubbed with mallet recordings. Our design should aim for the imagined version, and say so. [Hluru: do rain drums work in the rain?](https://www.hluru.net/en-us/blogs/skills-tips/do-rain-drums-work-in-the-rain-a-luthiers-truth-behind-the-viral-trend), [Hluru: what is an outdoor rain drum](https://www.hluru.net/en-us/blogs/skills-tips/what-is-an-outdoor-rain-drum-a-garden-guide-to-natures-rhythm)
- **Suikinkutsu.** An upside-down buried pot with a hole on top. Water drips onto a small pool inside, and the chamber rings "like a bell or a Japanese zither". No two sound the same. [Wikipedia](https://en.wikipedia.org/wiki/Suikinkutsu)
- **Shishi-odoshi.** A bamboo tube on an off-centre pivot fills from a trickle, tips once it's top-heavy, empties, then falls back and knocks a rock. The knock interval is set by the water flow, so coupling it to rain rate is physically right. [Wikipedia](https://en.wikipedia.org/wiki/Shishi-odoshi)
- **Aeolian harp.** Wind shedding vortices off a string (a von Kármán vortex street) makes it vibrate. Shedding frequency ≈ 0.2·u/d, and it excites the string harmonic nearest that frequency, so you usually hear a harmonic, not the fundamental. Each string only sounds within a band of wind speeds; wind-induced vibration is typically at 1–7 m/s. [Wikipedia](https://en.wikipedia.org/wiki/Aeolian_harp), [Geophysical Institute](https://www.gi.alaska.edu/alaska-science-forum/aeolian-harp), [real-time physical model paper](https://www.researchgate.net/publication/319664701_REAL-TIME_PHYSICAL_MODEL_OF_AN_AEOLIAN_HARP)
- **Singing bowls.** Asymmetry splits each vibration mode into two close frequencies (a few Hz apart), and their beating is the characteristic pulsing. [Terwagne & Bush, "Tibetan singing bowls" (arXiv)](https://arxiv.org/pdf/1106.6348)
- **Handpan.** Each tone field is tuned so three resonances line up near 1:2:3 (fundamental, octave, compound fifth); a detuned partial dulls the note or makes it beat. [Hang (instrument), Wikipedia](https://en.wikipedia.org/wiki/Hang_(instrument)), [Tapadum overtone guide](https://tapadum.com/handpan-tuner-free-online-overtone-analyzer/)
- **Rainstick.** A hollow cactus branch with spines driven inward as a lattice, filled with pebbles, rice or beans. The rain sound is a chain of many small impacts as the filler trickles past the spines. [Wikipedia](https://en.wikipedia.org/wiki/Rainstick), [Exploratorium](https://www.exploratorium.edu/snacks/make-your-own-rainstick)
- **Waterphone.** A stainless-steel resonator with a little water inside, ringed by bronze rods of different lengths tuned in mixed microtonal and diatonic relationships. It is bowed or struck, and tilting shifts the water so pitches bend and wobble. Invented by Richard Waters; a horror-film staple. [Wikipedia](https://en.wikipedia.org/wiki/Waterphone)
- Not yet checked: ocean drum, rain chain, Koshi chimes, shruti box, gong, glass harmonica, lithophone, cowbells. Their table entries are general knowledge.

### Suggested order

1. **Rain drum.** Smallest step (ResonatorBank + RainEvents already exist) and the most on-brand. It turns rain into melody by construction.
2. **Aeolian harp.** Makes the wind musical the way the chimes did, and suits a 3D string visual.
3. **Shishi-odoshi.** Its rhythm follows rain, and it gives the scene a clear visual "clock".
4. **Singing bowls**, as a calmer alternative to the pad in Focus mode.

Each new instrument should follow the existing pattern: a pure-DSP class, events + per-layer level reported through `WorldSynth`, a strip or dial in the UI, and unit tests for determinism, bounds and "is it in key".
