/**
 * Solar system bodies: orbital elements, the Kepler propagator that turns them into
 * positions, and the synth recipe that gives each body its own voice.
 *
 * Orbital elements are the JPL "Keplerian Elements for Approximate Positions of the Major
 * Planets" set, which is accurate to a few arc-minutes over 1800-2050. Each element is a
 * value at J2000 plus a rate per Julian century.
 */

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/** Julian date of the J2000.0 epoch. */
export const J2000 = 2451545.0;

/**
 * Radial compression. The real system spans 0.39 to 30 AU; drawing that to scale leaves
 * the inner planets in a dot. Every position is warped as R = K * r^P, which keeps orbits
 * closed and ordered while making all nine bodies visible at once. Orbit lines are warped
 * with the same function, so a planet always sits exactly on its drawn path.
 */
const ORBIT_K = 12.0;
const ORBIT_P = 0.55;

/** Body radii are compressed too, relative to Earth. */
const RADIUS_EARTH_UNITS = 0.42;
const RADIUS_P = 0.4;
const EARTH_RADIUS_KM = 6371;

/** Sidereal rotation period of the Sun at its equator, in days. */
export const SUN_ROTATION_DAYS = 25.38;

/**
 * name      display name
 * elements  [a, e, I, L, wbar, Omega] at J2000 and their rates per century
 *           a AU, everything else degrees
 * radiusKm  equatorial radius, used only for the compressed visual size
 * sound     synth recipe, interpreted by AudioEngine
 */
export const BODIES = [
  {
    name: 'Sun',
    color: 0xffc648,
    radiusKm: 696340,
    elements: null,
    facts: 'G2V star, 99.86% of the system mass',
    sound: {
      note: 'A1', freq: 55,
      timbre: 'beating sawtooth drone with a solar-wind noise bed',
      gain: 0.55,
      osc: [
        { type: 'sawtooth', ratio: 1, gain: 0.26 },
        { type: 'sawtooth', ratio: 1, detune: 11, gain: 0.26 },
        { type: 'sine', ratio: 0.5, gain: 0.5 }
      ],
      noise: { gain: 0.13, type: 'bandpass', freq: 320, q: 0.8 },
      filter: { type: 'lowpass', freq: 700, q: 1.2 },
      lfo: { target: 'filter', rate: 0.07, depth: 0.55 },
      pulse: 0.20
    }
  },
  {
    name: 'Mercury',
    color: 0x9a8f85,
    radiusKm: 2439.7,
    elements: {
      a: [0.38709927, 0.00000037], e: [0.20563593, 0.00001906], I: [7.00497902, -0.00594749],
      L: [252.25032350, 149472.67411175], wbar: [77.45779628, 0.16047689], Omega: [48.33076593, -0.12534081]
    },
    facts: '88 day year, no atmosphere, 430 C in daylight',
    sound: {
      note: 'B5', freq: 987.77,
      timbre: 'hard square wave under an 11 Hz tremolo',
      gain: 0.22,
      osc: [
        { type: 'square', ratio: 1, gain: 0.30 },
        { type: 'square', ratio: 2, gain: 0.08 }
      ],
      filter: { type: 'bandpass', freq: 1400, q: 4 },
      lfo: { target: 'gain', rate: 11, depth: 0.7 },
      pulse: 0.45
    }
  },
  {
    name: 'Venus',
    color: 0xe6c98f,
    radiusKm: 6051.8,
    elements: {
      a: [0.72333566, 0.00000390], e: [0.00677672, -0.00004107], I: [3.39467605, -0.00078890],
      L: [181.97909950, 58517.81538729], wbar: [131.60246718, 0.00268329], Omega: [76.67984255, -0.27769418]
    },
    facts: 'retrograde spin, 92 bar CO2 atmosphere',
    sound: {
      note: 'E5', freq: 659.26,
      timbre: 'two triangles a few cents apart, slow shimmer',
      gain: 0.26,
      osc: [
        { type: 'triangle', ratio: 1, gain: 0.35 },
        { type: 'triangle', ratio: 1, detune: 9, gain: 0.30 }
      ],
      filter: { type: 'lowpass', freq: 2400, q: 0.8 },
      lfo: { target: 'gain', rate: 0.6, depth: 0.3 },
      pulse: 0.35
    }
  },
  {
    name: 'Earth',
    color: 0x4d8fe0,
    radiusKm: 6371.0,
    elements: {
      a: [1.00000261, 0.00000562], e: [0.01671123, -0.00004392], I: [-0.00001531, -0.01294668],
      L: [100.46457166, 35999.37244981], wbar: [102.93768193, 0.32327364], Omega: [0.0, 0.0]
    },
    facts: 'the reference orbit, 1 AU by definition',
    sound: {
      note: 'A4', freq: 440,
      timbre: 'pure sine with its fifth and octave, gentle vibrato',
      gain: 0.30,
      osc: [
        { type: 'sine', ratio: 1, gain: 0.40 },
        { type: 'sine', ratio: 1.5, gain: 0.18 },
        { type: 'sine', ratio: 2, gain: 0.06 }
      ],
      filter: { type: 'lowpass', freq: 3000, q: 0.7 },
      lfo: { target: 'pitch', rate: 0.25, depth: 8 },
      pulse: 0.30
    }
  },
  {
    name: 'Mars',
    color: 0xc1502e,
    radiusKm: 3389.5,
    elements: {
      a: [1.52371034, 0.00001847], e: [0.09339410, 0.00007882], I: [1.84969142, -0.00813131],
      L: [-4.55343205, 19140.30268499], wbar: [-23.94362959, 0.44441088], Omega: [49.55953891, -0.29257343]
    },
    facts: 'eccentric orbit, Olympus Mons, thin CO2 air',
    sound: {
      note: 'D4', freq: 293.66,
      timbre: 'resonant sawtooth swept by a slow band-pass',
      gain: 0.26,
      osc: [
        { type: 'sawtooth', ratio: 1, gain: 0.30 },
        { type: 'square', ratio: 0.5, gain: 0.12 }
      ],
      filter: { type: 'bandpass', freq: 620, q: 6.5 },
      lfo: { target: 'filter', rate: 0.18, depth: 0.55 },
      pulse: 0.40
    }
  },
  {
    name: 'Jupiter',
    color: 0xd8b78a,
    radiusKm: 69911,
    elements: {
      a: [5.20288700, -0.00011607], e: [0.04838624, -0.00013253], I: [1.30439695, -0.00183714],
      L: [34.39644051, 3034.74612775], wbar: [14.72847983, 0.21252668], Omega: [100.47390909, 0.20469106]
    },
    facts: '318 Earth masses, 10 hour day',
    sound: {
      note: 'C3', freq: 130.81,
      timbre: 'wide detuned sawtooths over a sub sine',
      gain: 0.38,
      osc: [
        { type: 'sawtooth', ratio: 1, detune: -7, gain: 0.30 },
        { type: 'sawtooth', ratio: 1, detune: 7, gain: 0.30 },
        { type: 'sine', ratio: 0.5, gain: 0.25 }
      ],
      filter: { type: 'lowpass', freq: 420, q: 1 },
      lfo: { target: 'filter', rate: 0.09, depth: 0.35 },
      pulse: 0.30
    }
  },
  {
    name: 'Saturn',
    color: 0xe8d5a8,
    radiusKm: 58232,
    ring: { inner: 1.35, outer: 2.30, color: 0xcbb98d, tilt: 26.7 },
    facts: 'ring system 280,000 km across but only tens of metres thick',
    sound: {
      note: 'A3', freq: 220,
      timbre: 'FM bell at an inharmonic 2.76 ratio',
      gain: 0.24,
      osc: [{ type: 'sine', ratio: 1, gain: 0.32 }],
      fm: { ratio: 2.76, index: 700 },
      filter: { type: 'lowpass', freq: 3500, q: 1 },
      lfo: { target: 'gain', rate: 0.4, depth: 0.35 },
      pulse: 0.35
    },
    elements: {
      a: [9.53667594, -0.00125060], e: [0.05386179, -0.00050991], I: [2.48599187, 0.00193609],
      L: [49.95424423, 1222.49362201], wbar: [92.59887831, -0.41897216], Omega: [113.66242448, -0.28867794]
    }
  },
  {
    name: 'Uranus',
    color: 0x9fdce4,
    radiusKm: 25362,
    elements: {
      a: [19.18916464, -0.00196176], e: [0.04725744, -0.00004397], I: [0.77263783, -0.00242939],
      L: [313.23810451, 428.48202785], wbar: [170.95427630, 0.40805281], Omega: [74.01692503, 0.04240589]
    },
    facts: 'spins on its side, 98 degree axial tilt',
    sound: {
      note: 'F3', freq: 174.61,
      timbre: 'sines beating at 3 Hz under an icy noise wash',
      gain: 0.26,
      osc: [
        { type: 'sine', ratio: 1, gain: 0.30 },
        { type: 'sine', ratio: 1, detune: 30, gain: 0.28 },
        { type: 'triangle', ratio: 2, gain: 0.06 }
      ],
      noise: { gain: 0.04, type: 'highpass', freq: 4000, q: 0.7 },
      filter: { type: 'lowpass', freq: 2600, q: 0.9 },
      lfo: { target: 'filter', rate: 0.05, depth: 0.30 },
      pulse: 0.25
    }
  },
  {
    name: 'Neptune',
    color: 0x3f5fd0,
    radiusKm: 24622,
    elements: {
      a: [30.06992276, 0.00026291], e: [0.00859048, 0.00005105], I: [1.77004347, 0.00035372],
      L: [-55.12002969, 218.45945325], wbar: [44.96476227, -0.32241464], Omega: [131.78422574, -0.00508664]
    },
    facts: '165 year orbit, 2100 km/h winds',
    sound: {
      note: 'G2', freq: 98,
      timbre: 'deep oceanic swell, one breath every 25 seconds',
      gain: 0.36,
      osc: [
        { type: 'sine', ratio: 1, gain: 0.38 },
        { type: 'triangle', ratio: 1.5, gain: 0.12 },
        { type: 'sine', ratio: 0.5, gain: 0.18 }
      ],
      filter: { type: 'lowpass', freq: 300, q: 1.4 },
      lfo: { target: 'gain', rate: 0.04, depth: 0.5 },
      pulse: 0.22
    }
  }
];

/** Scene radius for a body, compressed relative to Earth. */
export function displayRadius(body) {
  return RADIUS_EARTH_UNITS * Math.pow(body.radiusKm / EARTH_RADIUS_KM, RADIUS_P);
}

/** Orbital period in days, from Kepler's third law. */
export function periodDays(body) {
  if (!body.elements) return SUN_ROTATION_DAYS;
  return Math.pow(body.elements.a[0], 1.5) * 365.256363;
}

/** Julian date for a JavaScript timestamp in milliseconds. */
export function julianDate(unixMillis) {
  return unixMillis / 86400000 + 2440587.5;
}

/** Centuries since J2000 for a Julian date. */
export function centuries(jd) {
  return (jd - J2000) / 36525;
}

function element(pair, T) {
  return pair[0] + pair[1] * T;
}

/** Wraps degrees into [-180, 180). */
function wrapDeg(d) {
  let x = d % 360;
  if (x >= 180) x -= 360;
  if (x < -180) x += 360;
  return x;
}

/**
 * Solves Kepler's equation M = E - e* sin E for the eccentric anomaly, in degrees.
 * Newton's method; five iterations is far more than the planets need.
 */
function eccentricAnomaly(M, e) {
  const eStar = RAD * e;
  let E = M + eStar * Math.sin(M * DEG);
  for (let i = 0; i < 12; i++) {
    const dM = M - (E - eStar * Math.sin(E * DEG));
    const dE = dM / (1 - e * Math.cos(E * DEG));
    E += dE;
    if (Math.abs(dE) < 1e-9) break;
  }
  return E;
}

/**
 * Heliocentric position in the J2000 ecliptic frame, in AU, mapped into three.js
 * coordinates: ecliptic +X stays X, ecliptic north becomes +Y, and +Z completes the
 * right-handed set. `tiltGain` exaggerates orbital inclination; the real system is nearly
 * flat, so a value above 1 is what makes the vertical component of the spatial audio
 * audible.
 */
export function heliocentric(body, T, tiltGain, out) {
  out = out || { x: 0, y: 0, z: 0, meanAnomaly: 0, radiusAu: 0 };
  if (!body.elements) {
    out.x = out.y = out.z = 0;
    out.radiusAu = 0;
    // The Sun does not orbit, but it does rotate; reuse the phase slot for its spin.
    out.meanAnomaly = ((T * 36525 / SUN_ROTATION_DAYS) % 1) * 2 * Math.PI;
    return out;
  }
  const el = body.elements;
  const a = element(el.a, T);
  const e = element(el.e, T);
  const I = element(el.I, T) * tiltGain;
  const L = element(el.L, T);
  const wbar = element(el.wbar, T);
  const Omega = element(el.Omega, T);

  const omega = wbar - Omega;
  const M = wrapDeg(L - wbar);
  const E = eccentricAnomaly(M, e);

  // Position in the orbital plane, perifocal coordinates.
  const xp = a * (Math.cos(E * DEG) - e);
  const yp = a * Math.sqrt(1 - e * e) * Math.sin(E * DEG);

  orbitalToEcliptic(xp, yp, omega, I, Omega, out);
  out.meanAnomaly = ((M * DEG) + 2 * Math.PI) % (2 * Math.PI);
  out.radiusAu = Math.hypot(xp, yp);
  return out;
}

/** Rotates perifocal coordinates by argument of perihelion, inclination and node. */
function orbitalToEcliptic(xp, yp, omegaDeg, IDeg, OmegaDeg, out) {
  const cw = Math.cos(omegaDeg * DEG), sw = Math.sin(omegaDeg * DEG);
  const cO = Math.cos(OmegaDeg * DEG), sO = Math.sin(OmegaDeg * DEG);
  const cI = Math.cos(IDeg * DEG), sI = Math.sin(IDeg * DEG);

  const xEcl = (cw * cO - sw * sO * cI) * xp + (-sw * cO - cw * sO * cI) * yp;
  const yEcl = (cw * sO + sw * cO * cI) * xp + (-sw * sO + cw * cO * cI) * yp;
  const zEcl = (sw * sI) * xp + (cw * sI) * yp;

  // Ecliptic (X, Y, Z-north) into three.js (X, Y-up, Z), preserving handedness.
  out.x = xEcl;
  out.y = zEcl;
  out.z = -yEcl;
  return out;
}

/** Applies the radial compression to an AU-space position, in place. */
export function warp(p) {
  const r = Math.hypot(p.x, p.y, p.z);
  if (r < 1e-12) { p.x = p.y = p.z = 0; return p; }
  const k = (ORBIT_K * Math.pow(r, ORBIT_P)) / r;
  p.x *= k; p.y *= k; p.z *= k;
  return p;
}

/** Scene-space position of a body at epoch T. */
export function scenePosition(body, T, tiltGain, out) {
  const p = heliocentric(body, T, tiltGain, out);
  const meanAnomaly = p.meanAnomaly, radiusAu = p.radiusAu;
  warp(p);
  p.meanAnomaly = meanAnomaly;
  p.radiusAu = radiusAu;
  return p;
}

/**
 * Samples a full orbit as a flat Float32Array of scene-space points, closed. The same warp
 * as `scenePosition` is applied, so the drawn line is exactly the path the body follows.
 */
export function orbitPoints(body, T, tiltGain, segments = 512) {
  const out = new Float32Array((segments + 1) * 3);
  if (!body.elements) return out;
  const el = body.elements;
  const a = element(el.a, T);
  const e = element(el.e, T);
  const I = element(el.I, T) * tiltGain;
  const Omega = element(el.Omega, T);
  const omega = element(el.wbar, T) - Omega;
  const p = { x: 0, y: 0, z: 0 };

  for (let i = 0; i <= segments; i++) {
    const E = (i / segments) * 360;
    const xp = a * (Math.cos(E * DEG) - e);
    const yp = a * Math.sqrt(1 - e * e) * Math.sin(E * DEG);
    orbitalToEcliptic(xp, yp, omega, I, Omega, p);
    warp(p);
    out[i * 3] = p.x;
    out[i * 3 + 1] = p.y;
    out[i * 3 + 2] = p.z;
  }
  return out;
}
