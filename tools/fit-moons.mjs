/**
 * Fits the moons' mean orbital elements to the JPL Horizons ephemerides and prints the
 * entries for MOONS in webapp/js/moons.js.
 *
 *   node tools/fit-moons.mjs                      all twenty
 *   node tools/fit-moons.mjs --only Io,Mimas      a few
 *   node tools/fit-moons.mjs --cache <dir>        where the downloaded ephemerides are kept
 *   node tools/fit-moons.mjs --reference <file>   also write the positions test-moons.mjs checks
 *   node tools/fit-moons.mjs --verbose            show the error as each fit widens
 *
 * The model fitted is the one the page runs, moonPosition() itself: a Kepler ellipse whose
 * node and periapsis precess at steady rates in the moon's reference plane, plus a few
 * periodic terms where a resonance or the Sun moves a moon by more than a quarter of a
 * degree. The seeds are JPL's Planetary Satellite Mean Elements
 * (https://ssd.jpl.nasa.gov/sats/elem/). Only the size, shape and period of each orbit
 * and its reference plane are taken from them, as a place to start; every angle and every
 * rate is found from the ephemeris.
 *
 * The first run downloads about 25 MB from ssd.jpl.nasa.gov, three requests a moon, and
 * keeps it; later runs are offline and take a minute. Needs Node 22 or later and nothing
 * installed. After pasting new elements into moons.js, rerun with --reference
 * tools/moons-reference.json and then node tools/test-moons.mjs.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { moonOrbit, moonPosition } from '../src/main/resources/webapp/js/moons.js';

const DEG = Math.PI / 180;
const J2000 = 2451545.0;

/** The fit runs over this century, and is centred on its middle. */
const SPAN = ['1975-01-01', '2075-01-01'];
const CENTRE_DAYS = 9131.5; // 2025-01-01 00:00 TDB, in days after J2000
const DENSE_HALF_DAYS = 32;

/**
 * Rates of the periodic terms, in degrees per day. Those with `free: true` below are only
 * seeds, and the fit moves them.
 *
 * The Moon's three largest solar terms, from the arguments in Meeus, Astronomical
 * Algorithms, ch. 47: evection, the variation and the annual equation.
 */
const EVECTION = 11.316505284;   // 2D - M'
const VARIATION = 24.381498234;  // 2D
const ANNUAL = 0.985600282;      // M, the Sun's mean anomaly
/** The Mimas-Tethys resonance librates about every 70.7 years (Meeus, ch. 46). */
const LIBRATION = 5.095 / 365.25;
/** Enceladus is held by Dione, in two terms of about 11 and 3.9 years (same chapter). */
const ENCELADUS = [32.39 / 365.25, 92.62 / 365.25];
/**
 * Miranda, Ariel and Umbriel sit close to a three-body resonance: their mean motions give
 * -n1 + 3 n2 - 2 n3 = 0.0785 degrees a day, a beat of 12.5 years that swings Miranda 1.4
 * degrees either way and Ariel a tenth of that.
 */
const MIRANDA = 0.078546;
/** The Sun rocks Deimos along its orbit once per turn of its node, about 54 years. */
const DEIMOS = 0.01801;

/** IAU 2009 poles of the planets whose equators serve as reference planes. */
const MARS = [317.68143, 52.88650];
const JUPITER = [268.056595, 64.495303];
const SATURN = [40.589, 83.537];
const URANUS = [77.311, 15.175];   // the pole the moons go round anticlockwise, not the IAU north
const NEPTUNE = [299.36, 43.46];

/**
 * a km, e, i degrees and P days are the JPL table's, as a place to start. `pole` is the
 * table's reference plane. Where that is the planet's equator the IAU pole is used, since
 * the table rounds to a tenth of a degree. Where it is a Laplace plane tipped away from
 * the equator, `fitPole` lets the fit move it, for the moons whose nodes come round often
 * enough in a century to show where the pole is.
 */
const SEEDS = [
  { name: 'Moon', id: 301, centre: 399, a: 384400, e: 0.0554, i: 5.16, P: 27.322,
    wobble: [{ rate: EVECTION }, { rate: VARIATION }, { rate: ANNUAL }] },
  { name: 'Phobos', id: 401, centre: 499, pole: MARS, a: 9375, e: 0.015, i: 1.1, P: 0.3187, accelerates: true },
  { name: 'Deimos', id: 402, centre: 499, pole: [316.6, 53.5], fitPole: true, a: 23457, e: 0.000, i: 1.8, P: 1.2625,
    wobble: [{ rate: DEIMOS, free: true }] },
  { name: 'Io', id: 501, centre: 599, pole: JUPITER, a: 421800, e: 0.004, i: 0.0, P: 1.762732 },
  { name: 'Europa', id: 502, centre: 599, pole: JUPITER, a: 671100, e: 0.009, i: 0.5, P: 3.525463 },
  { name: 'Ganymede', id: 503, centre: 599, pole: [268.2, 64.6], a: 1070400, e: 0.001, i: 0.2, P: 7.155588 },
  { name: 'Callisto', id: 504, centre: 599, pole: [268.7, 64.8], a: 1882700, e: 0.007, i: 0.3, P: 16.690440 },
  { name: 'Mimas', id: 601, centre: 699, pole: SATURN, a: 186000, e: 0.020, i: 1.6, P: 0.942422,
    wobble: [{ rate: LIBRATION, free: true }, { harmonic: 3 }] },
  { name: 'Enceladus', id: 602, centre: 699, pole: SATURN, a: 238400, e: 0.005, i: 0.0, P: 1.370218,
    wobble: [{ rate: ENCELADUS[0], free: true }, { rate: ENCELADUS[1], free: true }] },
  { name: 'Tethys', id: 603, centre: 699, pole: SATURN, a: 295000, e: 0.001, i: 1.1, P: 1.887802,
    wobble: [{ rate: LIBRATION, free: true }] },
  { name: 'Dione', id: 604, centre: 699, pole: SATURN, a: 377700, e: 0.002, i: 0.0, P: 2.736916 },
  { name: 'Rhea', id: 605, centre: 699, pole: SATURN, a: 527200, e: 0.001, i: 0.3, P: 4.517503 },
  { name: 'Titan', id: 606, centre: 699, pole: [36.4, 84.0], a: 1221900, e: 0.029, i: 0.3, P: 15.945448 },
  { name: 'Iapetus', id: 608, centre: 699, pole: [288.7, 78.9], a: 3561700, e: 0.028, i: 7.6, P: 79.331002 },
  { name: 'Miranda', id: 705, centre: 799, pole: URANUS, a: 129846, e: 0.001, i: 4.4, P: 1.413479,
    wobble: [{ rate: MIRANDA, free: true }, { harmonic: 2 }] },
  { name: 'Ariel', id: 701, centre: 799, pole: URANUS, a: 190929, e: 0.001, i: 0.0, P: 2.520379,
    wobble: [{ rate: MIRANDA, free: true }] },
  { name: 'Umbriel', id: 702, centre: 799, pole: URANUS, a: 265986, e: 0.004, i: 0.1, P: 4.144177 },
  { name: 'Titania', id: 703, centre: 799, pole: URANUS, a: 436298, e: 0.002, i: 0.1, P: 8.705869 },
  { name: 'Oberon', id: 704, centre: 799, pole: URANUS, a: 583511, e: 0.002, i: 0.1, P: 13.463237 },
  { name: 'Triton', id: 801, centre: 899, pole: NEPTUNE, a: 354800, e: 0.000, i: 157.3, P: 5.8792 }
];

// ---------------------------------------------------------------- command line

const args = process.argv.slice(2);
const option = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
const cacheDir = option('--cache') || join(tmpdir(), 'solarsystem-horizons');
const only = option('--only')?.split(',');
const referenceFile = option('--reference');
const verbose = args.includes('--verbose');
mkdirSync(cacheDir, { recursive: true });

// ---------------------------------------------------------------- Horizons

/**
 * Planet-centred geometric positions in the J2000 ecliptic frame, as [{ t, x, y, z }] with
 * t in days of TDB after J2000 and the vector already turned into the page's axes:
 * ecliptic north is +Y and ecliptic +Y is -Z, as heliocentric() in bodies.js has it.
 */
async function horizons(seed, tag, start, stop, step) {
  const file = join(cacheDir, `${seed.id}-${tag}.txt`);
  if (!existsSync(file)) {
    const query = new URLSearchParams({
      format: 'text', COMMAND: `'${seed.id}'`, OBJ_DATA: "'NO'", MAKE_EPHEM: "'YES'",
      EPHEM_TYPE: "'VECTORS'", CENTER: `'500@${seed.centre}'`, REF_PLANE: "'ECLIPTIC'",
      REF_SYSTEM: "'ICRF'", VEC_TABLE: "'1'", VEC_LABELS: "'NO'", CSV_FORMAT: "'YES'",
      OUT_UNITS: "'KM-S'", START_TIME: `'${start}'`, STOP_TIME: `'${stop}'`, STEP_SIZE: `'${step}'`
    });
    const response = await fetch('https://ssd.jpl.nasa.gov/api/horizons.api?' + query);
    const text = await response.text();
    if (!response.ok || !text.includes('$$SOE')) {
      throw new Error(`Horizons gave no ephemeris for ${seed.name}:\n${text.slice(0, 600)}`);
    }
    writeFileSync(file, text);
    await new Promise((resolve) => setTimeout(resolve, 400)); // one request at a time, unhurried
  }
  const text = readFileSync(file, 'utf8');
  const rows = text.slice(text.indexOf('$$SOE') + 5, text.indexOf('$$EOE')).trim().split('\n');
  return rows.map((row) => {
    const c = row.split(',');
    return { t: Number(c[0]) - J2000, x: Number(c[2]), y: Number(c[4]), z: -Number(c[3]) };
  });
}

// ---------------------------------------------------------------- the model

/**
 * The fit works in elements at the centre of the span, so that a longitude and its rate
 * are not the same unknown twice over, and hands moonPosition() the J2000 ones.
 *
 * theta: 0 a, 1 L, 2 dL, 3 e cos peri, 4 e sin peri, 5 dperi, 6 i cos node, 7 i sin node,
 *        8 dnode, 9 half the acceleration of L, 10 and 11 the pole's RA and Dec, then per
 *        wobble term its sine and cosine parts and its rate.
 */
const BASE = 12;

function specOf(theta, seed) {
  const tc = CENTRE_DAYS;
  const e = Math.hypot(theta[3], theta[4]);
  const i = Math.hypot(theta[6], theta[7]);
  const peri = Math.atan2(theta[4], theta[3]) / DEG;
  const node = Math.atan2(theta[7], theta[6]) / DEG;
  const half = theta[9];
  const spec = {
    pole: seed.pole && [theta[10], theta[11]], a: theta[0], e, i,
    node: [node - theta[8] * tc, theta[8]],
    peri: [peri - theta[5] * tc, theta[5]],
    L: [theta[1] - theta[2] * tc + half * tc * tc, theta[2] - 2 * half * tc, half]
  };
  const terms = seed.wobble || [];
  if (theta.length > BASE && terms.length) {
    spec.wobble = terms.map((term, n) => {
      const at = BASE + n * 3;
      const rate = term.harmonic ? term.harmonic * theta[BASE + 2] : theta[at + 2];
      const phase = Math.atan2(theta[at + 1], theta[at]) / DEG;
      return [Math.hypot(theta[at], theta[at + 1]), phase - rate * tc, rate];
    });
  }
  return spec;
}

const point = { x: 0, y: 0, z: 0 };

/**
 * The page compresses every moon's distance and keeps its direction, so the direction is
 * what has to be right. Range errors count a quarter as much: enough to pin the shape of
 * the ellipse, not enough to bend the longitude toward a perturbation in the distance.
 */
const RANGE_WEIGHT = 0.25;

function residuals(theta, seed, data, out) {
  const spec = specOf(theta, seed);
  for (let n = 0; n < data.length; n++) {
    const d = data[n];
    moonPosition(spec, d.t, point);
    const r = Math.hypot(d.x, d.y, d.z), m = Math.hypot(point.x, point.y, point.z);
    // The difference of the two unit vectors, which no change of range can shrink, plus
    // the range error along the true direction.
    const range = RANGE_WEIGHT * (m - r) / r;
    out[n * 3] = point.x / m + (range - 1) * d.x / r;
    out[n * 3 + 1] = point.y / m + (range - 1) * d.y / r;
    out[n * 3 + 2] = point.z / m + (range - 1) * d.z / r;
  }
  return out;
}

const sumSquares = (r) => { let s = 0; for (let n = 0; n < r.length; n++) s += r[n] * r[n]; return s; };

// ---------------------------------------------------------------- Levenberg-Marquardt

/** Solves A x = b for a small dense symmetric system, in place. */
function solve(A, b) {
  const m = b.length;
  for (let c = 0; c < m; c++) {
    let pivot = c;
    for (let r = c + 1; r < m; r++) if (Math.abs(A[r][c]) > Math.abs(A[pivot][c])) pivot = r;
    [A[c], A[pivot]] = [A[pivot], A[c]];
    [b[c], b[pivot]] = [b[pivot], b[c]];
    if (Math.abs(A[c][c]) < 1e-300) return null;
    for (let r = c + 1; r < m; r++) {
      const k = A[r][c] / A[c][c];
      for (let j = c; j < m; j++) A[r][j] -= k * A[c][j];
      b[r] -= k * b[c];
    }
  }
  for (let c = m - 1; c >= 0; c--) {
    for (let j = c + 1; j < m; j++) b[c] -= A[c][j] * b[j];
    b[c] /= A[c][c];
  }
  return b;
}

/**
 * @param free   indices of theta allowed to move
 * @param steps  finite-difference step for each index of theta
 */
function levenbergMarquardt(theta, free, steps, seed, data) {
  const size = data.length * 3;
  let r = residuals(theta, seed, data, new Float64Array(size));
  let cost = sumSquares(r);
  const trial = new Float64Array(size);
  const J = free.map(() => new Float64Array(size));
  let mu = 1e-3;

  for (let iteration = 0; iteration < 80 && mu < 1e12; iteration++) {
    free.forEach((index, column) => {
      const nudged = theta.slice();
      nudged[index] += steps[index];
      residuals(nudged, seed, data, trial);
      for (let n = 0; n < size; n++) J[column][n] = (trial[n] - r[n]) / steps[index];
    });
    const m = free.length;
    const JtJ = Array.from({ length: m }, () => new Float64Array(m));
    const Jtr = new Float64Array(m);
    for (let a = 0; a < m; a++) {
      for (let b = a; b < m; b++) {
        let s = 0;
        for (let n = 0; n < size; n++) s += J[a][n] * J[b][n];
        JtJ[a][b] = JtJ[b][a] = s;
      }
      let s = 0;
      for (let n = 0; n < size; n++) s += J[a][n] * r[n];
      Jtr[a] = s;
    }

    let improved = false;
    while (mu < 1e12) {
      const A = JtJ.map((row, a) => Array.from(row, (v, b) => (a === b ? v * (1 + mu) + 1e-300 : v)));
      const delta = solve(A, Array.from(Jtr, (v) => -v));
      if (delta) {
        const next = theta.slice();
        free.forEach((index, column) => { next[index] += delta[column]; });
        const nextCost = sumSquares(residuals(next, seed, data, trial));
        if (nextCost < cost) {
          const gain = (cost - nextCost) / cost;
          theta = next;
          r = residuals(theta, seed, data, r);
          cost = nextCost;
          mu /= 3;
          improved = gain > 1e-12;
          break;
        }
      }
      mu *= 4;
    }
    if (!improved) break;
  }
  return { theta, cost };
}

// ---------------------------------------------------------------- one moon

const within = (data, half) => data.filter((d) => Math.abs(d.t - CENTRE_DAYS) <= half);

function stepsFor(theta, half) {
  const steps = new Array(theta.length).fill(1e-3);
  steps[0] = 0.5;
  steps[2] = 1e-3 / half;
  steps[3] = steps[4] = 1e-5;
  steps[5] = steps[8] = 1e-2 / half;
  steps[9] = 1e-3 / (half * half);
  for (let at = BASE; at < theta.length; at += 3) steps[at + 2] = 1e-3 / half;
  return steps;
}

/**
 * Nothing in the seed says where the moon is in 2025, or which way its orbit has turned
 * by then, so try every combination on a few orbits' worth of data and keep the best.
 */
function coarseSearch(seed, data) {
  const out = new Float64Array(data.length * 3);
  const periGrid = seed.e >= 0.003 ? 12 : 1;
  const nodeGrid = seed.i >= 0.25 ? 12 : 1;
  let best = null;
  for (let nNode = 0; nNode < nodeGrid; nNode++) {
    for (let nPeri = 0; nPeri < periGrid; nPeri++) {
      for (let L = 0; L < 360; L += 5) {
        const peri = nPeri * 30 * DEG, node = nNode * 30 * DEG;
        const theta = [seed.a, L, 360 / seed.P, seed.e * Math.cos(peri), seed.e * Math.sin(peri), 0,
          seed.i * Math.cos(node), seed.i * Math.sin(node), 0, 0, ...(seed.pole || [0, 0])];
        const cost = sumSquares(residuals(theta, seed, data, out));
        if (!best || cost < best.cost) best = { theta, cost };
      }
    }
  }
  return best.theta;
}

/**
 * Starting values for the periodic terms, appended to theta. What they have to explain is
 * how far along its orbit the moon runs ahead of or behind the plain ellipse, so that lag
 * is fitted with a sine at each term's rate. A rate that is free to move is first tried a
 * little either side of its seed.
 */
function seedWobble(theta, seed, data) {
  const spec = specOf(theta, seed);
  const orbit = moonOrbit(spec, 0);
  const lag = data.map((d) => {
    moonOrbit(spec, d.t, orbit);
    moonPosition(spec, d.t, point);
    const { p, q } = orbit;
    const normal = [p.y * q.z - p.z * q.y, p.z * q.x - p.x * q.z, p.x * q.y - p.y * q.x];
    const r = Math.hypot(d.x, d.y, d.z), m = Math.hypot(point.x, point.y, point.z);
    const u = [d.x / r, d.y / r, d.z / r];
    const ahead = [normal[1] * u[2] - normal[2] * u[1], normal[2] * u[0] - normal[0] * u[2],
      normal[0] * u[1] - normal[1] * u[0]];
    // Model minus truth along the direction of travel; the term to add is the negative.
    return -((point.x / m - u[0]) * ahead[0] + (point.y / m - u[1]) * ahead[1]
      + (point.z / m - u[2]) * ahead[2]) / DEG;
  });
  const angle = (rate, d) => rate * (d.t - CENTRE_DAYS) * DEG;
  const sine = (rate) => {
    let ss = 0, sc = 0, cc = 0, sy = 0, cy = 0;
    data.forEach((d, n) => {
      const s = Math.sin(angle(rate, d)), c = Math.cos(angle(rate, d));
      ss += s * s; sc += s * c; cc += c * c; sy += s * lag[n]; cy += c * lag[n];
    });
    const det = ss * cc - sc * sc;
    const c1 = (sy * cc - cy * sc) / det, c2 = (cy * ss - sy * sc) / det;
    return { rate, c1, c2, explained: c1 * sy + c2 * cy };
  };

  let fundamental = 0;
  for (const term of seed.wobble) {
    let best = null;
    const rates = term.harmonic ? [term.harmonic * fundamental]
      : term.free ? Array.from({ length: 41 }, (_, k) => term.rate * (0.9 + k * 0.005))
        : [term.rate];
    for (const rate of rates) {
      const trial = sine(rate);
      if (!best || trial.explained > best.explained) best = trial;
    }
    fundamental = fundamental || best.rate;
    data.forEach((d, n) => {
      lag[n] -= best.c1 * Math.sin(angle(best.rate, d)) + best.c2 * Math.cos(angle(best.rate, d));
    });
    theta.push(best.c1, best.c2, term.harmonic ? 0 : best.rate);
  }
}

/** Angle between the fitted and the true direction from the planet, and the range error. */
function errors(spec, data) {
  const angles = [];
  let radial = 0;
  for (const d of data) {
    moonPosition(spec, d.t, point);
    const rm = Math.hypot(point.x, point.y, point.z), rd = Math.hypot(d.x, d.y, d.z);
    const cos = (point.x * d.x + point.y * d.y + point.z * d.z) / (rm * rd);
    angles.push(Math.acos(Math.min(1, cos)) / DEG);
    radial += ((rm - rd) / rd) ** 2;
  }
  angles.sort((a, b) => a - b);
  return {
    rms: Math.sqrt(angles.reduce((s, a) => s + a * a, 0) / angles.length),
    p95: angles[Math.floor(angles.length * 0.95)],
    max: angles[angles.length - 1],
    radial: Math.sqrt(radial / data.length) * 100
  };
}

async function fit(seed) {
  const century = await horizons(seed, 'century', SPAN[0], SPAN[1], '6000');
  const dense = await horizons(seed, 'dense', '2024-11-30', '2025-02-02', '20m');
  const check = await horizons(seed, 'check', '1975-03-01', '2075-03-01', '997');

  // Thin the dense run to about sixty points an orbit; a slow moon gains nothing from more.
  const stride = Math.max(1, Math.floor(seed.P / 60 / (20 / 1440)));
  const close = dense.filter((_, n) => n % stride === 0);

  let half = Math.max(4, 1.5 * seed.P);
  let theta = coarseSearch(seed, within(close, Math.min(half, DENSE_HALF_DAYS)));
  const fullHalf = 18263;
  let free = [0, 1, 2, 3, 4, 6, 7];

  // Widen the window a step at a time, so the phase carried out to the new edge by the
  // rates found so far is never more than a fraction of a turn out.
  for (;;) {
    const data = half >= fullHalf ? century : within(close, half).concat(within(century, half));
    ({ theta } = levenbergMarquardt(theta, free, stepsFor(theta, half), seed, data));
    if (verbose) console.error(`  ${seed.name} ±${half.toFixed(0)} d: ${errors(specOf(theta, seed), data).rms.toFixed(4)}° rms`);
    if (half >= fullHalf) break;
    half = Math.min(half * 3, fullHalf);
    free = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  }

  // The extra terms go in last, once the ellipse itself is settled.
  if (seed.accelerates || seed.wobble || seed.fitPole) {
    free = [0, 1, 2, 3, 4, 5, 6, 7, 8];
    if (seed.accelerates) free.push(9);
    if (seed.fitPole) free.push(10, 11);
    if (seed.wobble) seedWobble(theta, seed, century);
    for (const [n, term] of (seed.wobble || []).entries()) {
      const at = BASE + n * 3;
      free.push(at, at + 1);
      if (term.free) free.push(at + 2);
    }
    ({ theta } = levenbergMarquardt(theta, free, stepsFor(theta, fullHalf), seed, century));
  }

  const spec = specOf(theta, seed);
  return { seed, spec, fitted: errors(spec, century), checked: errors(spec, check), check };
}

// ---------------------------------------------------------------- output

const wrap = (deg) => ((deg % 360) + 360) % 360;

function format(result) {
  const { seed, spec } = result;
  // Too round to have a periapsis, or too flat to have a node: say so rather than print noise.
  const round = 2 * spec.e / DEG < 0.02;
  const flat = spec.i < 0.01;
  const pair = (p, digits) => `[${wrap(p[0]).toFixed(4)}, ${p[1].toFixed(digits)}]`;
  const L = `[${wrap(spec.L[0]).toFixed(4)}, ${spec.L[1].toFixed(9)}${spec.L[2] ? ', ' + spec.L[2].toExponential(4) : ''}]`;
  const parts = [
    spec.pole ? `pole: [${spec.pole.map((v) => Number(v.toFixed(4))).join(', ')}]` : null,
    `a: ${spec.a.toFixed(0)}, e: ${round ? 0 : spec.e.toFixed(5)}, i: ${flat ? 0 : spec.i.toFixed(4)}`,
    `node: ${flat ? '[0, 0]' : pair(spec.node, 7)}, peri: ${round ? '[0, 0]' : pair(spec.peri, 7)}`,
    `L: ${L}`,
    spec.wobble
      ? `wobble: [${spec.wobble.map((w) => `[${w[0].toFixed(4)}, ${wrap(w[1]).toFixed(3)}, ${w[2].toFixed(9)}]`).join(', ')}]`
      : null
  ].filter(Boolean);
  return `  // ${seed.name}\n    ${parts.join(',\n    ')}`;
}

const results = [];
for (const seed of SEEDS) {
  if (only && !only.includes(seed.name)) continue;
  const result = await fit(seed);
  results.push(result);
  const f = result.fitted, c = result.checked;
  console.error(`${seed.name.padEnd(10)} fit ${f.rms.toFixed(3)}° rms, ${f.max.toFixed(3)}° max`
    + `   check ${c.rms.toFixed(3)}° rms, ${c.p95.toFixed(3)}° 95%, ${c.max.toFixed(3)}° max`
    + `   range ${c.radial.toFixed(2)}%`);
}

console.log(results.map(format).join('\n'));

if (referenceFile) {
  // Every fortieth check epoch: 25 dates a moon across the century, none of them fitted to.
  const reference = {
    source: 'JPL Horizons, planet-centred geometric positions, J2000 ecliptic, km',
    moons: Object.fromEntries(results.map(({ seed, check }) => [
      seed.name,
      // Back out of the page's axes into the ecliptic ones Horizons printed.
      check.filter((_, n) => n % 40 === 20).map((d) => [
        Number((d.t + J2000).toFixed(4)), Math.round(d.x), Math.round(-d.z), Math.round(d.y)
      ])
    ]))
  };
  writeFileSync(referenceFile, JSON.stringify(reference) + '\n');
  console.error(`wrote ${referenceFile}`);
}
