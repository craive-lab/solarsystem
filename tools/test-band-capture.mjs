/**
 * Mapping and camera-aim checks for the CRAIVE band capture.
 * Run: node tools/test-band-capture.mjs
 */

import * as THREE from '../src/main/resources/webapp/vendor/three.module.js';
import { bandDirection, sliceWeight, selfTestBandMath } from '../src/main/resources/webapp/js/bandMath.js';
import { aimYawOnly, angularSize } from '../src/main/resources/webapp/js/billboard.js';

const BAND = {
  height: 1200,
  width: 11636,
  outputWidth: 15360,
  frontCenter: 6317,
  entranceStart: 11165,
  entranceEnd: 11636,
  elevationCenter: 5,
  verticalFov: 37.13,
  slices: 8,
  overlapPx: 8,
  cubeSize: 2048
};

const fail = [];
function assert(cond, msg) {
  if (!cond) fail.push(msg);
}

const mathFails = selfTestBandMath(BAND);
for (const m of mathFails) fail.push('bandMath: ' + m);

const frontFrac = BAND.frontCenter / BAND.width;
const elevCenter = THREE.MathUtils.degToRad(BAND.elevationCenter);
const vFov = THREE.MathUtils.degToRad(BAND.verticalFov);
const entranceU = BAND.entranceStart / BAND.width;
const out = { x: 0, y: 0, z: 0 };

assert(BAND.outputWidth === 15360, `outputWidth ${BAND.outputWidth}`);
assert(BAND.height === 1200, `height ${BAND.height}`);
assert(Math.abs(BAND.outputWidth / 8 - 1920) < 1e-9, 'slice width is 1920');

const frontCanvasX = frontFrac * BAND.outputWidth;
assert(Math.abs(frontCanvasX / (BAND.outputWidth / BAND.width) - BAND.frontCenter) < 1e-6,
  `front wall canvas x ${frontCanvasX} should map back to band x ${BAND.frontCenter}`);

bandDirection(frontFrac, 0.5, 0, frontFrac, elevCenter, vFov, out);
const sunFromStart = { x: 0, y: 6, z: -30 };
const sunLen = Math.hypot(sunFromStart.x, sunFromStart.y, sunFromStart.z);
const sunDir = { x: sunFromStart.x / sunLen, y: sunFromStart.y / sunLen, z: sunFromStart.z / sunLen };
const sunDot = out.x * sunDir.x + out.y * sunDir.y + out.z * sunDir.z;
assert(sunDot > 0.95, `Sun at heading 0 should sit on the front-wall centre ray, dot=${sunDot.toFixed(4)}`);

const cam = new THREE.PerspectiveCamera(37.13, 1920 / 1200, 0.05, 9000);
const origin = new THREE.Vector3();
const dir = new THREE.Vector3();
const look = new THREE.Vector3();
const vHorizon = 0.5 - elevCenter / vFov;

function aim(u, v, yaw) {
  bandDirection(u, v, yaw, frontFrac, elevCenter, vFov, dir);
  cam.position.copy(origin);
  cam.up.set(0, 1, 0);
  cam.lookAt(dir.x, dir.y, dir.z);
  cam.updateMatrixWorld();
  cam.getWorldDirection(look);
}

aim(frontFrac, vHorizon, 0);
assert(look.distanceTo(new THREE.Vector3(0, 0, -1)) < 1e-5,
  `lookAt horizon ahead: ${look.x.toFixed(6)}, ${look.y.toFixed(6)}, ${look.z.toFixed(6)}`);

aim(frontFrac, vHorizon, Math.PI / 2);
assert(look.distanceTo(new THREE.Vector3(1, 0, 0)) < 1e-5,
  `lookAt horizon starboard: ${look.x.toFixed(6)}, ${look.y.toFixed(6)}, ${look.z.toFixed(6)}`);

aim(frontFrac, 0.5, 0);
const pitched = new THREE.Vector3(0, Math.sin(elevCenter), -Math.cos(elevCenter));
assert(look.distanceTo(pitched) < 1e-5,
  `optical axis at +5°: ${look.x.toFixed(6)}, ${look.y.toFixed(6)}, ${look.z.toFixed(6)}`);

const ov = BAND.overlapPx / BAND.outputWidth;
let entranceWeight = 0;
for (let i = 0; i < BAND.slices; i++) {
  entranceWeight += sliceWeight(i, (BAND.entranceStart + 10) / BAND.width, BAND.slices, ov, entranceU);
}
assert(entranceWeight === 0, `entrance still has weight ${entranceWeight}`);

const hudNdcX = (BAND.frontCenter / BAND.width) * 2 - 1;
assert(Math.abs(hudNdcX) < 1, `HUD ndc x ${hudNdcX} on the front wall`);

assert(Math.abs(angularSize(10, 2 * Math.atan(0.5) * 180 / Math.PI) - 10) < 1e-6,
  'angularSize: 2*d*tan(θ/2) round-trips');

const quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1));
const zWorld = new THREE.Vector3();
const yWorld = new THREE.Vector3();
function checkBillboard(pos, view, expectZ, tag) {
  quad.position.copy(pos);
  assert(aimYawOnly(quad, view), `${tag}: aimYawOnly returned false`);
  quad.updateMatrixWorld();
  quad.getWorldDirection(zWorld);
  yWorld.set(0, 1, 0).applyQuaternion(quad.quaternion);
  assert(zWorld.dot(expectZ) > 0.999, `${tag}: +Z is ${zWorld.x.toFixed(3)},${zWorld.y.toFixed(3)},${zWorld.z.toFixed(3)}`);
  assert(yWorld.dot(new THREE.Vector3(0, 1, 0)) > 0.999, `${tag}: up tilted`);
}
checkBillboard(new THREE.Vector3(0, 0, 10), new THREE.Vector3(0, -6, 0), new THREE.Vector3(0, 0, -1), 'ahead');
checkBillboard(new THREE.Vector3(10, 2, 0), new THREE.Vector3(0, -6, 0), new THREE.Vector3(-1, 0, 0), 'starboard');
assert(aimYawOnly(quad, quad.position.clone().add(new THREE.Vector3(0, 5, 0))) === false,
  'directly above should leave yaw alone');

if (fail.length) {
  console.error('FAIL\n' + fail.map((f) => '  ' + f).join('\n'));
  process.exit(1);
}
console.log('ok  canvas 15360×1200, 8×1920 slices, front wall = band x 6317,');
console.log('    Sun on the front-wall ray at heading 0, entrance weight 0,');
console.log('    lookAt -Z at yaw 0 / +X at yaw 90°, optical axis pitched +5°.');
console.log('    yaw-only quads face the ship in XZ and stay upright.');
