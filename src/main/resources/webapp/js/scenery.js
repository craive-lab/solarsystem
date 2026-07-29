/**
 * The solar system as a three.js scene, plus the simulation that moves it.
 *
 * Shared by both front ends: the desktop view (main.js) and the CRAIVE Lab band
 * (craive.js). Everything about *what* the system looks like and where the bodies are
 * lives here; the two views differ only in how they photograph it and who is listening.
 */

import * as THREE from 'three';
import { BODIES, displayRadius, orbitPoints, scenePosition } from './bodies.js';

const DEG = Math.PI / 180;
const ORBIT_SEGMENTS = 512;
/** Half-width of the finite difference used for orbital velocity, in days. */
const VELOCITY_H_DAYS = 0.5;
/** Rebuild orbit lines once the epoch has drifted this far, in Julian centuries. */
const LINE_REBUILD_T = 0.02;

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

function starField(count, radius) {
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
  return new THREE.Points(geo, new THREE.PointsMaterial({
    size: 1.6, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0.9
  }));
}

/**
 * @param options.starSize point size for the star field. The band renders through a cube
 *        capture whose faces are far smaller than a desktop canvas, so unattenuated points
 *        come out proportionally larger there and want a smaller value.
 */
export class SolarSystemScene {
  constructor(options = {}) {
    this.scene = new THREE.Scene();
    // Enough fill light that Neptune is not a silhouette; the point light does the modelling.
    this.scene.add(new THREE.AmbientLight(0x4a5f80, 0.55));
    this.scene.add(new THREE.PointLight(0xfff1d6, 2.6, 0, 0)); // decay 0 keeps Neptune lit

    const stars = starField(options.starCount ?? 4200, options.starRadius ?? 2200);
    stars.material.size = options.starSize ?? 1.6;
    this.scene.add(stars);

    const glowMap = glowTexture();
    this.corona = null;

    this.objects = BODIES.map((body, index) => {
      const isSun = index === 0;
      const radius = displayRadius(body);
      const style = '#' + body.color.toString(16).padStart(6, '0');

      const map = bodyTexture(body.color, isSun ? 3 : (body.radiusKm > 20000 ? 15 : 6));
      const material = isSun
        ? new THREE.MeshBasicMaterial({ map })
        : new THREE.MeshStandardMaterial({ map, roughness: 0.88, metalness: 0.04 });
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 32), material);
      mesh.userData.index = index;
      this.scene.add(mesh);

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
        this.corona = new THREE.Sprite(new THREE.SpriteMaterial({
          map: glowMap, color: 0xffb347, transparent: true,
          blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.85
        }));
        this.corona.scale.setScalar(radius * 8);
        this.scene.add(this.corona);
      }

      // A constant-apparent-size beacon: keeps distant planets visible and easy to click.
      const marker = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowMap, color: body.color, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.5
      }));
      marker.userData.index = index;
      this.scene.add(marker);

      const label = labelTexture(body.name, style);
      const labelSprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: label.texture, transparent: true, depthWrite: false, opacity: 0.85
      }));
      labelSprite.center.set(0.5, 0);
      this.scene.add(labelSprite);

      let orbit = null;
      if (body.elements) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position',
          new THREE.BufferAttribute(new Float32Array((ORBIT_SEGMENTS + 1) * 3), 3));
        orbit = new THREE.Line(geo, new THREE.LineBasicMaterial({
          color: body.color, transparent: true, opacity: 0.26
        }));
        this.scene.add(orbit);
      }

      return { body, index, radius, mesh, marker, labelSprite, labelAspect: label.aspect, orbit };
    });

    this.pickables = this.objects.flatMap((o) => [o.mesh, o.marker]);

    this.positions = BODIES.map(() => new THREE.Vector3());
    this.velocities = BODIES.map(() => new THREE.Vector3());
    this.phases = new Float64Array(BODIES.length);

    this._scratch = [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }];
    this._vec = new THREE.Vector3();
    this._lineEpoch = null;
    this._lineTilt = null;
  }

  /**
   * Advances every body to epoch T.
   *
   * @param daysPerSecond simulation rate, so velocities come out in scene units per real
   *        second — which is what the Doppler shift and the OSC stream want.
   */
  step(T, tiltGain, daysPerSecond) {
    const hT = VELOCITY_H_DAYS / 36525;
    for (let n = 0; n < BODIES.length; n++) {
      const body = BODIES[n];
      const p = scenePosition(body, T, tiltGain, this._scratch[0]);
      this.positions[n].set(p.x, p.y, p.z);
      this.phases[n] = p.meanAnomaly;

      // Central difference gives a velocity that already accounts for the radial warp.
      const ahead = scenePosition(body, T + hT, tiltGain, this._scratch[1]);
      const behind = scenePosition(body, T - hT, tiltGain, this._scratch[2]);
      this.velocities[n]
        .set(ahead.x - behind.x, ahead.y - behind.y, ahead.z - behind.z)
        .divideScalar(2 * VELOCITY_H_DAYS)
        .multiplyScalar(daysPerSecond);
    }
  }

  /** Redraws the orbit lines, but only when the epoch or the tilt has moved enough to matter. */
  refreshOrbitLines(T, tiltGain) {
    if (this._lineEpoch !== null && this._lineTilt === tiltGain
        && Math.abs(T - this._lineEpoch) < LINE_REBUILD_T) return;
    this._lineEpoch = T;
    this._lineTilt = tiltGain;
    for (const o of this.objects) {
      if (!o.orbit) continue;
      const attr = o.orbit.geometry.attributes.position;
      attr.array.set(orbitPoints(o.body, T, tiltGain, ORBIT_SEGMENTS));
      attr.needsUpdate = true;
      o.orbit.geometry.computeBoundingSphere();
    }
  }

  /**
   * Moves the meshes, beacons and labels onto this frame's positions.
   *
   * @param viewpoint where the scene is being watched from: the camera in the desktop
   *        view, the cube capture point on the band.
   * @param markerK  world size per unit of distance, chosen so a beacon holds a constant
   *        apparent size. It differs between the views because their angular resolutions do.
   */
  syncVisuals(viewpoint, markerK = 0.030, labelK = 0.022) {
    for (const o of this.objects) {
      const p = this.positions[o.index];
      o.mesh.position.copy(p);
      o.marker.position.copy(p);
      const d = this._vec.copy(p).sub(viewpoint).length();
      o.marker.scale.setScalar(Math.max(d * markerK, o.radius * 2.4));
      const ls = Math.max(d * labelK, 0.35);
      o.labelSprite.scale.set(ls * o.labelAspect, ls, 1);
      o.labelSprite.position.copy(p);
      o.labelSprite.position.y += o.radius + d * (labelK * 0.9);
    }
    if (this.corona) this.corona.position.copy(this.positions[0]);
  }

  /** Labels and orbit lines together, since they are the same kind of annotation. */
  setDecor(on) {
    for (const o of this.objects) {
      o.labelSprite.visible = on;
      if (o.orbit) o.orbit.visible = on;
    }
  }

  /** Highlights one body's beacon and orbit; pass -1 for none. */
  setHighlight(index) {
    for (const o of this.objects) {
      o.marker.material.opacity = o.index === index ? 0.95 : 0.5;
      if (o.orbit) o.orbit.material.opacity = o.index === index ? 0.7 : 0.26;
    }
  }
}
