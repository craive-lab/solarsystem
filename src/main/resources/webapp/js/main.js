/**
 * Scene assembly, simulation loop and wiring.
 *
 * The listener stands on one body and faces along its direction of travel. Every other
 * body is a PannerNode at its real (compressed) position, so selecting a different body
 * genuinely changes what you hear rather than just moving the camera. The same geometry
 * that drives the audio is what goes out over OSC.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { BODIES, displayRadius, julianDate, centuries, J2000 } from './bodies.js';
import { SolarSystemScene } from './scenery.js';
import { AudioEngine, computeField } from './audio.js';
import { OscBridge } from './oscbridge.js';
import { Radar } from './radar.js';
import { UI, speedFromSlider, savedWsUrl, checkWsUrl } from './ui.js';

const state = {
  epochJd: julianDate(Date.now()),
  simDays: 0,
  daysPerSecond: speedFromSlider(583),
  paused: false,
  tiltGain: 1.0,
  listener: 3,            // Earth
  headingMode: 'orbit',   // 'orbit' or 'camera'
  oscRateHz: 30,
  showDecor: true
};

// ---------------------------------------------------------------- renderer

const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.05, 6000);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.enablePan = false;      // the target tracks the selected body
controls.minDistance = 1.0;
controls.maxDistance = 900;
controls.zoomSpeed = 0.8;

// ---------------------------------------------------------------- scene

const sky = new SolarSystemScene();
const scene = sky.scene;
const { objects, positions, velocities, phases, pickables } = sky;
const field = [];

const fwd = new THREE.Vector3(0, 0, -1);
const up = new THREE.Vector3(0, 1, 0);
const listener = { position: positions[state.listener], velocity: velocities[state.listener], index: state.listener, name: BODIES[state.listener].name };

/**
 * Where the listener stands and which way it faces. On a planet that is the body's own
 * position and its direction of travel, so the whole sound field rotates as it orbits.
 */
function updateListenerFrame() {
  const n = state.listener;
  listener.position = positions[n];
  listener.velocity = velocities[n];
  listener.index = n;
  listener.name = BODIES[n].name;

  if (state.headingMode === 'camera') {
    camera.getWorldDirection(fwd);
    up.set(0, 1, 0).applyQuaternion(camera.quaternion).normalize();
    return;
  }
  if (!BODIES[n].elements) {
    // The Sun does not travel, but it does rotate; its spin becomes the heading, so the
    // planets drift slowly around your head over about 25 days.
    fwd.set(Math.cos(phases[n]), 0, Math.sin(phases[n]));
    up.set(0, 1, 0);
    return;
  }
  fwd.copy(velocities[n]);
  if (fwd.lengthSq() < 1e-14) fwd.set(0, 0, -1); else fwd.normalize();

  up.copy(positions[n]).cross(velocities[n]);       // orbital angular momentum
  if (up.lengthSq() < 1e-14) up.set(0, 1, 0); else up.normalize();
  up.addScaledVector(fwd, -up.dot(fwd)).normalize(); // exactly orthogonal
}

// ---------------------------------------------------------------- camera follow

const camOffset = new THREE.Vector3();
const transStart = new THREE.Vector3();
let transition = 1;
let transStartDist = 0;
let transEndDist = 0;

const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function desiredDistance(index) {
  if (index === 0) return 26;
  return THREE.MathUtils.clamp(displayRadius(BODIES[index]) * 14, 4.5, 26);
}

function selectBody(index) {
  if (index === state.listener || index < 0) return;
  state.listener = index;
  transStart.copy(controls.target);
  transStartDist = camera.position.distanceTo(controls.target);
  transEndDist = desiredDistance(index);
  transition = 0;
  ui.setSelected(index);
  oscBridge.sendSelect(index, BODIES[index].name);
  sky.setHighlight(index);
}

// ---------------------------------------------------------------- picking

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const tooltip = document.getElementById('tooltip');
let hoverPixel = null;
let downAt = null;

function pickAt(clientX, clientY) {
  pointer.x = (clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(pickables, false);
  return hits.length ? hits[0].object.userData.index : -1;
}

canvas.addEventListener('pointerdown', (e) => { downAt = { x: e.clientX, y: e.clientY }; });
canvas.addEventListener('pointerup', (e) => {
  if (!downAt) return;
  const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
  downAt = null;
  if (moved > 6) return;               // that was an orbit drag, not a click
  selectBody(pickAt(e.clientX, e.clientY));
});
canvas.addEventListener('pointermove', (e) => { hoverPixel = { x: e.clientX, y: e.clientY }; });
canvas.addEventListener('pointerleave', () => { hoverPixel = null; });

let cursor = '';
function setCursor(value) {
  if (cursor === value) return;
  cursor = value;
  canvas.style.cursor = value;
}

function updateHover() {
  if (!hoverPixel) { tooltip.hidden = true; setCursor('grab'); return; }
  const index = pickAt(hoverPixel.x, hoverPixel.y);
  if (index < 0) {
    tooltip.hidden = true;
    setCursor('grab');
    return;
  }
  const body = BODIES[index];
  const g = field[index];
  setCursor('pointer');
  tooltip.hidden = false;
  tooltip.style.left = hoverPixel.x + 'px';
  tooltip.style.top = hoverPixel.y + 'px';
  tooltip.textContent = index === state.listener
    ? `${body.name} · you are here`
    : `${body.name} · ${body.sound.note} · az ${g.azimuth.toFixed(0)}° · ${(g.gain * 100).toFixed(0)}%`;
}

// ---------------------------------------------------------------- audio and OSC

const audio = new AudioEngine(BODIES);
const oscBridge = new OscBridge(BODIES);
const radar = new Radar(document.getElementById('radar'), BODIES);

async function startAudio() {
  try {
    await audio.start();
    ui.setAudioRunning(true);
    oscBridge.sendAudioState(true);
  } catch (err) {
    console.error(err);
    ui.setOscState('error', 'audio: ' + err.message);
  }
}

const ui = new UI(BODIES, {
  onSelect: selectBody,
  onStartAudio: startAudio,
  onToggleAudio: () => {
    if (audio.running) {
      audio.stop();
      ui.setAudioRunning(false);
      oscBridge.sendAudioState(false);
    } else {
      startAudio();
    }
  },
  onTogglePause: () => { state.paused = !state.paused; ui.setPaused(state.paused); },
  onNow: () => { state.simDays = 0; state.epochJd = julianDate(Date.now()); },
  onSpeed: (d) => { state.daysPerSecond = d; },
  onTilt: (t) => { state.tiltGain = t; },
  onVolume: (v) => audio.setVolume(v),
  onDoppler: (on) => audio.setDoppler(on),
  onHeading: (mode) => { state.headingMode = mode; },
  onLabels: (on) => {
    state.showDecor = on;
    sky.setDecor(on);
  },
  onOscRate: (hz) => { state.oscRateHz = hz; },
  onWsUrl: connectOsc
});

oscBridge.addEventListener('state', (e) => ui.setOscState(e.detail.state, e.detail.error));

/**
 * Opens the OSC socket at a given URL. Used both at startup and whenever the URL box in
 * the OSC panel is applied, so the connection can be moved to a different bridge without
 * reloading the page.
 */
function connectOsc(url) {
  ui.setActiveWsUrl(url);
  if (!url) {
    oscBridge.disconnect();
    ui.setOscState('idle');
    return;
  }
  const problem = checkWsUrl(url);
  if (problem) {
    oscBridge.disconnect();
    ui.setOscState('error', problem);
    return;
  }
  oscBridge.connect(url);
}

/**
 * A URL entered in the page wins over the server's --ws-url, so a machine can be pointed
 * somewhere else without restarting anything. Clearing the box drops the override and
 * falls back to what the server suggests.
 */
async function initOsc() {
  let serverUrl = '';
  try {
    serverUrl = (await (await fetch('api/config')).json()).wsUrl || '';
  } catch (err) {
    // Not fatal: the page still runs, and a URL can be typed in by hand.
    ui.setOscState('error', 'cannot read /api/config: ' + err);
  }
  ui.setServerWsUrl(serverUrl);
  connectOsc(savedWsUrl() || serverUrl);
}

// ---------------------------------------------------------------- loop

const clock = new THREE.Clock();
let oscAccumulator = 0;
let uiAccumulator = 0;

function tick() {
  const dt = Math.min(clock.getDelta(), 0.1);
  if (!state.paused) state.simDays += dt * state.daysPerSecond;

  const jd = state.epochJd + state.simDays;
  const T = centuries(jd);

  sky.step(T, state.tiltGain, state.daysPerSecond);
  sky.refreshOrbitLines(T, state.tiltGain);
  updateListenerFrame();
  computeField(positions, velocities, listener, fwd, up, field);

  // Camera rides along with the selected body while leaving orbit and zoom to the user.
  controls.update();
  camOffset.copy(camera.position).sub(controls.target);
  const focus = positions[state.listener];
  if (transition < 1) {
    transition = Math.min(1, transition + dt / 1.4);
    const k = easeInOutCubic(transition);
    controls.target.lerpVectors(transStart, focus, k);
    camOffset.setLength(Math.max(THREE.MathUtils.lerp(transStartDist, transEndDist, k), 0.01));
  } else {
    controls.target.copy(focus);
  }
  camera.position.copy(controls.target).add(camOffset);

  // Beacons and labels sized for a ~900 px tall perspective viewport.
  sky.syncVisuals(camera.position, 0.030, 0.022);

  audio.update(positions, field, listener, fwd, up, phases);
  radar.draw(field, state.listener);
  updateHover();

  // The numeric readouts do not need 60 fps, and text writes force layout.
  uiAccumulator += dt;
  if (uiAccumulator >= 1 / 15) {
    uiAccumulator = 0;
    ui.update(field, jd, state.simDays);
    ui.setOscStats(oscBridge.sent);
  }

  if (state.oscRateHz > 0) {
    oscAccumulator += dt;
    if (oscAccumulator >= 1 / state.oscRateHz) {
      oscAccumulator = 0;
      oscBridge.sendFrame({
        positions, field, listener, fwd, up, phases,
        simDays: state.simDays, j2000Days: jd - J2000,
        daysPerSecond: state.daysPerSecond, paused: state.paused
      });
    }
  }

  renderer.render(scene, camera);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------------- start

sky.step(centuries(state.epochJd), state.tiltGain, state.daysPerSecond);
sky.refreshOrbitLines(centuries(state.epochJd), state.tiltGain);
controls.target.copy(positions[state.listener]);
camera.position.copy(controls.target).add(new THREE.Vector3(0, 0.55, 1).setLength(175));
ui.setSelected(state.listener);
ui.setPaused(false);
ui.setAudioRunning(false);
initOsc();
renderer.setAnimationLoop(tick);
