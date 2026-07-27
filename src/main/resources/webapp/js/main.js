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
import {
  BODIES, displayRadius, orbitPoints, scenePosition, julianDate, centuries, J2000
} from './bodies.js';
import { AudioEngine, computeField } from './audio.js';
import { OscBridge } from './oscbridge.js';
import { Radar } from './radar.js';
import { UI, speedFromSlider, savedWsUrl, checkWsUrl } from './ui.js';

const DEG = Math.PI / 180;
const ORBIT_SEGMENTS = 512;
/** Half-width of the finite difference used for orbital velocity, in days. */
const VELOCITY_H_DAYS = 0.5;
/** Rebuild orbit lines once the epoch has drifted this far, in Julian centuries. */
const LINE_REBUILD_T = 0.02;

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

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.05, 6000);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.enablePan = false;      // the target tracks the selected body
controls.minDistance = 1.0;
controls.maxDistance = 900;
controls.zoomSpeed = 0.8;

// Enough fill light that Neptune is not a silhouette; the point light does the modelling.
scene.add(new THREE.AmbientLight(0x4a5f80, 0.55));

// ---------------------------------------------------------------- textures

/** Soft radial falloff, used for the body markers and the Sun's corona. */
function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0.00, 'rgba(255,255,255,1)');
  grad.addColorStop(0.22, 'rgba(255,255,255,0.55)');
  grad.addColorStop(0.55, 'rgba(255,255,255,0.13)');
  grad.addColorStop(1.00, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Latitudinal banding so the spheres are not flat discs of colour. */
function bodyTexture(color, bands) {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 256;
  const g = c.getContext('2d');
  const base = new THREE.Color(color);
  const tint = new THREE.Color();
  for (let y = 0; y < 256; y++) {
    const lat = y / 255;
    const n = Math.sin(lat * Math.PI * bands) * 0.5
            + Math.sin(lat * Math.PI * bands * 2.7 + 1.3) * 0.25
            + (Math.random() - 0.5) * 0.12;
    tint.copy(base).multiplyScalar(1 + n * 0.17);
    g.fillStyle = tint.getStyle();
    g.fillRect(0, y, 4, 1);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Body name rendered to a sprite texture. Returns the aspect ratio for scaling. */
function labelTexture(text, style) {
  const font = '500 44px system-ui, -apple-system, "Segoe UI", sans-serif';
  const probe = document.createElement('canvas').getContext('2d');
  probe.font = font;
  const w = Math.ceil(probe.measureText(text).width) + 20;
  const h = 60;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  g.font = font;
  g.textBaseline = 'middle';
  g.shadowColor = 'rgba(0,0,0,0.95)';
  g.shadowBlur = 9;
  g.fillStyle = style;
  g.fillText(text, 10, h / 2);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.minFilter = THREE.LinearFilter;
  return { texture: t, aspect: w / h };
}

// ---------------------------------------------------------------- scene contents

function addStars(count = 4200, radius = 2200) {
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const u = Math.random() * 2 - 1;
    const th = Math.random() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    const r = radius * (0.85 + Math.random() * 0.15);
    pos[i * 3] = r * s * Math.cos(th);
    pos[i * 3 + 1] = r * u;
    pos[i * 3 + 2] = r * s * Math.sin(th);
    const bright = Math.pow(Math.random(), 2.2);
    c.setHSL(0.55 + (Math.random() - 0.5) * 0.16, 0.25 * Math.random(), 0.35 + 0.6 * bright);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  scene.add(new THREE.Points(geo, new THREE.PointsMaterial({
    size: 1.6, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0.9
  })));
}
addStars();

const glowMap = glowTexture();
let corona = null;

const objects = BODIES.map((body, index) => {
  const isSun = index === 0;
  const radius = displayRadius(body);
  const style = '#' + body.color.toString(16).padStart(6, '0');

  const map = bodyTexture(body.color, isSun ? 3 : (body.radiusKm > 20000 ? 15 : 6));
  const material = isSun
    ? new THREE.MeshBasicMaterial({ map })
    : new THREE.MeshStandardMaterial({ map, roughness: 0.88, metalness: 0.04 });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 32), material);
  mesh.userData.index = index;
  scene.add(mesh);

  if (body.ring) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(radius * body.ring.inner, radius * body.ring.outer, 96, 1),
      new THREE.MeshBasicMaterial({
        color: body.ring.color, side: THREE.DoubleSide,
        transparent: true, opacity: 0.45, depthWrite: false
      })
    );
    ring.rotation.set(-Math.PI / 2 + body.ring.tilt * DEG, 0, 0);
    mesh.add(ring);
  }

  if (isSun) {
    corona = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowMap, color: 0xffb347, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.85
    }));
    corona.scale.setScalar(radius * 8);
    scene.add(corona);
  }

  // A constant-screen-size beacon: keeps distant planets visible and easy to click.
  const marker = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowMap, color: body.color, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.5
  }));
  marker.userData.index = index;
  scene.add(marker);

  const label = labelTexture(body.name, style);
  const labelSprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: label.texture, transparent: true, depthWrite: false, opacity: 0.85
  }));
  labelSprite.center.set(0.5, 0);
  scene.add(labelSprite);

  let orbit = null;
  if (body.elements) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((ORBIT_SEGMENTS + 1) * 3), 3));
    orbit = new THREE.Line(geo, new THREE.LineBasicMaterial({
      color: body.color, transparent: true, opacity: 0.26
    }));
    scene.add(orbit);
  }

  return { body, index, radius, mesh, marker, labelSprite, labelAspect: label.aspect, orbit };
});

const sunLight = new THREE.PointLight(0xfff1d6, 2.6, 0, 0); // decay 0 keeps Neptune lit
scene.add(sunLight);

const pickables = objects.flatMap((o) => [o.mesh, o.marker]);

// ---------------------------------------------------------------- simulation state

const positions = BODIES.map(() => new THREE.Vector3());
const velocities = BODIES.map(() => new THREE.Vector3());
const phases = new Float64Array(BODIES.length);
const field = [];

const scratch = [
  { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }
];
const vecA = new THREE.Vector3();
const fwd = new THREE.Vector3(0, 0, -1);
const up = new THREE.Vector3(0, 1, 0);

function updateBodies(T) {
  const hT = VELOCITY_H_DAYS / 36525;
  for (let n = 0; n < BODIES.length; n++) {
    const body = BODIES[n];
    const p = scenePosition(body, T, state.tiltGain, scratch[0]);
    positions[n].set(p.x, p.y, p.z);
    phases[n] = p.meanAnomaly;

    // Central difference gives a velocity that already accounts for the radial warp.
    const ahead = scenePosition(body, T + hT, state.tiltGain, scratch[1]);
    const behind = scenePosition(body, T - hT, state.tiltGain, scratch[2]);
    velocities[n]
      .set(ahead.x - behind.x, ahead.y - behind.y, ahead.z - behind.z)
      .divideScalar(2 * VELOCITY_H_DAYS)   // scene units per day
      .multiplyScalar(state.daysPerSecond); // scene units per real second
  }
}

function updateListenerFrame() {
  const n = state.listener;
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

let lineEpoch = null;
let lineTilt = null;

function refreshOrbitLines(T) {
  if (lineEpoch !== null && lineTilt === state.tiltGain && Math.abs(T - lineEpoch) < LINE_REBUILD_T) return;
  lineEpoch = T;
  lineTilt = state.tiltGain;
  for (const o of objects) {
    if (!o.orbit) continue;
    const attr = o.orbit.geometry.attributes.position;
    attr.array.set(orbitPoints(o.body, T, state.tiltGain, ORBIT_SEGMENTS));
    attr.needsUpdate = true;
    o.orbit.geometry.computeBoundingSphere();
  }
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
  for (const o of objects) {
    o.marker.material.opacity = o.index === index ? 0.95 : 0.5;
    if (o.orbit) o.orbit.material.opacity = o.index === index ? 0.7 : 0.26;
  }
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
    for (const o of objects) {
      o.labelSprite.visible = on;
      if (o.orbit) o.orbit.visible = on;
    }
  },
  onOscRate: (hz) => { state.oscRateHz = hz; },
  onOscTarget: retargetOsc,
  onWsUrl: connectOsc
});

oscBridge.addEventListener('state', (e) => ui.setOscState(e.detail.state, e.detail.error));

async function retargetOsc(host, port) {
  if (!host || !Number.isFinite(port)) return;
  try {
    const res = await fetch('api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oscHost: host, oscPort: port })
    });
    const json = await res.json();
    if (json.error) { ui.setOscState('error', json.error); return; }
    ui.setOscConfig(json);
    ui.setOscState(oscBridge.state);
  } catch (err) {
    ui.setOscState('error', String(err));
  }
}

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
 * A URL saved in the page wins over whatever the server advertises, which is what makes
 * --no-websocket usable: the server offers nothing, so the page's own setting is the only
 * source. It is also how you point at an external bridge on a server that does run one.
 */
function resolveWsUrl(config) {
  return savedWsUrl() || config.wsUrl || '';
}

async function initOsc() {
  try {
    const config = await (await fetch('api/config')).json();
    const url = resolveWsUrl(config);
    ui.setOscConfig(config, url);
    if (!url) {
      // The idle text already explains what to do when there is no relay; adding a
      // detail here would just say it twice.
      ui.setOscState('idle');
      return;
    }
    connectOsc(url);
  } catch (err) {
    ui.setOscState('error', 'cannot read /api/config: ' + err);
  }
}

setInterval(async () => {
  try {
    const config = await (await fetch('api/config')).json();
    ui.setOscConfig(config);
    ui.setOscStats(oscBridge.sent, config.stats);
  } catch { /* server restarting, the next tick will pick it up */ }
}, 2000);

// ---------------------------------------------------------------- loop

const clock = new THREE.Clock();
let oscAccumulator = 0;
let uiAccumulator = 0;

function tick() {
  const dt = Math.min(clock.getDelta(), 0.1);
  if (!state.paused) state.simDays += dt * state.daysPerSecond;

  const jd = state.epochJd + state.simDays;
  const T = centuries(jd);

  updateBodies(T);
  refreshOrbitLines(T);
  updateListenerFrame();
  computeField(positions, velocities, state.listener, fwd, up, field);

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

  for (const o of objects) {
    const p = positions[o.index];
    o.mesh.position.copy(p);
    o.marker.position.copy(p);
    // Constant apparent size, roughly 30 px tall at a 900 px viewport.
    const d = vecA.copy(p).sub(camera.position).length();
    o.marker.scale.setScalar(Math.max(d * 0.030, o.radius * 2.4));
    const ls = Math.max(d * 0.022, 0.35);
    o.labelSprite.scale.set(ls * o.labelAspect, ls, 1);
    o.labelSprite.position.copy(p);
    o.labelSprite.position.y += o.radius + d * 0.020;
  }
  if (corona) corona.position.copy(positions[0]);

  audio.update(positions, field, state.listener, fwd, up, phases);
  radar.draw(field, state.listener);
  updateHover();

  // The numeric readouts do not need 60 fps, and text writes force layout.
  uiAccumulator += dt;
  if (uiAccumulator >= 1 / 15) {
    uiAccumulator = 0;
    ui.update(field, jd, state.simDays);
  }

  if (state.oscRateHz > 0) {
    oscAccumulator += dt;
    if (oscAccumulator >= 1 / state.oscRateHz) {
      oscAccumulator = 0;
      oscBridge.sendFrame({
        positions, field, listenerIndex: state.listener, fwd, up, phases,
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

updateBodies(centuries(state.epochJd));
refreshOrbitLines(centuries(state.epochJd));
controls.target.copy(positions[state.listener]);
camera.position.copy(controls.target).add(new THREE.Vector3(0, 0.55, 1).setLength(175));
ui.setSelected(state.listener);
ui.setPaused(false);
ui.setAudioRunning(false);
initOsc();
renderer.setAnimationLoop(tick);
