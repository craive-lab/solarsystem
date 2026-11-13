/**
 * Checks the moons against the JPL Horizons ephemerides, and that their drawn orbits fit.
 * Run: node tools/test-moons.mjs
 *
 * moons-reference.json holds each moon's true position at 25 dates between 1975 and
 * 2075, none of them used in the fit. tools/fit-moons.mjs writes it.
 */

import { readFileSync } from 'node:fs';
import {
  BODIES, J2000, centuries, displayRadius, heliocentric, julianDate, scenePosition
} from '../src/main/resources/webapp/js/bodies.js';
import {
  MOONS, TT_MINUS_UTC_DAYS, moonDisplayAxis, moonPeriodDays, moonPosition
} from '../src/main/resources/webapp/js/moons.js';

const DEG = Math.PI / 180;
/** The worst direction error allowed, in degrees as seen from the planet. The fit's own worst is 0.29. */
const MAX_ANGLE = 0.35;
/** The worst error in distance allowed. The Sun pumps the Moon's by more than 1%. */
const MAX_RANGE = 0.02;

const fail = [];
function assert(cond, msg) {
  if (!cond) fail.push(msg);
}

const reference = JSON.parse(readFileSync(new URL('./moons-reference.json', import.meta.url), 'utf8'));

assert(MOONS.length === 20, `expected 20 moons, found ${MOONS.length}`);

// ---------------------------------------------------------------- where they are

const p = { x: 0, y: 0, z: 0 };
const rows = [];
for (const moon of MOONS) {
  assert(BODIES.some((b) => b.name === moon.parent), `${moon.name}: no planet called ${moon.parent}`);
  const truth = reference.moons[moon.name];
  assert(truth && truth.length >= 20, `${moon.name}: no reference positions`);
  if (!truth) continue;

  let worstAngle = 0, worstRange = 0;
  for (const [jd, x, y, z] of truth) {
    moonPosition(moon, jd - J2000, p);
    // The page's axes back into the ecliptic ones Horizons uses: north is +Y here, +Z there.
    const mx = p.x, my = -p.z, mz = p.y;
    const rm = Math.hypot(mx, my, mz), rt = Math.hypot(x, y, z);
    const angle = Math.acos(Math.min(1, (mx * x + my * y + mz * z) / (rm * rt))) / DEG;
    worstAngle = Math.max(worstAngle, angle);
    worstRange = Math.max(worstRange, Math.abs(rm - rt) / rt);
  }
  assert(worstAngle < MAX_ANGLE, `${moon.name}: ${worstAngle.toFixed(3)}° from Horizons, over ${MAX_ANGLE}°`);
  assert(worstRange < MAX_RANGE, `${moon.name}: range ${(worstRange * 100).toFixed(2)}% out`);
  rows.push(`    ${moon.name.padEnd(10)} ${worstAngle.toFixed(3)}°   range ${(worstRange * 100).toFixed(2)}%`
    + `   ${moonPeriodDays(moon).toFixed(3)} d`);
}

// The Moon's sidereal month, as a check that the rates mean what they say.
assert(Math.abs(moonPeriodDays(MOONS[0]) - 27.321662) < 1e-5, `sidereal month ${moonPeriodDays(MOONS[0])}`);

// Eclipses test the whole chain with nothing borrowed from Horizons: the page's UTC clock,
// the axes, and Earth's own orbit from bodies.js. At the middle of a solar eclipse the Moon
// is on the Sun as seen from Earth's centre, to within the degree the shadow can miss the
// centre by; at a lunar one it is opposite.
function sunMoonAngle(utc) {
  const jd = julianDate(Date.parse(utc));
  const e = heliocentric(BODIES.find((b) => b.name === 'Earth'), centuries(jd), 1);
  const m = moonPosition(MOONS[0], jd - J2000 + TT_MINUS_UTC_DAYS);
  const cos = -(e.x * m.x + e.y * m.y + e.z * m.z) / (Math.hypot(e.x, e.y, e.z) * Math.hypot(m.x, m.y, m.z));
  return Math.acos(cos) / DEG;
}
const solar = sunMoonAngle('2024-04-08T18:17:00Z');
const lunar = sunMoonAngle('2025-09-07T18:12:00Z');
assert(solar < 0.7, `8 April 2024 solar eclipse: the Moon is ${solar.toFixed(2)}° from the Sun`);
assert(lunar > 179.4, `7 September 2025 lunar eclipse: the Moon is ${lunar.toFixed(2)}° from the Sun`);

// ---------------------------------------------------------------- where they are drawn

const SATURN_RING_OUTER = BODIES.find((b) => b.name === 'Saturn').ring.outer;

for (const planet of BODIES) {
  const family = MOONS.filter((m) => m.parent === planet.name)
    .map((moon) => ({ moon, axis: moonDisplayAxis(moon), radius: displayRadius(moon) }));
  if (!family.length) continue;
  family.sort((a, b) => a.axis - b.axis);

  // The innermost clears the planet, and Saturn's clears the rings.
  const first = family[0];
  const floor = displayRadius(planet) * (planet.ring ? SATURN_RING_OUTER : 1);
  assert(first.axis * (1 - first.moon.e) - first.radius > floor,
    `${first.moon.name} is drawn inside ${planet.name}${planet.ring ? "'s rings" : ''}`);

  // Neighbours never touch, even with one at its farthest and the next at its nearest.
  for (let n = 1; n < family.length; n++) {
    const inner = family[n - 1], outer = family[n];
    const gap = outer.axis * (1 - outer.moon.e) - inner.axis * (1 + inner.moon.e) - inner.radius - outer.radius;
    assert(gap > 0, `${inner.moon.name} and ${outer.moon.name} can touch: gap ${gap.toFixed(3)}`);
    assert(outer.moon.a > inner.moon.a, `${planet.name}: drawn order differs from the true order`);
  }
}

// The Moon is the tight one: Venus passes within two scene units of Earth. Earth at
// perihelion and Venus at aphelion on the same side of the Sun is as close as they get.
const earth = BODIES.find((b) => b.name === 'Earth'), venus = BODIES.find((b) => b.name === 'Venus');
const orbitRadius = (body, far) => {
  const a = body.elements.a[0], e = body.elements.e[0];
  return 12 * Math.pow(a * (far ? 1 + e : 1 - e), 0.55); // the radial warp in bodies.js
};
const luna = MOONS[0];
const moonReach = moonDisplayAxis(luna) * (1 + luna.e) + displayRadius(luna);
const venusGap = orbitRadius(earth, false) - orbitRadius(venus, true) - displayRadius(venus);
assert(moonReach < venusGap, `the Moon reaches ${moonReach.toFixed(3)} from Earth, Venus comes within ${venusGap.toFixed(3)}`);

// And the warp constants assumed just above are still the ones bodies.js uses.
const probe = scenePosition(earth, 0, 1);
assert(Math.abs(Math.hypot(probe.x, probe.y, probe.z) - 12 * Math.pow(probe.radiusAu, 0.55)) < 1e-9,
  'the radial warp in bodies.js has changed; update orbitRadius() here');

if (fail.length) {
  console.error('FAIL\n' + fail.map((f) => '  ' + f).join('\n'));
  process.exit(1);
}
console.log(`ok  20 moons within ${MAX_ANGLE}° of JPL Horizons at 25 dates each, 1975-2075.`);
console.log('    worst direction error, worst range error, period:');
console.log(rows.join('\n'));
console.log(`    Sun to Moon ${solar.toFixed(2)}° at the 2024 solar eclipse, ${lunar.toFixed(2)}° at the 2025 lunar one.`);
console.log('    drawn orbits clear their planets, Saturn\'s rings, each other, and Venus.');
