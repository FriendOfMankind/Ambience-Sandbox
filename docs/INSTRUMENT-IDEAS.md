# Idea list: ambient instruments to add (and show in 3D)

Requested at the end of the session. First written from general knowledge while web search was unavailable, then checked against sources once search came back (see "Verified notes" below). The tables are design ideas; the notes are the facts they rest on.

The strongest ideas are **driven by the world state that already exists** (rain events, wind speed and gusts, the key), so they play *themselves* and belong to the place rather than being pasted on. A second design idea: **the instruments can be the floating "dials"** around the central 3D object. Click the rain drum to open its controls.

## Tier 1: coupled to rain or wind, reuses existing engine parts

| Instrument | What it is | How it would play | Synthesis (reuse) | 3D representation |
|---|---|---|---|---|
| **Rain drum** (tongue drum left in the rain) | A steel tongue drum whose tongues are tuned to a scale. Real ones in real rain mostly sound like rain on metal; the melodic viral videos are usually dubbed (see notes) | Rain's near-drop events strike random tongues; heavier rain means more notes. Always in key. We can build the *imagined* version, which is a sandbox strength | Modal tongues via `ResonatorBank`, triggered by `RainEvent`s | A drum whose tongues light up (pitch → hue) as drops land on them |
| **Shishi-odoshi** (bamboo deer-scarer fountain) | A bamboo seesaw that fills with water, tips and knocks a stone | A hollow "tok" whose rhythm comes from the rain rate or stream flow; more water, faster knocks | A wood-knock modal hit, plus a water pour from the drop synth | A bamboo tube slowly filling (visible water level), tipping, splashing |
| **Suikinkutsu** (Japanese buried water harp) | An upturned buried pot; drips fall inside and ring like tiny bells, with echo | Drips from rain or a slow seeded rhythm | Existing bubble synth + a resonant cavity (comb filter or modal) | Droplets falling into a glowing underground chamber, with rings spreading on the inner water |
| **Rain chain** | A chain of cups down a gutter; water cascades cup to cup | Each cascade plays a falling run of pitched plinks, triggered by rain rate | Drop/bubble synth with pitch per cup and small delays | A vertical chain; water visibly steps down cup by cup |
| **Aeolian harp** (wind harp) | Strings that the wind makes sing; the wind excites whichever harmonic is nearest the vortex-shedding frequency | Driven entirely by wind speed and gusts: as the wind changes, the sounding harmonic hops up and down the series, and it goes quiet outside its speed range | Harmonic partial bank; excite the harmonic nearest f = 0.2·u/d (u = wind speed, d = string diameter) | Strings vibrating, with glowing standing-wave nodes; gusts ripple along them |
| **Bamboo / wooden chimes** | Hollow, dry, clacky chimes | Same wind clapper as the metal chimes | `ChimeSynth` with short, damped "wood" modes (mostly a material preset) | Bamboo tubes knocking together |
| **Rainstick** | A tube of pebbles cascading over internal pins | Slow cascades on gust peaks, or as a transition sound between scenes | Particle cascade of tiny clicks (like rain near-drops, with no bubbles) | A slowly turning tube, pebbles visible as streaming particles inside |

## Tier 2: musical voices for the music layer

| Instrument | Character | Synthesis | 3D representation |
|---|---|---|---|
| **Singing bowls / crystal bowls** | Long, beating, shimmering tones; asymmetry splits each mode into two close frequencies, and their beating is the "wah-wah" | Each mode as a pair detuned by a few Hz; strike or slow "rubbed" swell | A bowl whose surface shows standing-wave ripple patterns |
| **Handpan** | Warm, bell-like notes arranged around a central low note (the "ding") | Three partials per note at about 1:2:3 (fundamental, octave, compound fifth); generative patterns | A dome with note fields lighting in turn |
| **Kalimba / music box** | Plucked tines; delicate melodic fragments | Plucked modal tines; a seeded melody "cylinder" | A rotating pin cylinder plucking a comb; the cylinder *is* the melody, readable at a glance |
| **Glass harmonica / wine glasses** | Pure, glassy sustained tones with slow attack | Near-sine partials with slow swell | Rotating glass bowls with light refracting as they sound |
| **Shruti box / drone reeds** | A breathing harmonium drone | Reed-like wave through formant filters; the "bellows" follow wind or a slow breath | Bellows expanding and contracting in time with the sound |
| **Gong / tam-tam swells** | Slow, blooming shimmer; good for scene transitions | Modal bank with gradual energy transfer to upper partials | A disc whose surface shimmers outward from the strike point |
| **Distant cowbells** (fits the alpine Tarn) | A herd wandering on the far hillside | Short bell modal hits, distance-filtered, slowly wandering in stereo | Faint lights moving along the far slope |

## Tier 3: strange mode, for the "unrestricted sandbox"

| Instrument | Character | 3D representation |
|---|---|---|
| **Waterphone** | Bowed metal rods over a water-filled body: eerie, gliding, horror-film tones | A spiky crown whose rods glow and bend as they sound |
| **Spring drum / "thunder tube"** | Boingy, dispersive thunder-like sweeps; could *be* the thunder in strange storms | A coiled spring with a wave travelling along it |
| **Lithophone** (stone xylophone) | Dry, pitched stone clicks | Floating stones that ring when touched |
| **Insect / frog chorus as rhythm** | Polyrhythmic natural pulses locked (or not) to the music's tempo | Swarms of lights pulsing in rhythmic groups |

## Verified notes (sources)

- **Rain drum.** Outdoor "rain drums" are small, high-tuned steel tongue drums. A luthier's write-up says real rain on one sounds like rain on a metal roof, not melodies; viral clips are usually dubbed with mallet recordings. Our design should aim for the imagined version, and say so. [Hluru: do rain drums work in the rain?](https://www.hluru.net/en-us/blogs/skills-tips/do-rain-drums-work-in-the-rain-a-luthiers-truth-behind-the-viral-trend), [Hluru: what is an outdoor rain drum](https://www.hluru.net/en-us/blogs/skills-tips/what-is-an-outdoor-rain-drum-a-garden-guide-to-natures-rhythm)
- **Suikinkutsu.** An upside-down buried pot with a hole on top. Water drips onto a small pool inside, and the chamber rings "like a bell or a Japanese zither". No two sound the same. [Wikipedia](https://en.wikipedia.org/wiki/Suikinkutsu)
- **Shishi-odoshi.** A bamboo tube on an off-centre pivot fills from a trickle, tips once it's top-heavy, empties, then falls back and knocks a rock. The knock interval is set by the water flow, so coupling it to rain rate is physically right. [Wikipedia](https://en.wikipedia.org/wiki/Shishi-odoshi)
- **Aeolian harp.** Wind shedding vortices off a string (a von Kármán vortex street) makes it vibrate. Shedding frequency ≈ 0.2·u/d, and it excites the string harmonic nearest that frequency, so you usually hear a harmonic, not the fundamental. Each string only sounds within a band of wind speeds; wind-induced vibration is typically at 1–7 m/s. [Wikipedia](https://en.wikipedia.org/wiki/Aeolian_harp), [Geophysical Institute](https://www.gi.alaska.edu/alaska-science-forum/aeolian-harp), [real-time physical model paper](https://www.researchgate.net/publication/319664701_REAL-TIME_PHYSICAL_MODEL_OF_AN_AEOLIAN_HARP)
- **Singing bowls.** Asymmetry splits each vibration mode into two close frequencies (a few Hz apart), and their beating is the characteristic pulsing. [Terwagne & Bush, "Tibetan singing bowls" (arXiv)](https://arxiv.org/pdf/1106.6348)
- **Handpan.** Each tone field is tuned so three resonances line up near 1:2:3 (fundamental, octave, compound fifth); a detuned partial dulls the note or makes it beat. [Hang (instrument), Wikipedia](https://en.wikipedia.org/wiki/Hang_(instrument)), [Tapadum overtone guide](https://tapadum.com/handpan-tuner-free-online-overtone-analyzer/)
- **Rainstick.** A hollow cactus branch with spines driven inward as a lattice, filled with pebbles, rice or beans. The rain sound is a chain of many small impacts as the filler trickles past the spines. [Wikipedia](https://en.wikipedia.org/wiki/Rainstick), [Exploratorium](https://www.exploratorium.edu/snacks/make-your-own-rainstick)
- **Waterphone.** A stainless-steel resonator with a little water inside, ringed by bronze rods of different lengths tuned in mixed microtonal and diatonic relationships. It is bowed or struck, and tilting shifts the water so pitches bend and wobble. Invented by Richard Waters; a horror-film staple. [Wikipedia](https://en.wikipedia.org/wiki/Waterphone)
- Not yet checked: ocean drum, rain chain, Koshi chimes, shruti box, gong, glass harmonica, lithophone, cowbells. Their table entries are general knowledge.

## Suggested order

1. **Rain drum.** Smallest step (ResonatorBank + RainEvents already exist) and the most on-brand. It turns rain into melody by construction.
2. **Aeolian harp.** Makes the wind musical the way the chimes did, and suits a 3D string visual.
3. **Shishi-odoshi.** Its rhythm follows rain, and it gives the scene a clear visual "clock".
4. **Singing bowls**, as a calmer alternative to the pad in Focus mode.

Each new instrument should follow the existing pattern: a pure-DSP class, events + per-layer level reported through `WorldSynth`, a strip or dial in the UI, and unit tests for determinism, bounds and "is it in key".
