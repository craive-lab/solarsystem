/**
 * The CRAIVE band's mapping: canvas UV to a world direction from the ship.
 *
 * Band x is azimuth about the front wall, band y is elevation. Heading 0 looks
 * along -Z; increasing yaw turns from -Z toward +X (starboard).
 *
 *   yaw = 0, front-wall centre, horizon → (0, 0, -1)
 *   yaw = π/2, front-wall centre, horizon → (1, 0, 0)
 *
 * Used by picking, the slice cameras, and (as GLSL) the band shaders.
 */

const TAU = Math.PI * 2;

/** World direction from the ship for canvas UV `u,v` (v = 0 at the bottom of the band). */
export function bandDirection(u, v, yaw, frontFrac, elevCenter, vFov, out) {
  const theta = (u - frontFrac) * TAU + yaw;
  const phi = elevCenter + (v - 0.5) * vFov;
  const cp = Math.cos(phi);
  out.x = Math.sin(theta) * cp;
  out.y = Math.sin(phi);
  out.z = -Math.cos(theta) * cp;
  return out;
}

/**
 * Crossfade weight for slice `i` at canvas u in [0,1].
 *
 * Middle slices use a 2*overlap-wide linear ramp centred on each seam so
 * neighbouring weights sum to 1. Slice 0 has no left neighbour (the canvas
 * starts there). The last slice before the entrance has no right neighbour.
 * Entrance u is always 0.
 */
export function sliceWeight(i, u, sliceCount, overlap, entranceU) {
  if (u >= entranceU) return 0;
  const left = i / sliceCount;
  const right = (i + 1) / sliceCount;
  let w = 1;
  if (i > 0) {
    w *= clamp((u - (left - overlap)) / (2 * overlap), 0, 1);
  } else if (u < left) {
    w = 0;
  }
  if (right < entranceU) {
    w *= 1 - clamp((u - (right - overlap)) / (2 * overlap), 0, 1);
  } else if (u > right) {
    w = 0;
  }
  return w;
}

function clamp(x, a, b) {
  return x < a ? a : x > b ? b : x;
}

/** GLSL that writes `vec3 dir` from `vUv`, matching `bandDirection`. */
export const BAND_DIR_GLSL = `
      float theta = (vUv.x - uFrontFrac) * 6.283185307179586 + uYaw;
      float phi = uElevCenter + (vUv.y - 0.5) * uVFov;
      float cp = cos(phi);
      vec3 dir = vec3(sin(theta) * cp, sin(phi), -cos(theta) * cp);`;

/** GLSL `sliceWeight(int i, float u)`, matching `sliceWeight`. Needs `uEntrance`, `uOverlap`. */
export function sliceWeightGLSL(sliceCount) {
  return `
    float sliceWeight(int i, float u) {
      if (u >= uEntrance.x) return 0.0;
      float left = float(i) / ${sliceCount}.0;
      float right = float(i + 1) / ${sliceCount}.0;
      float w = 1.0;
      if (i > 0) {
        w *= clamp((u - (left - uOverlap)) / (2.0 * uOverlap), 0.0, 1.0);
      } else if (u < left) {
        w = 0.0;
      }
      if (right < uEntrance.x) {
        w *= 1.0 - clamp((u - (right - uOverlap)) / (2.0 * uOverlap), 0.0, 1.0);
      } else if (u > right) {
        w = 0.0;
      }
      return w;
    }`;
}

export function selfTestBandMath(band) {
  const frontFrac = band.frontCenter / band.width;
  const elevCenter = band.elevationCenter * Math.PI / 180;
  const vFov = band.verticalFov * Math.PI / 180;
  const entranceU = band.entranceStart / band.width;
  const N = band.slices;
  const ov = band.overlapPx / band.outputWidth;
  const out = { x: 0, y: 0, z: 0 };
  const fail = [];

  const near = (a, b, eps) => Math.abs(a - b) <= eps;

  bandDirection(frontFrac, 0.5 - elevCenter / vFov, 0, frontFrac, elevCenter, vFov, out);
  if (!near(out.x, 0, 1e-6) || !near(out.y, 0, 1e-6) || !near(out.z, -1, 1e-6)) {
    fail.push(`horizon ahead: got (${out.x}, ${out.y}, ${out.z}), want (0, 0, -1)`);
  }

  bandDirection(frontFrac, 0.5 - elevCenter / vFov, Math.PI / 2, frontFrac, elevCenter, vFov, out);
  if (!near(out.x, 1, 1e-6) || !near(out.y, 0, 1e-6) || !near(out.z, 0, 1e-6)) {
    fail.push(`horizon starboard: got (${out.x}, ${out.y}, ${out.z}), want (1, 0, 0)`);
  }

  bandDirection(frontFrac, 0.5, 0, frontFrac, elevCenter, vFov, out);
  const sp = Math.sin(elevCenter), cp = Math.cos(elevCenter);
  if (!near(out.x, 0, 1e-6) || !near(out.y, sp, 1e-6) || !near(out.z, -cp, 1e-6)) {
    fail.push(`band midline ahead: got (${out.x}, ${out.y}, ${out.z})`);
  }

  const width = band.outputWidth;
  for (let px = 0; px < width; px += 3) {
    const u = (px + 0.5) / width;
    let sum = 0;
    for (let i = 0; i < N; i++) sum += sliceWeight(i, u, N, ov, entranceU);
    if (u >= entranceU) {
      if (sum !== 0) fail.push(`entrance u=${u.toFixed(4)} weight ${sum}`);
    } else if (!near(sum, 1, 1e-4)) {
      fail.push(`u=${u.toFixed(4)} weights sum to ${sum}, want 1`);
      break;
    }
  }

  if (fail.length) {
    console.error('bandMath self-test failed:\n  ' + fail.join('\n  '));
    return fail;
  }
  return [];
}
