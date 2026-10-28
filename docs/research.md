# Seafoam, stage 1: how games and films fake sea foam

Research notes for the Seafoam project. The project goal is to add stylized, low-detail foam to popular fluid
simulation algorithms. This stage asks one question: which techniques exist, and which of them are feasible for
us? The answer is backed by a working proof of concept in [`poc/`](../poc).

## Summary

- **Every technique we found splits into the same four parts.** A *source* decides where foam is born. A
  *persistence* step keeps it alive and moves it. A *decay* step removes it. A *look* step draws it.
  Productions differ mostly in the source and in the look.
- **The shared core is one equation**, a scalar foam amount `F` on the water surface:

  ```
  dF/dt + u·∇F = S − F/τ + D∇²F
  ```

  `S` is the source, `τ` the lifetime, `D` how fast foam spreads, and `u` the surface velocity that carries
  foam along. Real-time games solve it as a *feedback texture*: each frame they read last frame's foam,
  blur and fade it, then add new foam. Sea of Thieves describes exactly this ("blurred over time with
  feedback").
- **For FFT oceans the standard source is the Jacobian** of Tessendorf's choppy displacement. When the
  surface is squeezed (J < 1) a crest is forming. When it folds over itself (J < 0) the wave is breaking.
  Tessendorf, Crest, Atlas and Dupuy & Bruneton all use J. Sea of Thieves builds its "wave peak mask" from
  the FFT chop, which is the same quantity.
- **Stylization happens almost entirely in the look step.** A painted (or procedural) foam texture is
  thresholded by the foam amount, a "dissolve". Toon lighting bands and a dark rim around the foam do the
  rest. The simulation underneath barely changes.
- **This means the foam layer can sit on top of any fluid solver.** Each solver only has to supply a
  source mask and, when it has one, a surface velocity. FFT and Gerstner oceans are easy; shallow-water
  solvers are a good next target because they provide a real velocity field; particle solvers (SPH and
  FLIP) are the hardest to stylize.

Recommended next step: pick the target engine or tool (see [Open questions](#open-questions)), then prove the
"any solver" claim on a 2D shallow-water solver.

## 1. The four-part model

| Part | Question it answers | Options seen in production |
|---|---|---|
| **Source** `S` | Where is foam born? | Jacobian of the displacement (FFT, Gerstner) · wave height or "peak mask" · depth difference against the scene (contact or shore foam) · object stamps (boat wakes, explosions) · curvature, acceleration and vorticity (Houdini) · trapped air, crest and kinetic energy (SPH diffuse particles) |
| **Persistence and transport** | How does it live and move? | Feedback render target with blur ("dispersion") · advection by a flow map or current · advection by the solver's velocity field · diffuse particles that ride the surface |
| **Decay** `τ` | How fast does it disappear? | Exponential fade per frame, often tied to sea state (calm, normal, stormy) or wind speed |
| **Look** | How is it drawn? | Dissolve threshold on an artist texture · several texture layers at different thresholds · toon shading · normal or height bump · spray and particle sprites · far-distance coverage fallback |

## 2. Case studies

Confidence labels: **confirmed** means taken from the authors' own paper, talk abstract or documentation.
**Secondhand** means from a third-party write-up, so treat it as likely but not verified.

### Tessendorf, "Simulating Ocean Water" (SIGGRAPH course notes, 2001)

The base of nearly every FFT ocean, Sea of Thieves included.

- Heights come from an inverse FFT of a statistical spectrum (Phillips) evolved with the deep-water
  dispersion `ω = √(g·k)`. **Confirmed.**
- "Choppy" waves move points sideways, `x' = x + λ·D(x)`. This sharpens crests and flattens troughs. The
  factor λ is an artistic control. **Confirmed.**
- The mapping stays valid only while the surface does not fold. The Jacobian of the horizontal mapping tells
  where it starts to fold, and implementations put foam where J falls below a threshold. **Confirmed.**
- A spray algorithm in the 2001 slides emits particles where the smaller eigenvalue of the Jacobian drops
  below a threshold, using the eigenvectors for the direction. **Confirmed (slides).**

### Sea of Thieves (Rare), "The Technical Art of Sea of Thieves" (SIGGRAPH 2018 Talks)

Authors: Nigel Ang, Andy Catling, Francesco Cifariello Ciardi, Valentine Kozin.

- The ocean is "an implementation of the FFT technique described in [Tessendorf 2001]". **Confirmed.**
- Foam is generated at wave peaks and around objects that intersect the water. The mask is blurred over
  time with feedback, so it disperses softly, and is then blended with artist-authored textures for the
  stylized look. **Confirmed (abstract).**
- Foam generation, dispersion and blending change with sea state (calm, normal, stormy). Calm water only
  shows foam where objects meet the surface. **Confirmed (abstract).**
- Water colour blends a deep colour with a subsurface colour based on view angle, sun direction and a wave
  peak mask derived from the FFT chop. **Confirmed (abstract).**
- Wake, flow-map and render-target details were not in anything we could read. **Unknown.**

The proof of concept copies this structure: Tessendorf FFT, a peak (Jacobian) mask, a feedback blur, a
textured look and three sea-state presets.

### Crest ocean (Huw Bowles et al., SIGGRAPH 2017 Advances in Real-Time Rendering; Unity)

- Early versions computed foam in the vertex shader "using the determinant of the Jacobian of the
  displacement texture" and drew two foam layers at different thresholds. **Confirmed (README).**
- Current versions have a dedicated foam simulation (`LodDataFoam`) that is driven by the wave
  displacement, and boat wakes come from a dynamic wave simulation. The docs have a separate shoreline foam
  section. **Confirmed (README, docs table of contents).**

### Atlas (Grapeshot Games with NVIDIA, GDC 2019, "Wakes, Explosions and Lighting")

- Tessendorf-style spectrum ocean with interactive wakes and explosions. **Confirmed (session listing).**
- Foam from the Jacobian, blurred and faded over time. **Secondhand.**

### NVIDIA WaveWorks (War Thunder, Just Cause 3)

- Frequency-domain simulation, 3D displacements, "energy-based foam", CPU readbacks for physics.
  Shore waves use Gerstner waves scaled by the ocean amplitude. **Confirmed (slides "Bringing WaveWorks
  Online").** Its foam energy is very likely the same accumulate-and-fade idea, but we could not confirm it.

### Dupuy & Bruneton, "Real-time Animation and Rendering of Ocean Whitecaps" (SIGGRAPH Asia 2012)

- Whitecap trigger from the Jacobian of the horizontal displacement, following Tessendorf. **Confirmed.**
- The coverage term is analytic, so it can be prefiltered with mipmaps and stays anti-aliased from
  centimetres to planetary scale. **Confirmed.** This solves a problem we hit in the proof of concept:
  thresholding a mipmapped foam texture makes distant foam vanish (see [Findings](#4-findings-from-the-proof-of-concept)).
- Decay is listed as future work. **Confirmed (slides).**

### Unity HDRP water system

- "Simulation foam" appears on local maxima of high-amplitude crests. Its persistence follows the wind
  speed and can follow the swell direction. **Confirmed (docs).**
- "Foam generators" (water decals) inject foam for boat trails, waves and rocks, after which it follows
  the water. **Confirmed (docs).**

### Uncharted (Naughty Dog, GDC 2012 "Water Technology of Uncharted")

- Normal-map UVs scroll along a vector (flow) field, and foam moves with a threshold on a gradient field.
  **Secondhand.** Flow-map advection is the cheap way to give foam a velocity `u` without a simulation.

### Stylized references

- **The Legend of Zelda: The Wind Waker.** Foam is drawn as white graphic lines around shorelines and
  rocks, and these lines can stand in for wave shapes entirely. **Secondhand (analyses and recreations).**
- **Roystan toon water tutorial (Unity, open source).** Shoreline foam comes from the depth buffer: water
  that is only a little in front of the scene behind it is "touching" something. A noise texture with a
  hard cutoff gives the cartoon edge, and the cutoff varies with water depth. **Confirmed (code and ports).**
  This is the "contact foam" layer in the proof of concept.

### Physically based and offline methods

- **Ihmsen et al., "Unified Spray, Foam and Air Bubbles for Particle-Based Fluids" (The Visual Computer,
  2012).** A post-process on SPH. Each fluid particle gets a potential to mix with air from three terms:
  trapped air, being on a wave crest, and kinetic energy. Diffuse particles are spawned there, then
  classified as spray, foam or bubbles by where they sit relative to the surface. Implemented in
  SPlisHSPlasH and the FLIP Fluids Blender add-on. **Confirmed.**
- **Houdini Whitewater.** Emission from a FLIP simulation based on surface curvature (whitecaps),
  acceleration (sudden direction changes, such as a wave hitting a rock) and vorticity (churning water
  makes bubbles). Separate aging rates for spray, foam and bubbles. **Confirmed (SideFX docs).**
- **Thürey et al., "Real-time Simulations of Bubbles and Foam within a Shallow Water Framework" (SCA
  2007).** Shallow-water bulk fluid, bubble particles, and SPH foam on the surface, at interactive rates.
  **Confirmed (abstract).**

The physical methods use the same four parts. Their sources are richer (trapped air, vorticity) and their
transport is real particle motion.

## 3. Feasibility per fluid algorithm

This is the question the project ultimately has to answer: can one foam layer sit on top of the "popular
fluid simulation algorithms"? Ratings are our own judgement.

| Solver | What it gives us | Natural foam source | Transport | Look | Effort |
|---|---|---|---|---|---|
| **FFT ocean (Tessendorf)** | Height and choppy displacement on a tiling grid, no velocity | Jacobian J < bias | Store foam in tile space; it rides the surface particles for free. Add wind drift. | Dissolve texture | **Low. Done in the proof of concept.** |
| **Gerstner wave sum** | The same, analytically | Analytic Jacobian | Same as FFT | Same | Low |
| **Shallow water equations** (2D grid with height and velocity) | Height and a real 2D velocity | Convergence (−∇·u), steep slopes or breaking, obstacles, depth | Semi-Lagrangian advection of `F` with `u`. Real transport, which is the big upgrade. | Same | **Medium. Recommended next.** |
| **Eulerian 3D grid** (level set or VOF) | 3D velocity and a surface | Surface curvature and velocity, as in Houdini | Advect on the surface or with surface particles | Texture on the extracted mesh, or particles | High |
| **SPH or FLIP** (particles) | Particle positions and velocities | Ihmsen potentials (trapped air, crest, kinetic energy) | Diffuse particles | Splat particles into a screen-space foam mask, then apply the same dissolve stylization | Medium-high. Stylizing particles is the open problem. |
| **Wave particles or ripple sims** (interactive) | Local disturbances | The disturbance itself | Usually none (short-lived) | Same | Low, but only as an extra source |

The useful pattern is that only the **source** and the **transport** depend on the solver. The **decay**
and the **look**, which is where all the style lives, can be one shared module.

## 4. Findings from the proof of concept

The proof of concept is a browser demo (three.js and WebGL2). Every foam type uses the four-part model
above:

| Layer | Source | Persistence and transport | Decay | Look |
|---|---|---|---|---|
| Whitecaps | `J < bias` from the CPU FFT (Web Worker) | Tile-space feedback texture with 4-neighbour blur and wind drift | Exponential, seconds | Dissolve on the foam pattern, toon bands, bump, dark rim, vertex lift |
| Boat wake | Capsules stamped along the hull each frame | World-space feedback texture with blur | Exponential, about 10 s | Same |
| Contact foam | Scene depth minus water depth | None (recomputed each frame) | None | Same |
| Rock rings | Analytic distance to each rock, pulsing outward | None | None | Same |
| Spray | `J < threshold`, bow slam, water rising at rocks | Ballistic particles | Lifetime | Soft toon sprites |

What we learned:

1. **A realistic sea barely breaks.** With the spectrum calibrated to Pierson-Moskowitz wave heights, an
   11 m/s wind gives a minimum J of about 0.2 and almost no J < 0. The stylized look needs foam where
   J < 0.6, so the source threshold is an artistic control, not a physical one. That matches the brief
   ("magic, not accurate").
2. **Histogram-equalize the foam texture.** If the pattern values are spread evenly over [0, 1], the
   dissolve `pattern > 1 − mask` covers almost exactly `mask` of the surface. The foam amount then maps
   directly to coverage, which makes tuning predictable. Covered by a unit test.
3. **A thresholded texture disappears at distance.** Mipmapping averages the pattern to grey, so the
   threshold stops working. We widen the edge with `fwidth` and fade to plain coverage beyond about 60 to
   240 m. Dupuy & Bruneton's analytic filtering is the principled fix.
4. **Tile-space foam tiles.** Whitecap foam repeats every 256 m, like the FFT. Sampling the same spectrum
   at 4.7× smaller scale for normals hides most of the repetition up close. A production version would
   need a second cascade or a world-space foam buffer.
5. **Waves ran upwind at first.** With Tessendorf's `h0(k)·e^{iωt}` convention summed as `e^{ik·x}`, the
   dominant term travels toward −k. We align the spectrum with −wind and keep a unit test so it stays
   fixed.
6. **CPU FFT is fine for a prototype.** A 256² grid with 4 packed complex FFTs takes about 14 ms in Node.
   It runs in a Web Worker so it does not block rendering. Production should move the FFT to the GPU.
7. **Not yet measured:** frame rate on real GPUs. This environment only had a software renderer
   (SwiftShader), which is far too slow to judge performance.

## 5. Recommendations for stage 2

1. **Choose the target platform.** Unity, Unreal, Godot, Blender, Houdini, a custom C++ or OpenGL engine,
   or the web. The foam module's shape depends on it.
2. **Extract the foam module.** Inputs: a source mask, an optional velocity field, and sea-state
   parameters. Output: a foam texture. Then reuse the look shader everywhere.
3. **Add a shallow-water backend.** It is the cheapest solver with a real velocity field, so it tests
   true advection. Sources would be convergence, steepness and obstacles.
4. **Upgrade wakes.** Advect the wake buffer outward from the hull path to get a Kelvin-style V instead of
   a trail that only diffuses.
5. **Prototype screen-space foam for particle fluids** (SPH or FLIP), using Ihmsen's potentials as the
   source and the same dissolve look.

## Open questions

- **Which engine or tool is the target?** This decides how the foam module is packaged.
- **"Cloud simulation" in the brief:** we read this as the fluid (ocean) simulation, built here from
  scratch because the repository had no simulation yet. If an existing simulation should receive the foam,
  please point us to it.
- **How stylized?** The proof of concept sits between Sea of Thieves (painterly-realistic) and Wind Waker
  (graphic). The **Toon shading** and **Edge softness** sliders move between the two.

## Sources

- Tessendorf, J. (2001). *Simulating Ocean Water.* SIGGRAPH course notes. Slides and related papers:
  [course slides 2002](https://jtessen.people.clemson.edu/reports/papers_files/course_slides2002.pdf),
  [waterslides 2001](https://jtessen.people.clemson.edu/reports/papers_files/waterslides2001.pdf),
  [whitecap fraction](https://jtessen.people.clemson.edu/reports/papers_files/whitecap_fraction.pdf)
- Ang, N., Catling, A., Cifariello Ciardi, F., Kozin, V. (2018). *The Technical Art of Sea of Thieves.*
  SIGGRAPH 2018 Talks. [ACM history page](https://history.siggraph.org/?p=84316),
  [PDF](https://history.siggraph.org/wp-content/uploads/2022/09/2018-Talks-Ang_The-Technical-Art-of-Sea-of-Thieves.pdf),
  [Semantic Scholar](https://www.semanticscholar.org/paper/The-technical-art-of-sea-of-thieves-Ang-Catling/89d1c6b64424c270f8fb8fe6f1f0e225ad84b3af)
- Crest ocean renderer. [GitHub](https://github.com/ivdstudios/crest-oceanrender),
  [documentation PDF](https://crest.readthedocs.io/_/downloads/en/stable/pdf/)
- Mihelich, M., Tcheblokov, T. (2019). *Wakes, Explosions and Lighting: Interactive Water Simulation in
  Atlas.* GDC 2019. [GDC Vault](https://gdcvault.com/play/1025819/Advanced-Graphics-Techniques-Tutorial-Wakes),
  [slides](https://gpuopen.com/gdc-presentations/2019/gdc-2019-agtd6-interactive-water-simulation-in-atlas.pdf)
- Tcheblokov, T. *Bringing WaveWorks Online.* [Slides](https://sambuz.com/doc/bringing-waveworks-online-ppt-presentation-97773)
- Dupuy, J., Bruneton, E. (2012). *Real-time Animation and Rendering of Ocean Whitecaps.* SIGGRAPH Asia
  2012 Technical Briefs. [PDF](https://liris.cnrs.fr/Documents/Liris-5812.pdf),
  [DOI 10.1145/2407746.2407761](https://doi.org/10.1145/2407746.2407761)
- Unity HDRP. [Foam in the water system](https://docs.unity3d.com/Packages/com.unity.render-pipelines.high-definition@17.0/manual/water-foam-in-the-water-system.html)
- Naughty Dog (2012). *Water Technology of Uncharted.* GDC 2012.
  [Slides](https://www.slideshare.net/slideshow/water-technologyofunchartedgdc2012/12977478)
- Roystan. *Toon Water Shader.* [Godot port](https://godotshaders.com/shader/toon-water-shader/),
  [OpenUPM package](https://openupm.com/packages/net.roystan.toonwatershader/)
- Wind Waker style water. [Godot recreation](https://godotshaders.com/shader/wind-waker-water-no-textures-needed/)
- Ihmsen, M., Akinci, N., Akinci, G., Teschner, M. (2012). *Unified Spray, Foam and Air Bubbles for
  Particle-Based Fluids.* The Visual Computer 28, 669–677.
  [PDF](https://cg.informatik.uni-freiburg.de/publications/2012_CGI_sprayFoamBubbles.pdf),
  [SPlisHSPlasH foam generator](https://splishsplash.readthedocs.io/en/latest/FoamGenerator.html)
- SideFX. *Houdini Whitewater.* [Docs](https://www.sidefx.com/docs/houdini/shelf/whitewater.html)
- Thürey, N., Sadlo, F., Schirm, S., Müller-Fischer, M., Gross, M. (2007). *Real-time Simulations of
  Bubbles and Foam within a Shallow Water Framework.* SCA 2007.
  [Eurographics library](https://diglib.eg.org/items/8108fc3c-3020-4727-946f-5e5809be35fd/full)

Note on access: the network policy of the research environment blocked several hosts (history.siggraph.org,
gpuopen.com, 80.lv, crest.readthedocs.io and others). Facts from those pages come from search-result
excerpts and abstracts, not the full text, and are labelled above.
