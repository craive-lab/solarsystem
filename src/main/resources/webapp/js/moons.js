/**
 * The twenty major moons: mean orbital elements, the propagator that turns them into
 * planet-centred positions, and where each orbit is drawn.
 *
 * Each moon follows a Kepler ellipse whose node and periapsis precess at steady rates.
 * The elements were fitted to the JPL Horizons satellite ephemerides over 1975-2075 by
 * tools/fit-moons.mjs, which starts from JPL's Planetary Satellite Mean Elements table.
 * That table alone is rounded too far to keep a phase: its period for Phobos has four
 * digits, which loses the moon's place on its orbit within a month. Against Horizons the
 * fitted elements put every moon within 0.3 degrees of its true direction from its planet
 * across that century; tools/test-moons.mjs checks it.
 */

import { BODIES, displayRadius, eccentricAnomaly, equatorialToScene } from './bodies.js';

const DEG = Math.PI / 180;

/**
 * The elements run on Terrestrial Time and the page's clock on UTC. The gap has been
 * 69.184 seconds since 2017, which is nothing to a planet and most of a degree to Phobos.
 */
export const TT_MINUS_UTC_DAYS = 69.184 / 86400;

/**
 * name      display name
 * parent    the planet it orbits, by name in BODIES
 * radiusKm  mean radius, used only for the compressed visual size
 * pole      [RA, Dec] of the reference plane's pole in ICRF, degrees. For most moons that
 *           is the local Laplace plane, the plane the orbit precesses about: the planet's
 *           equator close in, tipping toward the planet's orbit further out. Omitted for
 *           the Moon, whose elements are referred to the ecliptic.
 * a         semi-major axis, km
 * e         eccentricity
 * i         inclination to the reference plane, degrees
 * node      longitude of the ascending node [at J2000, rate per day], degrees, measured
 *           from where the reference plane rises through the ICRF equator
 * peri      longitude of periapsis, node + argument of periapsis, same form
 * L         mean longitude, peri + mean anomaly, same form. A third entry is half the
 *           acceleration, degrees per day squared: Phobos is spiralling in.
 * wobble    periodic terms added to L, each [amplitude, phase at J2000, rate per day] in
 *           degrees: the Sun's pull on the Moon, and the resonance Mimas shares with Tethys
 */
export const MOONS = [
  {
    name: 'Moon', parent: 'Earth', radiusKm: 1737.4, color: 0xb5b2aa,
    a: 384368, e: 0.05490, i: 5.1466,
    node: [125.0463, -0.0529924], peri: [83.3541, 0.1113650], L: [218.3199, 13.176358006],
    // Evection, the variation and the annual equation: without them the Moon strays 2 degrees.
    wobble: [[1.2407, 100.745, 11.316505284], [0.5967, 235.710, 24.381498234], [0.1871, 177.469, 0.985600282]]
  },
  {
    name: 'Phobos', parent: 'Mars', radiusKm: 11.1, color: 0x75695e,
    pole: [317.6814, 52.8865],
    a: 9375, e: 0.01513, i: 1.0748,
    node: [169.1502, -0.4357873], peri: [25.6208, 0.4351828], L: [215.1810, 1128.844756194, 9.4421e-9]
  },
  {
    name: 'Deimos', parent: 'Mars', radiusKm: 6.2, color: 0x94887a,
    pole: [316.6315, 53.5138],
    a: 23458, e: 0.00027, i: 1.8026,
    node: [54.4104, -0.0180847], peri: [247.7930, 0.0179572], L: [259.4244, 285.161887201],
    wobble: [[0.2715, 349.531, 0.018084113]]
  },
  {
    name: 'Io', parent: 'Jupiter', radiusKm: 1821.6, color: 0xe3cf6a,
    pole: [268.0566, 64.4953],
    a: 421766, e: 0.00413, i: 0.0357,
    node: [260.5802, -0.1327825], peri: [49.0616, -0.7395093], L: [19.9478, 203.488958256]
  },
  {
    name: 'Europa', parent: 'Jupiter', radiusKm: 1560.8, color: 0xd6c8ad,
    pole: [268.0566, 64.4953],
    a: 671062, e: 0.00928, i: 0.4644,
    node: [184.6649, -0.0326398], peri: [229.0711, -0.7395107], L: [214.5048, 101.374724427]
  },
  {
    name: 'Ganymede', parent: 'Jupiter', radiusKm: 2634.1, color: 0x8f8475,
    pole: [268.2, 64.6],
    a: 1070432, e: 0.00180, i: 0.2127,
    node: [44.2257, -0.0060882], peri: [282.7909, 0.0057257], L: [221.6543, 50.317607437]
  },
  {
    name: 'Callisto', parent: 'Jupiter', radiusKm: 2410.3, color: 0x5a5047,
    pole: [268.7, 64.8],
    a: 1882745, e: 0.00730, i: 0.2238,
    node: [301.2925, -0.0017250], peri: [353.9242, 0.0017876], L: [80.3875, 21.571072664]
  },
  {
    name: 'Mimas', parent: 'Saturn', radiusKm: 198.2, color: 0xc4c4c2,
    pole: [40.589, 83.537],
    a: 185537, e: 0.01967, i: 1.5733,
    node: [172.9292, -0.9994984], peri: [145.6625, 1.0009188], L: [160.3823, 381.994491562],
    // The resonance with Tethys swings Mimas 43 degrees either side of its mean place.
    wobble: [[43.4430, 140.784, 0.013944468], [0.7080, 61.753, 0.041833404]]
  },
  {
    name: 'Enceladus', parent: 'Saturn', radiusKm: 252.1, color: 0xf0f4f6,
    pole: [40.589, 83.537],
    a: 238036, e: 0.00474, i: 0,
    node: [0, 0], peri: [171.6301, 0.3379566], L: [182.2654, 262.731897681],
    wobble: [[0.2611, 73.612, 0.089233916], [0.1883, 316.864, 0.253715809]]
  },
  {
    name: 'Tethys', parent: 'Saturn', radiusKm: 531.1, color: 0xd9d9d6,
    pole: [40.589, 83.537],
    a: 294673, e: 0, i: 1.0913,
    node: [259.8397, -0.1978488], peri: [0, 0], L: [188.3957, 190.697910817],
    wobble: [[2.0911, 321.096, 0.013912357]]
  },
  {
    name: 'Dione', parent: 'Saturn', radiusKm: 561.4, color: 0xcfcfcc,
    pole: [40.589, 83.537],
    a: 377415, e: 0.00220, i: 0.0283,
    node: [290.2590, -0.0841038], peri: [214.5877, 0.0842551], L: [176.9142, 131.534930504]
  },
  {
    name: 'Rhea', parent: 'Saturn', radiusKm: 763.8, color: 0xc5c3be,
    pole: [40.589, 83.537],
    a: 527068, e: 0.00097, i: 0.3313,
    node: [351.8362, -0.0276235], peri: [203.0467, 0.0014224], L: [52.1768, 79.690045676]
  },
  {
    name: 'Titan', parent: 'Saturn', radiusKm: 2574.7, color: 0xd8a23e,
    pole: [36.4, 84],
    a: 1221865, e: 0.02871, i: 0.3477,
    node: [23.1427, -0.0012719], peri: [208.1886, 0.0014162], L: [11.7247, 22.576976086]
  },
  {
    name: 'Iapetus', parent: 'Saturn', radiusKm: 734.5, color: 0x8a7559,
    pole: [288.7, 78.9],
    a: 3560853, e: 0.02846, i: 7.5823,
    node: [74.7893, -0.0003145], peri: [351.3724, 0.0002715], L: [200.2368, 4.537946266]
  },
  {
    // Uranus's pole is entered as the one its moons go round anticlockwise, which is the
    // IAU south pole: the planet lies on its side and turns backwards.
    name: 'Miranda', parent: 'Uranus', radiusKm: 235.8, color: 0xc2c6c8,
    pole: [77.311, 15.175],
    a: 129848, e: 0.00136, i: 4.4268,
    node: [100.8594, -0.0554136], peri: [256.2683, 0.0547991], L: [328.6790, 254.690659135],
    // A three-body near-resonance with Ariel and Umbriel, beating every 12.5 years.
    wobble: [[1.4354, 318.018, 0.078554360], [0.1764, 276.150, 0.157108720]]
  },
  {
    name: 'Ariel', parent: 'Uranus', radiusKm: 578.9, color: 0xcfcdc8,
    pole: [77.311, 15.175],
    a: 190930, e: 0.00128, i: 0.0138,
    node: [268.1786, -0.0541785], peri: [68.0067, 0.0186982], L: [203.1131, 142.835648121],
    wobble: [[0.0983, 140.810, 0.078244826]]
  },
  {
    name: 'Umbriel', parent: 'Uranus', radiusKm: 584.7, color: 0x66656a,
    pole: [77.311, 15.175],
    a: 265982, e: 0.00375, i: 0.0744,
    node: [191.5391, -0.0079107], peri: [347.8526, 0.0082388], L: [251.2510, 86.868873525]
  },
  {
    name: 'Titania', parent: 'Uranus', radiusKm: 788.9, color: 0xb0a598,
    pole: [77.311, 15.175],
    a: 436283, e: 0.00141, i: 0.0808,
    node: [358.6865, 0.0022390], peri: [226.7762, 0.0037929], L: [281.5648, 41.351414818]
  },
  {
    name: 'Oberon', parent: 'Uranus', radiusKm: 761.4, color: 0x9a8d84,
    pole: [77.311, 15.175],
    a: 583451, e: 0.00146, i: 0.1864,
    node: [40.1494, -0.0017820], peri: [180.9576, 0.0019902], L: [352.5604, 26.739482227]
  },
  {
    // Retrograde: an inclination past 90 degrees carries Triton round against Neptune's spin.
    name: 'Triton', parent: 'Neptune', radiusKm: 1353.4, color: 0xd6c2b6,
    pole: [299.36, 43.46],
    a: 354759, e: 0, i: 156.8268,
    node: [177.8660, 0.0014340], peri: [0, 0], L: [236.4607, 61.260128334]
  }
];

const frames = new WeakMap();

function cross(a, b) {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

/**
 * The reference plane's axes in scene coordinates: X on its ascending node on the ICRF
 * equator, Z on its pole. For the ecliptic that node is the equinox, which is scene +X.
 */
function frameOf(moon) {
  let f = frames.get(moon);
  if (f) return f;
  if (!moon.pole) {
    f = { X: { x: 1, y: 0, z: 0 }, Y: { x: 0, y: 0, z: -1 }, Z: { x: 0, y: 1, z: 0 } };
  } else {
    const Z = equatorialToScene(moon.pole[0], moon.pole[1], {});
    const X = equatorialToScene(moon.pole[0] + 90, 0, {});
    f = { X, Y: cross(Z, X), Z };
  }
  frames.set(moon, f);
  return f;
}

function combine(f, x, y, z, out) {
  out.x = x * f.X.x + y * f.Y.x + z * f.Z.x;
  out.y = x * f.X.y + y * f.Y.y + z * f.Z.y;
  out.z = x * f.X.z + y * f.Y.z + z * f.Z.z;
}

/**
 * The orbit as it stands `days` of Terrestrial Time after J2000, in scene axes: `p` is the
 * unit vector from the planet to periapsis and `q` the one a quarter turn on, so the moon
 * is at a * ((cos E - e) * p + sqrt(1 - e * e) * sin E * q). `M` and `E` are the mean and
 * eccentric anomalies in radians.
 */
export function moonOrbit(moon, days, out) {
  out = out || { p: { x: 0, y: 0, z: 0 }, q: { x: 0, y: 0, z: 0 }, e: 0, M: 0, E: 0 };
  const node = (moon.node[0] + moon.node[1] * days) * DEG;
  const peri = moon.peri[0] + moon.peri[1] * days;
  let L = moon.L[0] + (moon.L[1] + (moon.L[2] || 0) * days) * days;
  if (moon.wobble) {
    for (const [amplitude, phase, rate] of moon.wobble) L += amplitude * Math.sin((phase + rate * days) * DEG);
  }
  const M = ((L - peri) % 360 + 540) % 360 - 180;
  const w = peri * DEG - node;
  const inc = moon.i * DEG;

  const cw = Math.cos(w), sw = Math.sin(w);
  const cO = Math.cos(node), sO = Math.sin(node);
  const ci = Math.cos(inc), si = Math.sin(inc);
  const f = frameOf(moon);
  combine(f, cw * cO - sw * sO * ci, cw * sO + sw * cO * ci, sw * si, out.p);
  combine(f, -sw * cO - cw * sO * ci, -sw * sO + cw * cO * ci, cw * si, out.q);

  out.e = moon.e;
  out.M = M * DEG;
  out.E = eccentricAnomaly(M, moon.e) * DEG;
  return out;
}

const scratch = moonOrbit({ node: [0, 0], peri: [0, 0], L: [0, 0], i: 0, e: 0 }, 0);

/** Position relative to the planet's centre, in km and scene axes. */
export function moonPosition(moon, days, out) {
  out = out || { x: 0, y: 0, z: 0 };
  const o = moonOrbit(moon, days, scratch);
  const along = moon.a * (Math.cos(o.E) - o.e);
  const across = moon.a * Math.sqrt(1 - o.e * o.e) * Math.sin(o.E);
  out.x = along * o.p.x + across * o.q.x;
  out.y = along * o.p.y + across * o.q.y;
  out.z = along * o.p.z + across * o.q.z;
  return out;
}

/** Orbital period in days: the time for the mean longitude to come round. */
export function moonPeriodDays(moon) {
  return 360 / moon.L[1];
}

/** Degrees of mean anomaly gained per day, which is how fast the moon laps its ellipse. */
export function moonLapRate(moon) {
  return moon.L[1] - moon.peri[1];
}

/**
 * Where each planet's moons are drawn, in display radii of the planet: [innermost orbit,
 * outermost orbit]. True distances will not do. The Moon is 60 Earth radii out, which at
 * the planets' exaggerated sizes is twice the gap to Venus, and Saturn's seven span 3 to
 * 59 radii. Each family is therefore spread by the logarithm of its semi-major axes
 * between these two radii: far enough apart not to touch as they pass, clear of the
 * rings, and clear of the neighbouring planets.
 */
const MOON_SPAN = {
  Earth: [2.4, 2.4],
  Mars: [1.7, 2.6],
  Jupiter: [1.6, 3.4],
  Saturn: [2.55, 6.5],
  Uranus: [1.7, 4.5],
  Neptune: [2.7, 2.7]
};

/**
 * Scene length of a moon's semi-major axis. Its orbit is drawn as the true ellipse scaled
 * to this size, so the shape, the plane and where the moon is along it are all real; only
 * the distance from the planet is not.
 */
export function moonDisplayAxis(moon) {
  const [inner, outer] = MOON_SPAN[moon.parent];
  const family = MOONS.filter((m) => m.parent === moon.parent).map((m) => m.a);
  const nearest = Math.min(...family), farthest = Math.max(...family);
  const t = farthest > nearest ? Math.log(moon.a / nearest) / Math.log(farthest / nearest) : 0;
  return displayRadius(BODIES.find((b) => b.name === moon.parent)) * (inner + (outer - inner) * t);
}
