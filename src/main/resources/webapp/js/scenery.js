/**
 * The solar system as a three.js scene, plus the simulation that moves it.
 *
 * Shared by both front ends: the desktop view (main.js) and the CRAIVE Lab band
 * (craive.js). Everything about *what* the system looks like and where the bodies are
 * lives here; the two views differ only in how they photograph it and who is listening.
 */

import * as THREE from 'three';
import {
  BODIES, FASTEST_SPIN_DAYS, displayRadius, equatorialToScene, orbitPoints, scenePosition, spinAngle
} from './bodies.js';
import { aimYawOnly, angularSize } from './billboard.js';

const DEG = Math.PI / 180;
const ORBIT_SEGMENTS = 512;
/** Earth's axial tilt; the star field is equatorial, the planets sit on the ecliptic. */
const OBLIQUITY = 23.4393 * DEG;
/** Half-width of the finite difference used for orbital velocity, in days. */
const VELOCITY_H_DAYS = 0.5;
/** Rebuild orbit lines once the epoch has drifted this far, in Julian centuries. */
const LINE_REBUILD_T = 0.02;
/**
 * Turns per real second allowed to the fastest spinner, Jupiter. Real rates at the
 * default 8 d/s would turn Jupiter 19 times a second, which a 60 Hz frame can only alias,
 * so past this every body's spin slows by the same factor and the ratios stay true.
 */
const MAX_SPIN_HZ = 0.25;
const SPIN_AXIS = new THREE.Vector3(0, 1, 0);

const PLANET_MAPS = {
  Sun: 'textures/planets/sun.jpg',
  Mercury: 'textures/planets/mercury.jpg',
  Venus: 'textures/planets/venus.jpg',
  Earth: 'textures/planets/earth.jpg',
  Mars: 'textures/planets/mars.jpg',
  Jupiter: 'textures/planets/jupiter.jpg',
  Saturn: 'textures/planets/saturn.jpg',
  Uranus: 'textures/planets/uranus.jpg',
  Neptune: 'textures/planets/neptune.jpg'
};

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

/** Ring in XY with U along radius, so a 1D Saturn-ring strip maps to the Cassini division. */
function ringGeometry(inner, outer, segments) {
  const geo = new THREE.RingGeometry(inner, outer, segments, 1);
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  const span = outer - inner;
  for (let i = 0; i < pos.count; i++) {
    const r = Math.hypot(pos.getX(i), pos.getY(i));
    uv.setXY(i, (r - inner) / span, 0.5);
  }
  uv.needsUpdate = true;
  return geo;
}

/**
 * Turns a sphere's local +Y onto the body's north pole and its local +X onto the node
 * where the body's equator crosses Earth's, the origin the IAU measures W from. A
 * three.js sphere puts the map's prime meridian on +X, so a further turn of W about +Y
 * finishes the job.
 */
function poleQuaternion(body) {
  const [ra, dec] = body.spin.pole;
  const pole = equatorialToScene(ra, dec, new THREE.Vector3());
  const node = equatorialToScene(ra + 90, 0, new THREE.Vector3());
  const third = new THREE.Vector3().crossVectors(node, pole);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(node, pole, third));
}

function atmosphereMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(0.32, 0.52, 1.0) } },
    vertexShader: `
      varying vec3 vNormalW;
      varying vec3 vViewW;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vNormalW = normalize(mat3(modelMatrix) * normal);
        vViewW = cameraPosition - w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      varying vec3 vNormalW;
      varying vec3 vViewW;
      void main() {
        float fresnel = pow(1.0 - abs(dot(normalize(vNormalW), normalize(vViewW))), 2.8);
        gl_FragColor = vec4(uColor * fresnel, fresnel);
      }
    `,
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: true
  });
}

/**
 * RA/Dec → SphereGeometry vertex, matching NASA plate-carrée (RA=0 at texture
 * centre, RA increases left): phi = π − ra, theta = π/2 − dec.
 */
function setFromRaDec(out, ra, dec, radius) {
  const phi = Math.PI - ra;
  const theta = Math.PI / 2 - dec;
  const st = Math.sin(theta);
  out.set(-st * Math.cos(phi), Math.cos(theta), st * Math.sin(phi)).multiplyScalar(radius);
}

function catalogStars(stars, radius, pointSize) {
  const n = stars.length;
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  const c = new THREE.Color();
  const p = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const [ra, dec, mag, bv] = stars[i];
    setFromRaDec(p, ra, dec, radius);
    pos[i * 3] = p.x;
    pos[i * 3 + 1] = p.y;
    pos[i * 3 + 2] = p.z;
    const t = Math.max(-0.4, Math.min(2.0, bv));
    const vis = Math.min(1, Math.pow(10, -0.18 * (mag - 0.15)));
    c.setHSL(0.62 - Math.min(t + 0.4, 1.7) * 0.34, 0.18 + Math.abs(t - 0.3) * 0.28, 0.42 + 0.52 * vis);
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return new THREE.Points(geo, new THREE.PointsMaterial({
    size: pointSize, sizeAttenuation: false, vertexColors: true,
    transparent: true, opacity: 0.95, depthWrite: false
  }));
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
 * @param options.quality    'high' (default: JPL maps, 128-seg spheres, catalog sky)
 *        or 'cheap' (procedural stripes). 'band' is an alias for high, used by the CRAIVE view.
 * @param options.starSize   unattenuated gl_PointSize in framebuffer pixels. On the
 *        band those pixels are fattened 1.32×, so squares look round on the wall.
 * @param options.billboard  'sprite' (desktop, faces the camera) or 'cylindrical'
 *        (band: upright quads that yaw to face the ship, so slice seams agree).
 */
export class SolarSystemScene {
  constructor(options = {}) {
    this.scene = new THREE.Scene();
    this.quality = options.quality === 'cheap' ? 'cheap'
      : options.quality === 'band' ? 'band' : 'high';
    this.billboard = options.billboard === 'cylindrical' ? 'cylindrical' : 'sprite';
    const high = this.quality !== 'cheap';
    const sphereSegs = high ? 128 : 48;
    const sphereRings = high ? 96 : 32;
    const starRadius = options.starRadius ?? 2200;

    // Dim fill so the sun light models the globes.
    this.ambient = new THREE.AmbientLight(0x4a5f80, high ? 0.16 : 0.55);
    this.scene.add(this.ambient);
    // Colour is an sRGB hex; three.js ColorManagement linearises it. Intensity is linear.
    // decay 0 so Neptune at 78 units is still modelled, not black.
    this.sunLight = new THREE.PointLight(0xfff1d6, high ? 3.6 : 2.6, 0, 0);
    this.scene.add(this.sunLight);

    this._placeholderStars = starField(options.starCount ?? 4200, starRadius);
    this._placeholderStars.material.size = options.starSize ?? 1.6;
    this.scene.add(this._placeholderStars);
    this._catalogStars = null;
    this.milkyWay = null;
    this.atmosphere = null;
    this.skyRig = null;

    const glowMap = glowTexture();
    this.corona = null;
    this._markerGeo = new THREE.PlaneGeometry(1, 1);
    this._labelGeo = new THREE.PlaneGeometry(1, 1);
    this._labelGeo.translate(0, 0.5, 0); // bottom-centre, matching Sprite.center (0.5, 0)

    this.objects = BODIES.map((body, index) => {
      const isSun = index === 0;
      const radius = displayRadius(body);
      const style = '#' + body.color.toString(16).padStart(6, '0');

      const map = bodyTexture(body.color, isSun ? 3 : (body.radiusKm > 20000 ? 15 : 6));
      const material = isSun
        ? new THREE.MeshBasicMaterial({ map, color: 0xffffff })
        : new THREE.MeshStandardMaterial({ map, roughness: 0.88, metalness: 0.04 });
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, sphereSegs, sphereRings), material);
      mesh.userData.index = index;
      this.scene.add(mesh);

      let ring = null;
      if (body.ring) {
        ring = new THREE.Mesh(
          ringGeometry(radius * body.ring.inner, radius * body.ring.outer, high ? 192 : 96),
          new THREE.MeshBasicMaterial({
            color: body.ring.color, side: THREE.DoubleSide,
            transparent: true, opacity: 0.45, depthWrite: false
          })
        );
        ring.rotation.set(-Math.PI / 2, 0, 0); // the equator, which the mesh has tilted
        mesh.add(ring);
      }

      if (isSun) {
        this.corona = this._makeBillboard(glowMap, 0xffb347, {
          blending: THREE.AdditiveBlending, opacity: 0.85
        });
        this.corona.scale.setScalar(radius * 8);
        this.scene.add(this.corona);
      }

      // A constant-apparent-size beacon: keeps distant planets visible and easy to click.
      const marker = this._makeBillboard(glowMap, body.color, {
        blending: THREE.AdditiveBlending, opacity: 0.5
      });
      marker.userData.index = index;
      this.scene.add(marker);

      const label = labelTexture(body.name, style);
      const labelSprite = this._makeBillboard(label.texture, 0xffffff, {
        opacity: 0.85, geometry: this._labelGeo
      });
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

      if (high && body.name === 'Earth') {
        this.atmosphere = new THREE.Mesh(
          new THREE.SphereGeometry(radius * 1.045, sphereSegs, sphereRings),
          atmosphereMaterial()
        );
        mesh.add(this.atmosphere);
      }

      return {
        body, index, radius, mesh, marker, labelSprite, labelAspect: label.aspect, orbit, ring,
        tilt: poleQuaternion(body)
      };
    });

    this.pickables = this.objects.flatMap((o) => [o.mesh, o.marker]);

    this.positions = BODIES.map(() => new THREE.Vector3());
    this.velocities = BODIES.map(() => new THREE.Vector3());
    this.phases = new Float64Array(BODIES.length);
    /** Each body's prime meridian angle W, in radians. */
    this.spins = new Float64Array(BODIES.length);
    this._spinDays = 0;
    this._spinT = null;

    this._scratch = [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }];
    this._vec = new THREE.Vector3();
    this._lineEpoch = null;
    this._lineTilt = null;

    this.ready = high
      ? this._loadHighQualityAssets(starRadius, options.starSize ?? 1.6)
      : Promise.resolve();
  }

  _configureMap(tex) {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    return tex;
  }

  async _loadHighQualityAssets(starRadius, starSize) {
    const loader = new THREE.TextureLoader();
    const jobs = [];
    for (const o of this.objects) {
      const url = PLANET_MAPS[o.body.name];
      if (!url) continue;
      jobs.push(loader.loadAsync(url).then((tex) => {
        const prev = o.mesh.material.map;
        o.mesh.material.map = this._configureMap(tex);
        o.mesh.material.needsUpdate = true;
        if (prev && prev.isCanvasTexture) prev.dispose();
      }));
    }
    const saturn = this.objects.find((o) => o.body.ring);
    if (saturn?.ring) {
      jobs.push(loader.loadAsync('textures/planets/saturn-ring.png').then((tex) => {
        this._configureMap(tex);
        tex.wrapS = THREE.ClampToEdgeWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        saturn.ring.material.map = tex;
        saturn.ring.material.color.set(0xffffff);
        saturn.ring.material.opacity = 1;
        saturn.ring.material.transparent = true;
        saturn.ring.material.needsUpdate = true;
      }));
    }
    jobs.push(loader.loadAsync('textures/sky/milkyway.jpg').then((tex) => {
      this._configureMap(tex);
      tex.wrapS = THREE.RepeatWrapping;
      const sky = new THREE.Mesh(
        new THREE.SphereGeometry(starRadius * 0.96, 64, 32),
        new THREE.MeshBasicMaterial({
          map: tex, side: THREE.BackSide, depthWrite: false, fog: false, color: 0xffffff
        })
      );
      this._ensureSkyRig();
      this.milkyWay = sky;
      this.skyRig.add(sky);
    }));
    jobs.push(fetch('data/bsc.json').then((r) => r.json()).then((data) => {
      const pts = catalogStars(data.stars, starRadius, starSize);
      this._ensureSkyRig();
      this._catalogStars = pts;
      this.skyRig.add(pts);
      this._placeholderStars.visible = false;
    }));
    const results = await Promise.allSettled(jobs);
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length) console.warn('scene assets: ' + failed.length + ' failed to load', failed);
  }

  _ensureSkyRig() {
    if (this.skyRig) return;
    this.skyRig = new THREE.Group();
    // Equatorial sky (Y = celestial north) tilted onto the ecliptic (Y = orbit normal).
    // setFromRaDec and the sphere's UVs put RA 6h on +Z, a left-handed frame; heliocentric()
    // puts it on -Z. Mirroring Z first brings the two together, and makes the tilt that
    // carries the celestial pole toward ecliptic longitude 90° a negative one.
    this.skyRig.scale.z = -1;
    this.skyRig.rotation.x = -OBLIQUITY;
    this.scene.add(this.skyRig);
  }

  _makeBillboard(map, color, opts = {}) {
    if (this.billboard === 'cylindrical') {
      return new THREE.Mesh(
        opts.geometry ?? this._markerGeo,
        new THREE.MeshBasicMaterial({
          map, color, transparent: true, depthWrite: false,
          blending: opts.blending ?? THREE.NormalBlending,
          opacity: opts.opacity ?? 1,
          fog: false
        })
      );
    }
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map, color, transparent: true, depthWrite: false,
      blending: opts.blending ?? THREE.NormalBlending,
      opacity: opts.opacity ?? 1
    }));
    if (opts.geometry === this._labelGeo) sprite.center.set(0.5, 0);
    return sprite;
  }

  /**
   * Advances every body to epoch T.
   *
   * @param daysPerSecond simulation rate, so velocities come out in scene units per real
   *        second — which is what the Doppler shift and the OSC stream want.
   */
  step(T, tiltGain, daysPerSecond) {
    // Spin keeps its own clock. It starts on the real one, so the first frame shows each
    // body turned as it really is, and runs with it until Jupiter would pass MAX_SPIN_HZ.
    const slow = Math.min(1, MAX_SPIN_HZ * FASTEST_SPIN_DAYS / daysPerSecond);
    this._spinDays = this._spinT === null ? T * 36525 : this._spinDays + (T - this._spinT) * 36525 * slow;
    this._spinT = T;

    const hT = VELOCITY_H_DAYS / 36525;
    for (let n = 0; n < BODIES.length; n++) {
      const body = BODIES[n];
      const p = scenePosition(body, T, tiltGain, this._scratch[0]);
      this.positions[n].set(p.x, p.y, p.z);
      this.phases[n] = p.meanAnomaly;
      this.spins[n] = (spinAngle(body, this._spinDays) % 360) * DEG;

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
   * @param viewpoint where the scene is being watched from: the camera, or the ship.
   * @param opts.markerDeg  beacon width in degrees of azimuth (constant apparent size).
   * @param opts.labelDeg   label height in degrees of azimuth.
   */
  syncVisuals(viewpoint, { markerDeg = 1.7, labelDeg = 1.3 } = {}) {
    for (const o of this.objects) {
      const p = this.positions[o.index];
      o.mesh.position.copy(p);
      o.mesh.quaternion.setFromAxisAngle(SPIN_AXIS, this.spins[o.index]).premultiply(o.tilt);
      if (o.index === 0) this.sunLight.position.copy(p);
      o.marker.position.copy(p);
      const d = this._vec.copy(p).sub(viewpoint).length();
      const markerW = Math.max(angularSize(d, markerDeg), o.radius * 2.4);
      o.marker.scale.setScalar(markerW);
      const ls = Math.max(angularSize(d, labelDeg), 0.35);
      o.labelSprite.scale.set(ls * o.labelAspect, ls, 1);
      o.labelSprite.position.copy(p);
      o.labelSprite.position.y += o.radius + angularSize(d, labelDeg * 0.9);
      if (this.billboard === 'cylindrical') {
        aimYawOnly(o.marker, viewpoint);
        aimYawOnly(o.labelSprite, viewpoint);
      }
    }
    if (this.corona) {
      this.corona.position.copy(this.positions[0]);
      if (this.billboard === 'cylindrical') aimYawOnly(this.corona, viewpoint);
    }
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
