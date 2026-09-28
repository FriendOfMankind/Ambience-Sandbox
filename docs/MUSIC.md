# Tarn music engine v2

Status: built 2026-09-28, **not yet heard by the user**. Levels are matched by measurement only (Claude can't hear); everything musical needs listening rounds.

## The split

- **Music** (drives the object): a generative ensemble with mood and movement dials.
- **Ambience** (drives the background): rain, wind and chimes, sitting underneath.
- **Blend** sets the balance (0 = ambience only, 0.5 = both full, 1 = music only). **Support** makes the ambience step aside while music plays: a −6 dB dip around 900 Hz (wide) and up to −2.5 dB overall, scaled by how present the music is (`WorldSynth`, bus section).

## Research behind the choices

- **Calming music** tends to have legato articulation, slow-to-medium tempo (60–80 BPM in most studies), low rhythmic activity and a lower spectral centroid. Music that failed to help sleep had a clear pulse, syncopation or groove and bright high percussion (hats, ride). Sustained low drones and pads were common in music that worked. [Dickson & Schubert, *Musicae Scientiae*](https://journals.sagepub.com/doi/10.1177/1029864920972161)
  → Warmth darkens everything; the drone and pad are the floor; the beat is off by default and soft when on (felt kick, brushes, dusty hats, all low-passed).
- **Consonance** depends on how partials beat within a critical band (Plomp & Levelt's roughness curves). Just intonation removes most of that beating.
  → Purity slides diatonic scales from equal temperament to 5-limit just intonation; the drone only sounds harmonics that land on a scale degree.
- **Eno's systems music**: *Music for Airports* loops of incommensurate lengths (23.5 s, 25.9 s, 29.9 s…) that never realign, and "a silence at least twice as long as the sound". [Reverb Machine](https://reverbmachine.com/blog/deconstructing-brian-eno-music-for-airports/)
  → Rhythm "loops" mode; the Breath dial.
- **Weak evidence, offered only as options with honest labels:**
  - 432 Hz: one small pilot found slightly lower heart rate. A music psychologist's review finds no special effect. [PubMed](https://pubmed.ncbi.nlm.nih.gov/31031095/), [The Conversation](https://theconversation.com/does-432hz-tuning-improve-your-wellbeing-a-music-psychologist-unpacks-the-evidence-279759)
  - Binaural beats: mixed results with very high heterogeneity, weaker when masked by music, and headphones only. [review](https://pmc.ncbi.nlm.nih.gov/articles/PMC10198548/), [meta-analysis](https://www.sciencedirect.com/science/article/pii/S096522992500175X)
  - Solfeggio frequencies: no credible evidence found, so they are not included.

## Voices (`src/audio/music/voices.ts`, `MusicSynth.ts`)

| Voice | Technique | Role |
|---|---|---|
| Drone | Additive harmonic series on the key root (55–110 Hz), each partial breathing on its own 14–48 s cycle; only harmonics within 25 cents of a scale degree sound | Floor |
| Pad | Detuned PolyBLEP saws, breathing low-pass | Wash |
| Bowls | 3 modes (1 : 2.76 : 5.4) each a pair of damped sines 0.4–2.4 Hz apart (the beating "wah"); struck or rubbed | Sparse chord roots and fifths |
| Keys | 2-op FM | Melody (random walk preferring small steps) |
| Plucks | Karplus–Strong with an all-pass fractional delay | Broken chords |
| Choir | 3 PolyBLEP voices with vibrato and breath noise through 3 formants drifting oo → oh → ah → eh | Chord an octave up |
| Beat | Felt kick (110 → 45 Hz sine), brush snare (band-passed noise), dusty hats, vinyl crackle, soft saturation and low-pass | Optional |
| Shimmer | Octave-up pitch shifter with feedback on the reverb send | Space |

Measured solo levels at voice level 1 (30 s renders, RMS dBFS before the world gain): pad −32, keys −29, drone −35, bowls −38, plucks −49 (sparse; peaks −14), choir −34, beat −34. Everything together: about −25 dBFS RMS, −10 dB peak, **4.7% of one CPU core** in Node (the worklet adds the nature layers on top).

## Dials

- **Mood:** Light (Phrygian → Aeolian → Dorian → Mixolydian → Ionian → Lydian on one root; pentatonic flavours in that family), Purity (just ↔ equal ↔ detuned; also sets pad/choir detune), Warmth (overall brightness), Space (reverb length/size, music send, shimmer).
- **Movement:** Motion (notes per minute), Breath (rests between phrases, 0.15× to 2.75× the phrase length), Rhythm (free / loops / pulse), Tempo (40–100 BPM), Beat (off → heartbeat → brushes → soft lo-fi kit). Evolve (chord change rate) is in Advanced.
- **Instruments:** a level per voice.
- **Key:** root and family (modes, pentatonic, harmonic series, whole tone, 19-EDO, cluster) in the top bar; 432 Hz and binaural under Advanced → Tuning extras.

## Vibes

Deep rest, Temple, Morning light, Rain study (lo-fi), Night drift, Floating, Storm shelter, Strange weather, Near silence (ambience only). Defined in `spikes/sandbox/scenes.ts`.

## Tests

`tests/music.test.ts`: the scale builder (Light order, just ratios, 432 offset); every voice finite, bounded and in key in all three rhythm modes; determinism; pulse notes on the eighth grid; more breath gives fewer notes; silence when every voice is off; and a solo level/CPU report (`MEASURE=1`).

## Next (after the user listens)

Tune by ear: voice balance, bowl partials, choir formants, beat feel. Then the extras planned for later: a granular shimmer engine, handpan, and more instruments from the handoff list.
