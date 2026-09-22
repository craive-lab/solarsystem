# CRAIVE Lab display quality

Fill the eight-projector Pixelwarp canvas at native resolution, then make the scene worth 18 million pixels. Keep the output contract: 1200 × 15,360 canvas, 132% fatten, front wall at band x 6,317, entrance 11,165–11,636 black, yaw-only flight.

Ship in this order. Later items assume earlier ones.

## 1. Band-native capture

The walls are currently a stretch of a 1024 cubemap (~11 px/°) into a ~32 px/° band. Photograph the band.

- [x] Replace `CubeCamera` + unwrap in `webapp/js/craive.js` with N band-aligned perspective cameras (8, or 12) sitting on the ship
- [x] Each camera: vertical FOV 37.13°, optical axis pitched +5°, horizontal FOV 360°/N plus a few degrees of overlap
- [x] Render each slice into a 1920×1200 (N=8) strip of a 15360×1200 `WebGLRenderTarget`
- [x] Remap each rectilinear slice to the band's mapping (azimuth linear in canvas x, elevation linear in canvas y) with an 8–16 px overlap blend — a 45° perspective slice is ~19 px off horizontally and ~8 px vertically without this
- [x] Scissor-skip the entrance strip (11,165–11,636); it stays black
- [x] Keep a 2048 side-faces-only cubemap as fallback when the GPU cannot hold eight tiles
- [x] Confirm the canvas stays exactly 15360×1200, Sun at heading 0° sits at band x ≈ 6,317, entrance is black, circles still fat on a desktop preview

## 2. Linear HDR, tone-map once, MSAA

Cube faces are 8-bit with ACES applied per face; the blit copies already-compressed colour. The Sun and close planets clip before they reach the wall.

- [x] Render tiles to `HalfFloatType` colour with `NoToneMapping`
- [x] Composite + remap into the canvas, then apply ACES once in that pass
- [x] Set `renderer.outputColorSpace = THREE.SRGBColorSpace` explicitly
- [x] 4× MSAA on the 1920×1200 tiles (not on the full 15360 canvas)
- [x] Enable `logarithmicDepthBuffer` (near 0.05, stars at radius 2200)

## 3. Cylindrical billboards

`THREE.Sprite` faces whichever camera is rendering, so labels and beacons pop at cube/slice seams.

- [x] Replace beacons and name labels with yaw-only quads that stand upright and face the ship origin
- [x] Size them in degrees of azimuth, not the cube-face world scales in `syncVisuals(..., 0.016, 0.012)`
- [x] Keep star `gl_PointSize` in fattened canvas pixels (1.32× wide on desktop, round on the wall)

## 4. Scene that survives 32 px/°

Once the walls are sharp, 48-segment spheres and 4×256 stripe textures are the ceiling.

- [x] `SolarSystemScene` quality `high` (default, used by `/` and `/craive`) loads maps, catalog sky, atmosphere; `cheap` keeps procedural stripes
- [x] Raise sphere tessellation to 96–128 segments (or distance LOD) — at fly-to standoff the Sun is ~770 px across
- [x] Replace `bodyTexture()` with equirectangular JPL / Solar System Treks maps, anisotropy 8
- [x] Saturn ring texture with alpha
- [x] Earth limb / atmosphere pass
- [x] Drive the sun `PointLight` from the Sun mesh in linear space
- [x] Replace the 4200-point star field (`starSize: 1.1`) with a bright-star catalog and/or an 8K milky-way lat-long sampled with the same θ/φ as the band

## 5. Hold 60 fps at full canvas size

Never shrink the buffer and CSS-scale. If the lab GPU cannot hold 60 fps, drop quality in this order, always at 15360×1200:

- [x] Adaptive ladder: MSAA 4× → 2× → 0, then tile count 12 → 8 → 6, then 2048 side-faces cube (±Y skipped)
- [x] Log the active rung on the HUD so a compromised wall is obvious
- [x] Keep `setPixelRatio(1)`
- [x] Keep the existing orbit-line rebuild threshold

## 6. Audience vs operator

DOM panels are projected onto the walls.

- [x] Default `/craive` to `body.bare` for a show
- [x] Draw the operator HUD as an in-canvas inset on the front wall, below the useful sky
- [x] Toggle audience labels independently of the operator HUD

## Leave alone

- `BAND` numbers and the fatten
- Yaw-only flight and the start pose (horizon must not tilt; the disc needs the extra 23.6° above)
- One canvas → Pixelwarp → eight projectors (no per-projector cameras, no head tracking)
- Shared `scenery.js` simulation so `/` and `/craive` stay at feature parity
