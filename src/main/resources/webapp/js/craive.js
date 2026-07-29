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
import { BodyList, Controls, savedWsUrl, checkWsUrl, speedFromSlider, typingIn } from './ui.js';

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

// Defaults match the control panel's initial slider positions.
const state = {
  epochJd: julianDate(Date.now()),
  simDays: 0,
  daysPerSecond: speedFromSlider(583),
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
  if (typingIn(e.target)) return; // the panels carry text boxes now
  const k = e.key.toLowerCase();
  if (k === ' ') { e.preventDefault(); togglePause(); return; }
  if (k >= '1' && k <= '9' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    flyTo(Number(k) - 1);
    return;
  }
  if (k === 'h' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    // Anything in the DOM is projected onto the wall along with the band, so the
    // operator's readouts need a way to get out of the picture.
    document.body.classList.toggle('bare');
    return;
  }
  if (!FLIGHT_KEYS.has(k) || e.ctrlKey || e.metaKey || e.altKey) return;
  held.add(k);
  if (k !== 'shift') travel.index = -1; // taking the controls cancels an approach
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

// ---------------------------------------------------------------- pick and approach

/**
 * Clicking a body flies the room to it rather than cutting: an instant jump is
 * disorienting when the audience is standing up inside the picture. The approach eases
 * in and then holds station, so the body stays framed as it carries on along its orbit
 * until someone takes the controls again.
 */
const travel = { index: -1 };
const pickDir = new THREE.Vector3();
const toBody = new THREE.Vector3();
const toTarget = new THREE.Vector3();
const standpoint = new THREE.Vector3();

/** How close to a body's bearing a click has to land, in degrees. */
const PICK_TOLERANCE = 2.5;

/**
 * Inverts the band mapping — canvas pixel to azimuth and elevation to a world direction
 * from the ship — so the panorama can be clicked despite being an unwrapped projection.
 *
 * The hit test is angular rather than a raycast against the geometry. Partly because
 * that is the natural question on a band ("which body lies along this bearing?"), and
 * partly because it has to be: three.js resolves a Sprite hit by projecting it through
 * `raycaster.camera`, and a panorama assembled from six cube faces has no single camera
 * to offer. Testing bearings instead also gives every body the same generous target,
 * which matters when someone is pointing at a wall several metres away.
 */
function pickAt(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const u = (clientX - rect.left) / rect.width;
  const v = 1 - (clientY - rect.top) / rect.height; // texture v runs bottom-up
  if (u < 0 || u > 1 || v < 0 || v > 1) return -1;
  const entrance = bandMaterial.uniforms.uEntrance.value;
  if (u >= entrance.x && u <= entrance.y) return -1; // the entrance shows nothing to hit

  const theta = (u - BAND.frontCenter / BAND.width) * Math.PI * 2 + ship.yaw;
  const phi = THREE.MathUtils.degToRad(BAND.elevationCenter)
            + (v - 0.5) * THREE.MathUtils.degToRad(BAND.verticalFov);
  const cp = Math.cos(phi);
  pickDir.set(Math.sin(theta) * cp, Math.sin(phi), -Math.cos(theta) * cp);

  let best = -1;
  let bestDot = -1;
  for (let n = 0; n < positions.length; n++) {
    toBody.copy(positions[n]).sub(ship.position);
    const distance = toBody.length();
    if (distance < 1e-6) continue;
    toBody.divideScalar(distance);
    const dot = toBody.dot(pickDir);
    // Generous near a small distant body, and at least as large as a close one looks.
    const reach = Math.max(THREE.MathUtils.degToRad(PICK_TOLERANCE),
                           Math.atan2(sky.objects[n].radius, distance));
    if (dot >= Math.cos(reach) && dot > bestDot) {
      bestDot = dot;
      best = n;
    }
  }
  return best;
}

/** How far off to hold station, so the body roughly fills the band's 37 degrees. */
function standoffFrom(index) {
  return THREE.MathUtils.clamp(sky.objects[index].radius * 9, 4.5, 30);
}

function flyTo(index) {
  if (index < 0) return;
  travel.index = index;
  sky.setHighlight(index);
}

function updateApproach(dt) {
  if (travel.index < 0) return;
  const target = positions[travel.index];
  toTarget.copy(target).sub(ship.position);

  // Stand off along the line we are already approaching from, dipped below the ecliptic
  // so the body sits in the upper part of the band where there is the most room.
  standpoint.copy(ship.position).sub(target);
  if (standpoint.lengthSq() < 1e-6) standpoint.set(0, -1, 1);
  standpoint.normalize();
  standpoint.y = -0.28;
  standpoint.normalize().multiplyScalar(standoffFrom(travel.index)).add(target);

  // Exponential easing, so the rate does not depend on the frame rate.
  ship.position.lerp(standpoint, 1 - Math.exp(-1.6 * dt));

  const wantYaw = Math.atan2(toTarget.x, -toTarget.z);
  let turn = wantYaw - ship.yaw;
  turn = Math.atan2(Math.sin(turn), Math.cos(turn)); // take the short way round
  ship.yaw += turn * (1 - Math.exp(-3 * dt));
}

let downAt = null;
canvas.addEventListener('pointerdown', (e) => { downAt = { x: e.clientX, y: e.clientY }; });
canvas.addEventListener('pointerup', (e) => {
  if (!downAt) return;
  const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
  downAt = null;
  if (moved <= 6) flyTo(pickAt(e.clientX, e.clientY));
});

// ---------------------------------------------------------------- audio and OSC

const audio = new AudioEngine(BODIES);
const oscBridge = new OscBridge(BODIES);

const hud = {
  position: document.getElementById('hud-position'),
  nearest: document.getElementById('hud-nearest'),
  gate: document.getElementById('gate')
};

// The same list the desktop view carries, with the same live bearings and levels.
// Nobody stands on a body here, so every row reports one, including the Sun.
const bodyList = new BodyList(document.getElementById('body-list'), BODIES, flyTo);

function togglePause() {
  state.paused = !state.paused;
  controls.setPaused(state.paused);
}

// The same Time, Audio and OSC panels as the desktop view, built by the shared Controls.
// No "face direction of travel" switch: on the band the listener is the ship, and it
// always faces where the ship is pointing.
const controls = new Controls(document.getElementById('right-panel'), {
  onTogglePause: togglePause,
  onNow: () => { state.simDays = 0; state.epochJd = julianDate(Date.now()); },
  onSpeed: (d) => { state.daysPerSecond = d; },
  onTilt: (t) => { state.tiltGain = t; },
  onVolume: (v) => audio.setVolume(v),
  onDoppler: (on) => audio.setDoppler(on),
  onLabels: (on) => sky.setDecor(on),
  onOscRate: (hz) => { state.oscRateHz = hz; },
  onWsUrl: connectOsc,
  onToggleAudio: () => {
    if (audio.running) {
      audio.stop();
      controls.setAudioRunning(false);
      oscBridge.sendAudioState(false);
    } else {
      launch();
    }
  }
}, { heading: false });

async function launch() {
  const gate = document.getElementById('gate');
  if (gate) {
    gate.classList.add('hiding');
    setTimeout(() => gate.remove(), 600);
  }
  try {
    await audio.start();
    controls.setAudioRunning(true);
    oscBridge.sendAudioState(true);
  } catch (err) {
    console.error(err);
    controls.setOscState('error', 'audio unavailable: ' + err.message);
  }
}

document.getElementById('gate-start').addEventListener('click', launch);

function connectOsc(url) {
  controls.setActiveWsUrl(url);
  if (!url) {
    oscBridge.disconnect();
    controls.setOscState('idle');
    return;
  }
  const problem = checkWsUrl(url);
  if (problem) {
    oscBridge.disconnect();
    controls.setOscState('error', problem);
    return;
  }
  oscBridge.connect(url);
}

oscBridge.addEventListener('state', (e) => controls.setOscState(e.detail.state, e.detail.error));

(async () => {
  let serverUrl = '';
  try {
    serverUrl = (await (await fetch('api/config')).json()).wsUrl || '';
  } catch { /* the band still flies without OSC */ }
  controls.setServerWsUrl(serverUrl);
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
  updateApproach(dt);
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

  // Text writes force layout, and none of these readouts need 60 fps.
  hudAccumulator += dt;
  if (hudAccumulator >= 0.1) {
    hudAccumulator = 0;
    updateHud();
    bodyList.update(field, travel.index, -1);
    controls.setTime(jd);
    controls.setOscStats(oscBridge.sent);
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
