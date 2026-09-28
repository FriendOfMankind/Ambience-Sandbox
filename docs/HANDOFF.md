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

## Idea list: ambient instruments to add (and show in 3D)

Requested at the end of the session. **Not web-researched:** web search hit its spend limit, so this comes from general knowledge. Verify the instrument details before building.

The strongest ideas are **driven by the world state that already exists** (rain events, wind speed and gusts, the key), so they play *themselves* and belong to the place rather than being pasted on. A second design idea: **the instruments can be the floating "dials"** around the central 3D object. Click the rain drum to open its controls.

### Tier 1: coupled to rain or wind, reuses existing engine parts

| Instrument | What it is | How it would play | Synthesis (reuse) | 3D representation |
|---|---|---|---|---|
| **Rain drum** (tongue drum left in the rain) | A steel tongue drum whose tongues are tuned to a scale | Rain's near-drop events strike random tongues; heavier rain means more notes. Always in key | Modal tongues via `ResonatorBank`, triggered by `RainEvent`s | A drum whose tongues light up (pitch → hue) as drops land on them |
| **Shishi-odoshi** (bamboo deer-scarer fountain) | A bamboo seesaw that fills with water, tips and knocks a stone | A hollow "tok" whose rhythm comes from the rain rate or stream flow; more water, faster knocks | A wood-knock modal hit, plus a water pour from the drop synth | A bamboo tube slowly filling (visible water level), tipping, splashing |
| **Suikinkutsu** (Japanese buried water harp) | An upturned buried pot; drips fall inside and ring like tiny bells, with echo | Drips from rain or a slow seeded rhythm | Existing bubble synth + a resonant cavity (comb filter or modal) | Droplets falling into a glowing underground chamber, with rings spreading on the inner water |
| **Rain chain** | A chain of cups down a gutter; water cascades cup to cup | Each cascade plays a falling run of pitched plinks, triggered by rain rate | Drop/bubble synth with pitch per cup and small delays | A vertical chain; water visibly steps down cup by cup |
| **Aeolian harp** (wind harp) | Strings that the wind makes sing; stronger wind brings out higher harmonics | Driven entirely by wind speed and gusts: partials bloom and fade with the wind | Harmonic partial bank whose active harmonic follows wind speed | Strings vibrating, with glowing standing-wave nodes; gusts ripple along them |
| **Bamboo / wooden chimes** | Hollow, dry, clacky chimes | Same wind clapper as the metal chimes | `ChimeSynth` with short, damped "wood" modes (mostly a material preset) | Bamboo tubes knocking together |
| **Rainstick** | A tube of pebbles cascading over internal pins | Slow cascades on gust peaks, or as a transition sound between scenes | Particle cascade of tiny clicks (like rain near-drops, with no bubbles) | A slowly turning tube, pebbles visible as streaming particles inside |

### Tier 2: musical voices for the music layer

| Instrument | Character | Synthesis | 3D representation |
|---|---|---|---|
| **Singing bowls / crystal bowls** | Long, beating, shimmering tones; slightly split mode pairs make the "wah-wah" | Modal pairs detuned by a few Hz; strike or slow "rubbed" swell | A bowl whose surface shows standing-wave ripple patterns |
| **Handpan** | Warm, bell-like notes arranged around a central low note | Modal notes with the characteristic octave and fifth partials; generative patterns | A dome with note fields lighting in turn |
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

### Suggested order

1. **Rain drum.** Smallest step (ResonatorBank + RainEvents already exist) and the most on-brand. It turns rain into melody by construction.
2. **Aeolian harp.** Makes the wind musical the way the chimes did, and suits a 3D string visual.
3. **Shishi-odoshi.** Its rhythm follows rain, and it gives the scene a clear visual "clock".
4. **Singing bowls**, as a calmer alternative to the pad in Focus mode.

Each new instrument should follow the existing pattern: a pure-DSP class, events + per-layer level reported through `WorldSynth`, a strip or dial in the UI, and unit tests for determinism, bounds and "is it in key".
