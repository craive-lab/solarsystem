/**
 * The RPI CRAIVE Lab front end: the solar system seen from inside a spaceship whose
 * walls are windows.
 *
 * The lab is a walk-in panoramic room — a continuous projection band around four walls,
 * eight WUXGA projectors warped and edge-blended by Pixelwarp. This page renders that
 * band live: eight perspective cameras photograph the 37-degree elevation strip from the
 * ship, and a fragment shader remaps those rectilinear slices onto the cylindrical band.
 * A 2048 cubemap (side faces only) is the fallback if the GPU cannot hold the slice atlas.
 * So there is no "screen" the audience looks at — the system is simply around them.
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
import { BodyList, Controls, savedWsUrl, checkWsUrl, speedFromSlider, typingIn, takeHandoff } from './ui.js';
import { bandDirection } from './bandMath.js';
import { BandCapture } from './bandCapture.js';
import { OperatorHud } from './operatorHud.js';
import { Ship } from './flight.js';

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
  slices: 8,           // Pixelwarp strips; capture starts at 12 and may drop toward this
  overlapPx: 8,        // half-width of the cylindrical crossfade at each seam
  cubeSize: 2048       // fallback cubemap, side faces only
};

/** Where the ship starts. The flight model itself is in flight.js, shared with the desktop. */
const START = {
  radius: 30,
  // Start below the ecliptic, so the system reads as a disc rather than the edge-on line
  // it becomes from within the plane — and specifically below rather than above, because
  // the band is not symmetric: it reaches 23.6 degrees above the horizon but only 13.6
  // below. Looking up at the disc therefore has most of the room's pixels to spread into.
  // At this height the Sun sits about 11 degrees up, just above the band's midline.
  height: -6
};

// Defaults match the control panel's initial slider positions.
const state = {
  epochJd: julianDate(Date.now()),
  simDays: 0,
  daysPerSecond: speedFromSlider(583),
  paused: false,
  tiltGain: 1,
  oscRateHz: 30,
  labels: true,
  operatorHud: true
};

document.body.classList.add('bare');

// ---------------------------------------------------------------- renderer

const canvas = document.getElementById('band');
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: false,
  powerPreference: 'high-performance',
  logarithmicDepthBuffer: true
});
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setPixelRatio(1);

// Always the Pixelwarp canvas. If the GPU cannot hold 60 fps we drop capture quality,
// never the buffer size (no CSS-upscaled smaller render).
const outW = BAND.outputWidth;
const outH = BAND.height;
renderer.setSize(outW, outH, false);
if (canvas.width !== outW || canvas.height !== outH) {
  console.warn(`band canvas is ${canvas.width}×${canvas.height}, expected ${outW}×${outH}`);
}

// Slice cameras render at ~1200 px tall, so unattenuated points stay small on the wall.
const sky = new SolarSystemScene({ quality: 'band', starSize: 1.2, billboard: 'cylindrical' });
const { positions, velocities, phases } = sky;
const field = [];

const capture = new BandCapture({ renderer, scene: sky.scene, band: BAND, outW, outH });
const operatorHud = new OperatorHud({
  bandScene: capture.bandScene,
  frontFrac: BAND.frontCenter / BAND.width,
  bandHeight: outH,
  outputWidth: outW
});

// ---------------------------------------------------------------- the ship

// The listener is not a body, it is the room. Heading 0 points along -Z, which from the
// starting position on +Z is straight at the Sun: the system is dead ahead on the front
// wall when the doors open.
const ship = new Ship('CRAIVE');
ship.position.set(0, START.height, START.radius);

window.addEventListener('keydown', (e) => {
  if (typingIn(e.target)) return; // the panels carry text boxes now
  const k = e.key.toLowerCase();
  if (k === ' ') { e.preventDefault(); togglePause(); return; }
  if (k >= '1' && k <= '9' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    flyTo(Number(k) - 1);
    return;
  }
  if (k === 'h' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    state.operatorHud = !state.operatorHud;
    operatorHud.setVisible(state.operatorHud);
    return;
  }
  if (k === 'l' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    state.labels = !state.labels;
    sky.setDecor(state.labels);
    controls.setLabels(state.labels);
    return;
  }
  if (k === 'p' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    // DOM panels land on the walls with the band; default is bare for a show.
    document.body.classList.toggle('bare');
    return;
  }
  // Taking the controls cancels an approach.
  if (ship.press(e) && k !== 'shift') travel.index = -1;
});
window.addEventListener('keyup', (e) => ship.release(e));
window.addEventListener('blur', () => ship.releaseAll());

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
 * partly because it has to be: a panorama assembled from several slice cameras has no
 * single camera to offer a raycaster. Testing bearings instead also gives every body
 * the same generous target, which matters when someone is pointing at a wall several
 * metres away.
 */
function pickAt(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const u = (clientX - rect.left) / rect.width;
  const v = 1 - (clientY - rect.top) / rect.height; // texture v runs bottom-up
  if (u < 0 || u > 1 || v < 0 || v > 1) return -1;
  if (u >= BAND.entranceStart / BAND.width && u <= BAND.entranceEnd / BAND.width) return -1;
  if (operatorHud.containsUv(u, v)) return -1;

  bandDirection(
    u, v, ship.yaw,
    BAND.frontCenter / BAND.width,
    THREE.MathUtils.degToRad(BAND.elevationCenter),
    THREE.MathUtils.degToRad(BAND.verticalFov),
    pickDir
  );

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

// The same View, Time, Audio and OSC panels as the desktop view, built by the shared
// Controls. No "face direction of travel" switch: on the band the listener is the ship,
// and it always faces where the ship is pointing.
const controls = new Controls(document.getElementById('right-panel'), {
  onTogglePause: togglePause,
  onHandoff: () => ({
    epochJd: state.epochJd, simDays: state.simDays, paused: state.paused, audio: audio.running
  }),
  onNow: () => { state.simDays = 0; state.epochJd = julianDate(Date.now()); },
  onSpeed: (d) => { state.daysPerSecond = d; },
  onTilt: (t) => { state.tiltGain = t; },
  onVolume: (v) => audio.setVolume(v),
  onDoppler: (on) => audio.setDoppler(on),
  onLabels: (on) => {
    state.labels = on;
    sky.setDecor(on);
  },
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

async function startAudio(withoutGesture = false) {
  try {
    await (withoutGesture ? audio.startWithoutGesture() : audio.start());
    controls.setAudioRunning(true);
    oscBridge.sendAudioState(true);
  } catch (err) {
    console.error(err);
    controls.setOscState('error', 'audio unavailable: ' + err.message);
  }
}

function launch() {
  const gate = document.getElementById('gate');
  if (gate) {
    gate.classList.add('hiding');
    setTimeout(() => gate.remove(), 600);
  }
  startAudio();
}

document.getElementById('gate-start').addEventListener('click', launch);

// Arrived by the view switch: carry on where the other view left off, past the launch
// card, and with the panels up, since that is where the switch was just used.
const handoff = takeHandoff();
if (handoff) {
  state.epochJd = handoff.epochJd;
  state.simDays = handoff.simDays;
  state.paused = handoff.paused;
  controls.setPaused(state.paused);
  controls.restore(handoff.inputs);
  document.getElementById('gate').remove();
  document.body.classList.remove('bare');
  if (handoff.audio) startAudio(true);
}

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

let oscAccumulator = 0;
let hudAccumulator = 0;
let lastFrameAt = performance.now();

function tick() {
  const now = performance.now();
  const frameMs = now - lastFrameAt;
  lastFrameAt = now;
  const dt = Math.min(frameMs / 1000, 0.1);
  if (!state.paused) state.simDays += dt * state.daysPerSecond;

  const jd = state.epochJd + state.simDays;
  const T = centuries(jd);

  sky.step(T, state.tiltGain, state.daysPerSecond);
  sky.refreshOrbitLines(T, state.tiltGain);

  ship.beginFrame();
  ship.fly(dt);
  updateApproach(dt);
  ship.endFrame(dt);

  computeField(positions, velocities, ship, ship.forward, ship.up, field);

  // ~0.9° beacons / 0.7° labels: constant on the wall, independent of cube-face pixels.
  sky.syncVisuals(ship.position, { markerDeg: 0.9, labelDeg: 0.7 });

  audio.update(positions, field, ship, ship.forward, ship.up, phases);

  if (state.oscRateHz > 0) {
    oscAccumulator += dt;
    if (oscAccumulator >= 1 / state.oscRateHz) {
      oscAccumulator = 0;
      oscBridge.sendFrame({
        positions, field, listener: ship, fwd: ship.forward, up: ship.up, phases,
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

  capture.render(ship.position, ship.yaw);
  capture.observe(frameMs);
}

function writeCaptureProbe() {
  const gl = renderer.getContext();
  const pix = new Uint8Array(4);
  const at = (x, y) => {
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pix);
    return [pix[0], pix[1], pix[2], pix[3]];
  };
  const frontX = Math.round((BAND.frontCenter / BAND.width) * outW);
  const entranceX = Math.min(outW - 1, Math.round((BAND.entranceStart / BAND.width) * outW) + 8);
  const midY = Math.round(outH / 2);
  const zAxis = new THREE.Vector3();
  const toShip = new THREE.Vector3();
  sky.objects[0].marker.getWorldDirection(zAxis);
  toShip.copy(ship.position).sub(sky.objects[0].marker.position);
  toShip.y = 0;
  toShip.normalize();
  const result = {
    width: canvas.width,
    height: canvas.height,
    mode: capture.mode,
    label: capture.label,
    front: at(frontX, midY),
    entrance: at(entranceX, midY),
    glError: gl.getError(),
    billboard: sky.billboard,
    billboardDot: Number(zAxis.dot(toShip).toFixed(4)),
    quality: sky.quality,
    earthMapped: !!(sky.objects[3].mesh.material.map && !sky.objects[3].mesh.material.map.isCanvasTexture),
    atmosphere: !!sky.atmosphere,
    milkyWay: !!sky.milkyWay,
    catalogStars: sky._catalogStars ? sky._catalogStars.geometry.attributes.position.count : 0,
    sphereSegs: sky.objects[0].mesh.geometry.parameters?.widthSegments ?? 0,
    sunLightOnSun: sky.sunLight.position.distanceTo(sky.objects[0].mesh.position) < 1e-4,
    starPointsUnattenuated: (sky._catalogStars || sky._placeholderStars)?.material.sizeAttenuation === false,
    pixelRatio: renderer.getPixelRatio(),
    rung: capture.rung,
    slices: capture.N,
    samples: capture.samples,
    bare: document.body.classList.contains('bare'),
    operatorHud: operatorHud.mesh.visible,
    labels: state.labels,
    hudNdcX: Number(operatorHud.mesh.position.x.toFixed(3))
  };
  window.__craiveProbe = result;
  document.documentElement.dataset.probe = JSON.stringify(result);
  console.info('craive capture probe', result);
}

function updateHud() {
  const p = ship.position;
  const heading = ((THREE.MathUtils.radToDeg(ship.yaw) % 360 + 360) % 360).toFixed(0);
  const auFromSun = Math.pow(p.length() / 12, 1 / 0.55); // inverse of the display warp
  const position =
    `${p.x.toFixed(0)}, ${p.y.toFixed(0)}, ${p.z.toFixed(0)}  ·  ${auFromSun.toFixed(2)} AU from the Sun`
    + `  ·  heading ${heading}°`;

  let nearest = 0;
  for (let n = 1; n < field.length; n++) {
    if (field[n].distance < field[nearest].distance) nearest = n;
  }
  const g = field[nearest];
  const nearestText = g
    ? `nearest: ${BODIES[nearest].name} (${BODIES[nearest].sound.note}) · ${g.distance.toFixed(1)} units · az ${g.azimuth.toFixed(0)}°`
    : '';

  hud.position.textContent = position + `  ·  ${capture.label}`;
  hud.nearest.textContent = nearestText;
  operatorHud.draw({
    heading,
    position,
    nearest: nearestText,
    captureLabel: capture.label,
    labelsOn: state.labels
  });
}

try {
  if (new URLSearchParams(location.search).get('test') === 'capture') {
    const run = () => {
      const T = centuries(state.epochJd);
      sky.step(T, state.tiltGain, state.daysPerSecond);
      sky.syncVisuals(ship.position, { markerDeg: 0.9, labelDeg: 0.7 });
      updateHud();
      capture.render(ship.position, ship.yaw);
      writeCaptureProbe();
    };
    sky.ready.then(run).catch(run);
  }
} catch (err) {
  document.documentElement.dataset.probe = JSON.stringify({ error: String(err) });
}

renderer.setAnimationLoop(tick);
