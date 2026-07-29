/**
 * The RPI CRAIVE Lab front end: the solar system seen from inside a spaceship whose
 * walls are windows.
 *
 * The lab is a walk-in panoramic room — a continuous projection band around four walls,
 * eight WUXGA projectors warped and edge-blended by Pixelwarp. This page renders that
 * band live: a CubeCamera photographs the scene in all six directions from the ship, and
 * a fragment shader unwraps the cube into the band's 360-degree strip. So there is no
 * "screen" the audience looks at — the system is simply around them.
 *
 * Geometry is the lab's published content-creator spec:
 *
 *   band     1200 x 11636 px   physical pixels around the room
 *   output   1200 x 15360 px   what Pixelwarp ingests (8 x 1920); the 132% horizontal
 *                              stretch is inherent in rendering the band across it
 *   front wall centre at band x = 6317, entrance gap 11165..11636 left black
 *   band spans 37.13 degrees of elevation, centred 5 degrees above the horizon
 *
 * The audio listener rides with the ship rather than sitting on a planet, so the nine
 * voices are heard from wherever the room currently is. Flying past Jupiter, you hear it
 * pass down one side of the room.
 */

import * as THREE from 'three';
import { BODIES, julianDate, centuries, J2000 } from './bodies.js';
import { SolarSystemScene } from './scenery.js';
import { AudioEngine, computeField } from './audio.js';
import { OscBridge } from './oscbridge.js';
import { savedWsUrl, checkWsUrl } from './ui.js';

/** The lab's screen, from `CRAIVE specs for content creators` (J. Parkman Carter, RPI). */
const BAND = {
  height: 1200,
  width: 11636,        // physical px around the band
  outputWidth: 15360,  // fattened canvas Pixelwarp expects
  frontCenter: 6317,   // band px at the centre of the front wall
  entranceStart: 11165,
  entranceEnd: 11636,
  elevationCenter: 5,  // degrees above the horizon at the band's vertical centre
  verticalFov: 37.13,  // degrees of elevation the band height spans
  cubeSize: 1024       // per cube face; raise toward 2048+ if the GPU keeps up
};

/**
 * Flight model. Yaw only: a room full of people should never have the horizon roll, and
 * the speeds are deliberately unhurried — this is a space you walk around inside, not a
 * game. Earth's orbit has a radius of 12 scene units and Neptune's about 78.
 */
const SHIP = {
  speed: 14,        // scene units per second
  boost: 4,         // multiplier while Shift is held
  turnRate: 30,     // degrees per second
  startRadius: 30,
  // Start below the ecliptic, so the system reads as a disc rather than the edge-on line
  // it becomes from within the plane — and specifically below rather than above, because
  // the band is not symmetric: it reaches 23.6 degrees above the horizon but only 13.6
  // below. Looking up at the disc therefore has most of the room's pixels to spread into.
  // At this height the Sun sits about 11 degrees up, just above the band's midline.
  startHeight: -6,
  minRadius: 3.2    // never fly into the middle of the Sun
};

const state = {
  epochJd: julianDate(Date.now()),
  simDays: 0,
  daysPerSecond: 8,
  paused: false,
  tiltGain: 1,
  oscRateHz: 30
};

// ---------------------------------------------------------------- renderer

const canvas = document.getElementById('band');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.setPixelRatio(1);

// Render at the Pixelwarp canvas size when the GPU allows; otherwise at the widest it
// does, and let CSS scale it out to the spanned desktop. The aspect is what matters.
const maxTexture = renderer.capabilities.maxTextureSize;
const outW = Math.min(BAND.outputWidth, maxTexture);
const outH = Math.max(1, Math.round(outW * (BAND.height / BAND.outputWidth)));
renderer.setSize(outW, outH, false);

// The star field is captured into 1024 px cube faces rather than a wide desktop canvas,
// so unattenuated points would read as too large on the wall.
const sky = new SolarSystemScene({ starSize: 1.1 });
const { positions, velocities, phases } = sky;
const field = [];

// ---------------------------------------------------------------- band projection

const cubeTarget = new THREE.WebGLCubeRenderTarget(BAND.cubeSize);
const cubeCamera = new THREE.CubeCamera(0.05, 9000, cubeTarget);
sky.scene.add(cubeCamera);

const bandCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const bandMaterial = new THREE.ShaderMaterial({
  uniforms: {
    uCube: { value: cubeTarget.texture },
    uYaw: { value: 0 },
    uFrontFrac: { value: BAND.frontCenter / BAND.width },
    uEntrance: {
      value: new THREE.Vector2(BAND.entranceStart / BAND.width, BAND.entranceEnd / BAND.width)
    },
    uElevCenter: { value: THREE.MathUtils.degToRad(BAND.elevationCenter) },
    uVFov: { value: THREE.MathUtils.degToRad(BAND.verticalFov) }
  },
  depthTest: false,
  depthWrite: false,
  vertexShader: `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
  `,
  fragmentShader: `
    uniform samplerCube uCube;
    uniform float uYaw;
    uniform float uFrontFrac;
    uniform float uElevCenter;
    uniform float uVFov;
    uniform vec2 uEntrance;
    varying vec2 vUv;
    void main() {
      // The entrance corridor pierces the screen; project black there so nobody
      // walking in is dazzled.
      if (vUv.x >= uEntrance.x && vUv.x <= uEntrance.y) {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
      }
      // Band x maps to azimuth about the front wall's centre, band y to elevation.
      float theta = (vUv.x - uFrontFrac) * 6.283185307179586 + uYaw;
      float phi = uElevCenter + (vUv.y - 0.5) * uVFov;
      float cp = cos(phi);
      vec3 dir = vec3(sin(theta) * cp, sin(phi), -cos(theta) * cp);
      gl_FragColor = textureCube(uCube, dir);
    }
  `
});
const bandScene = new THREE.Scene();
bandScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bandMaterial));

// ---------------------------------------------------------------- the ship

const ship = {
  position: new THREE.Vector3(0, SHIP.startHeight, SHIP.startRadius),
  velocity: new THREE.Vector3(),
  // Heading 0 points along -Z, which from the starting position on +Z is straight at the
  // Sun: the system is dead ahead on the front wall when the doors open.
  yaw: 0,
  index: -1,             // the listener is not a body, it is the room
  name: 'CRAIVE'
};

const forward = new THREE.Vector3(0, 0, -1);
const shipUp = new THREE.Vector3(0, 1, 0);
const prevPosition = new THREE.Vector3().copy(ship.position);
const held = new Set();

/**
 * Arrow keys fly, PageUp/PageDown climb and dive. Keys are collected here and applied
 * once per frame, so a held key glides instead of stuttering at the OS repeat rate.
 */
const FLIGHT_KEYS = new Set([
  'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'pageup', 'pagedown', 'shift'
]);

window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (!FLIGHT_KEYS.has(k) || e.ctrlKey || e.metaKey || e.altKey) return;
  held.add(k);
  e.preventDefault(); // these keys would otherwise scroll the page
});
window.addEventListener('keyup', (e) => held.delete(e.key.toLowerCase()));
// Alt-tabbing away eats the keyup, and a blurred window must not keep flying.
window.addEventListener('blur', () => held.clear());

function flyShip(dt) {
  // Increasing yaw swings the heading from -Z toward +X, which is clockwise seen from
  // above: a turn to starboard. So the right arrow adds and the left arrow subtracts.
  const turn = (held.has('arrowright') ? 1 : 0) - (held.has('arrowleft') ? 1 : 0);
  if (turn) ship.yaw += turn * THREE.MathUtils.degToRad(SHIP.turnRate) * dt;

  // Level flight: the heading never pitches, so the room's horizon stays put.
  forward.set(Math.sin(ship.yaw), 0, -Math.cos(ship.yaw));

  let move = (held.has('arrowup') ? 1 : 0) - (held.has('arrowdown') ? 1 : 0);
  const climb = (held.has('pageup') ? 1 : 0) - (held.has('pagedown') ? 1 : 0);
  if (!move && !climb) return;

  const speed = SHIP.speed * (held.has('shift') ? SHIP.boost : 1) * dt;
  ship.position.addScaledVector(forward, move * speed);
  ship.position.y += climb * speed;

  // Push back out if someone flies into the Sun.
  const r = ship.position.length();
  if (r < SHIP.minRadius) ship.position.multiplyScalar(SHIP.minRadius / Math.max(r, 1e-6));
}

// ---------------------------------------------------------------- audio and OSC

const audio = new AudioEngine(BODIES);
const oscBridge = new OscBridge(BODIES);

const hud = {
  status: document.getElementById('hud-status'),
  position: document.getElementById('hud-position'),
  nearest: document.getElementById('hud-nearest'),
  gate: document.getElementById('gate')
};

async function launch() {
  hud.gate.classList.add('hiding');
  setTimeout(() => hud.gate.remove(), 600);
  try {
    await audio.start();
    oscBridge.sendAudioState(true);
  } catch (err) {
    console.error(err);
    setStatus('audio unavailable: ' + err.message);
  }
}

document.getElementById('gate-start').addEventListener('click', launch);

function setStatus(text) {
  hud.status.textContent = text;
}

function connectOsc(url) {
  if (!url) { setStatus('OSC: no WebSocket server configured'); return; }
  const problem = checkWsUrl(url);
  if (problem) { setStatus('OSC: ' + problem); return; }
  oscBridge.connect(url);
}

oscBridge.addEventListener('state', (e) => {
  const { state: s, error } = e.detail;
  setStatus('OSC: ' + (s === 'connected' ? 'streaming to ' + oscBridge.url : s)
    + (error && s !== 'connected' ? ' — ' + error : ''));
});

(async () => {
  let serverUrl = '';
  try {
    serverUrl = (await (await fetch('api/config')).json()).wsUrl || '';
  } catch { /* the band still flies without OSC */ }
  connectOsc(savedWsUrl() || serverUrl);
})();

// ---------------------------------------------------------------- loop

const clock = new THREE.Clock();
let oscAccumulator = 0;
let hudAccumulator = 0;

function tick() {
  const dt = Math.min(clock.getDelta(), 0.1);
  if (!state.paused) state.simDays += dt * state.daysPerSecond;

  const jd = state.epochJd + state.simDays;
  const T = centuries(jd);

  sky.step(T, state.tiltGain, state.daysPerSecond);
  sky.refreshOrbitLines(T, state.tiltGain);

  prevPosition.copy(ship.position);
  flyShip(dt);
  // The ship's own motion matters to the Doppler shift as much as the planets' does.
  ship.velocity.copy(ship.position).sub(prevPosition).divideScalar(Math.max(dt, 1e-4));

  computeField(positions, velocities, ship, forward, shipUp, field);

  // The band's angular resolution is about 1852 px per radian vertically, roughly half
  // that of the desktop view, so beacons and labels want proportionally smaller worlds.
  sky.syncVisuals(ship.position, 0.016, 0.012);

  audio.update(positions, field, ship, forward, shipUp, phases);

  if (state.oscRateHz > 0) {
    oscAccumulator += dt;
    if (oscAccumulator >= 1 / state.oscRateHz) {
      oscAccumulator = 0;
      oscBridge.sendFrame({
        positions, field, listener: ship, fwd: forward, up: shipUp, phases,
        simDays: state.simDays, j2000Days: jd - J2000,
        daysPerSecond: state.daysPerSecond, paused: state.paused
      });
    }
  }

  hudAccumulator += dt;
  if (hudAccumulator >= 0.2) {
    hudAccumulator = 0;
    updateHud();
  }

  // Photograph the whole sky from the ship, then unwrap it onto the band.
  cubeCamera.position.copy(ship.position);
  cubeCamera.update(renderer, sky.scene);
  bandMaterial.uniforms.uYaw.value = ship.yaw;
  renderer.render(bandScene, bandCamera);
}

function updateHud() {
  const p = ship.position;
  const auFromSun = Math.pow(p.length() / 12, 1 / 0.55); // inverse of the display warp
  hud.position.textContent =
    `${p.x.toFixed(0)}, ${p.y.toFixed(0)}, ${p.z.toFixed(0)}  ·  ${auFromSun.toFixed(2)} AU from the Sun`
    + `  ·  heading ${((THREE.MathUtils.radToDeg(ship.yaw) % 360 + 360) % 360).toFixed(0)}°`;

  let nearest = 0;
  for (let n = 1; n < field.length; n++) {
    if (field[n].distance < field[nearest].distance) nearest = n;
  }
  const g = field[nearest];
  hud.nearest.textContent = g
    ? `nearest: ${BODIES[nearest].name} (${BODIES[nearest].sound.note}) · ${g.distance.toFixed(1)} units · az ${g.azimuth.toFixed(0)}°`
    : '';
}

renderer.setAnimationLoop(tick);
