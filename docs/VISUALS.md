# Tarn visuals: design and prototype

Status: first prototype, built 2026-09-28 (PLAN D10). The per-layer grammar below was agreed with the user before building. Answers they gave: the dials replace the layer strips, the kaleidoscope appears only at high Trip, and Trip defaults to 60.

## Rule

Every bright or fast thing on screen is caused by a sound event. Slow ambient drift is the only motion without a cause. The visuals read the engine's per-sound events and features (`WorldEvents`, `WorldFeatures`), never a mixed FFT.

## Grammar

| Layer | Owns | Event → visual | Feature → visual |
|---|---|---|---|
| Music | The object | Chord: new shape family (a harmonic "pose" per scale step) morphing over 3–8 s; the palette re-centres on the root's pitch hue; the attractor core drifts between Aizawa and Thomas dynamics. Note: a node lights up on the skin (longitude = pitch class, latitude = octave) and a ring travels out from it; the core speeds up briefly | Level: breathing and line brightness |
| Chimes | Rods around the object and the object's skin | Strike: the rod glows in its pitch hue and that tube's cymatic (Chladni-style) nodal pattern rings across the skin, decaying with the tube's ring time | Wind: the rods sway and lean |
| Rain | The lake and the air | Near drop: a ripple on the lake (x = pan, size = diameter). Surface sets the character: water gives double rings, leaves/grass soft splats, stone/tin/glass sharp fast ticks, "Bells" rings in the bubble's pitch hue | Rain rate: streak density and a wetter, glossier landscape |
| Wind | The air | (none: wind is continuous) | Speed: curl-noise haze, aurora in the sky, how fast the trails swirl. Gust: bends the object downwind and domain-warps the contour hills |

Pitch class → hue is shared everywhere (`pitchHue`), so the same note is the same colour whether it's a chime, a key or a bell drop.

## Rendering

- Three.js (WebGL2), bundled into the artifact (the page is ~670 KB).
- **Background layer:** sky (domain-warped nebula plus wind aurora), contour-line hills (ridged noise, lines fade before they alias), the lake (ripples plus a dimmed, mirrored copy of the object as its reflection), rain streaks and haze.
- **Object layer:** the shell (a thin-film sheen plus topographic contour lines of its own radius, echoing the hills), a geodesic wireframe cage, the attractor core (65k GPU particles) and the chime rods.
- **Post:** the object layer goes through a feedback buffer (MilkDrop-style: last frame zoomed, rotated, warped and hue-turned, blended with *lighten* so trails never add up), is composited over the background, bloomed, then finished: a kaleidoscope fold above Trip 80, chromatic aberration, vignette, ACES tone map, grain.
- **Trip (0–100)** scales warp, trail length, saturation, bloom and aberration. Reduced motion caps it at 35.

## Safety and access

- **Flash (WCAG 2.3.1):** chime light has a ~150 ms attack and releases no faster than 0.6 s, so strikes can't strobe. Total chime light is capped. Palette and shape changes take seconds. Trails use lighten, not add. At runtime a `FlashMeter` (`spikes/sandbox/flash.ts`) watches a 64×36 copy of every third frame, split into overlapping regions of about a ninth of the screen (a stand-in for WCAG's 25%-of-10°-field area). If any region approaches 3 flashes/s, event light is turned down until it settles.
- **Verified by:** `tests/flash.test.ts` (the meter flags 5 Hz strobes and red flashes, and passes 2 Hz strobes and slow breathing), and `scripts/flash-check.mjs`. That script runs the real renderer on a fixed clock with worst-case bursts (12 chime strikes/s, 8 notes/s plus a chord every 1.5 s, 40 drops per 1/20 s, all at once at Trip 100, and all at once with reduced motion). It also runs a deliberately unsafe strobe as a control, which must fail. Results: see the handoff.
- **Reduced motion** (OS setting or the "Motion" button, remembered per browser) turns off trails, the kaleidoscope, camera drift and rod sway. Rings fade in place instead of travelling, and morphs are slower.
- **Keyboard and screen readers:** every dial is a native `<input type="range">` under a drawn ring. Tab reaches them; arrows, Page Up/Down, Home and End work; labels and `aria-valuetext` read "Rain: 6.0 mm/h · steady". Each cluster is a labelled group. The focused dial shows a ring in its layer's colour. Focusing or hovering a cluster eases the camera toward that layer, and changing a value exaggerates that layer's visual for a moment ("as you edit, the shape morphs").
- Advanced (every control, as before) opens as a side panel; Escape closes it.

## Known limits

- **Frame rate is unverified on a real GPU.** The container only has software GL (0.5 fps at 1440×860), so all screenshots are fixed-step renders. The view adapts its render scale (0.5× to 1.5×) to hold ~60 fps; the vertex work (shell, terrain, haze) is the part to watch on integrated GPUs.
- The hills read more as a ring of contour bands than as mountains from the default camera.
- Screen-reader behaviour has been checked for structure (labels, roles, value text), not with an actual screen reader.
- On narrow screens (under 820 px) the dials dock into a bottom sheet rather than floating.
