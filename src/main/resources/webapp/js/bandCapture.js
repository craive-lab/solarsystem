/**
 * Fills the Pixelwarp canvas: eight band-aligned perspective cameras remapped
 * to the cylindrical strip, or a 2048 side-faces cubemap if the GPU cannot
 * hold the slice atlas.
 *
 * Tiles render in linear HDR (half-float, no tone map) with 4× MSAA on the
 * 1920×1200 slice, then one composite applies ACES and sRGB to the canvas.
 */

import * as THREE from 'three';
import { bandDirection, BAND_DIR_GLSL, sliceWeightGLSL, selfTestBandMath } from './bandMath.js';

const NEAR = 0.05;
const FAR = 9000;
const FOV_PAD = 1.04;
const GRID = 8;
// CubeCamera children: +X, -X, +Y, -Y, +Z, -Z. The band sits within ±45° of
// the horizon, so the ±Y faces never contribute.
const SIDE_FACES = [0, 1, 4, 5];

/** Highest quality first. Drop MSAA, then slice count, then the cubemap. Canvas stays 15360×1200. */
export const LADDER = [
  { slices: 12, samples: 4, mode: 'slices' },
  { slices: 12, samples: 2, mode: 'slices' },
  { slices: 12, samples: 0, mode: 'slices' },
  { slices: 8, samples: 0, mode: 'slices' },
  { slices: 6, samples: 0, mode: 'slices' },
  { slices: 0, samples: 0, mode: 'cube' }
];

const WARMUP_FRAMES = 90;
const SAMPLE_FRAMES = 48;
const DROP_MS = 18.5; // ~54 fps; 60 Hz vsync with noise stays above this

const _dir = { x: 0, y: 0, z: 0 };
const _view = new THREE.Vector3();
const _look = new THREE.Vector3();

function captureQuery() {
  try {
    return new URLSearchParams(window.location.search).get('capture');
  } catch {
    return null;
  }
}

function commonUniforms(band) {
  return {
    uYaw: { value: 0 },
    uFrontFrac: { value: band.frontCenter / band.width },
    uEntrance: {
      value: new THREE.Vector2(band.entranceStart / band.width, band.entranceEnd / band.width)
    },
    uElevCenter: { value: THREE.MathUtils.degToRad(band.elevationCenter) },
    uVFov: { value: THREE.MathUtils.degToRad(band.verticalFov) }
  };
}

const VERTEX = `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
  `;

/** ACES + sRGB run here, on the canvas, so HDR tiles are not compressed twice. */
const TONEMAP_GLSL = `
      gl_FragColor = vec4(acc, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>`;

function cubeFragment() {
  return `
    uniform samplerCube uCube;
    uniform float uYaw;
    uniform float uFrontFrac;
    uniform float uElevCenter;
    uniform float uVFov;
    uniform vec2 uEntrance;
    varying vec2 vUv;
    void main() {
      if (vUv.x >= uEntrance.x && vUv.x <= uEntrance.y) {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
      }
      ${BAND_DIR_GLSL}
      vec3 acc = textureCube(uCube, dir).rgb;
      ${TONEMAP_GLSL}
    }
  `;
}

function sliceFragment(N) {
  let contrib = '';
  for (let i = 0; i < N; i++) {
    contrib += `
      w = sliceWeight(${i}, vUv.x);
      if (w > 1e-5) {
        viewDir = mat3(uView[${i}]) * dir;
        if (viewDir.z < -1e-4) {
          clip = uProj[${i}] * vec4(viewDir, 1.0);
          uv = clip.xy / max(clip.w, 1e-6) * 0.5 + 0.5;
          if (uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0) {
            acc += texture2D(uAtlas, vec2((${i}.0 + uv.x) / ${N}.0, uv.y)).rgb * w;
          }
        }
      }
    `;
  }
  return `
    uniform sampler2D uAtlas;
    uniform mat4 uView[${N}];
    uniform mat4 uProj[${N}];
    uniform float uYaw;
    uniform float uFrontFrac;
    uniform float uElevCenter;
    uniform float uVFov;
    uniform vec2 uEntrance;
    uniform float uOverlap;
    varying vec2 vUv;
    ${sliceWeightGLSL(N)}
    void main() {
      if (vUv.x >= uEntrance.x && vUv.x <= uEntrance.y) {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
      }
      ${BAND_DIR_GLSL}
      vec3 acc = vec3(0.0);
      vec3 viewDir;
      vec4 clip;
      vec2 uv;
      float w;
      ${contrib}
      ${TONEMAP_GLSL}
    }
  `;
}

function hdrOptions(samples, depthBuffer) {
  return {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    colorSpace: THREE.LinearSRGBColorSpace,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: false,
    depthBuffer,
    stencilBuffer: false,
    samples
  };
}

function tryCreateRT(renderer, width, height, options) {
  if (width > renderer.capabilities.maxTextureSize ||
      height > renderer.capabilities.maxTextureSize) {
    return null;
  }
  const rt = new THREE.WebGLRenderTarget(width, height, options);
  renderer.setRenderTarget(rt);
  const gl = renderer.getContext();
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  renderer.setRenderTarget(null);
  if (!ok) {
    rt.dispose();
    return null;
  }
  return rt;
}

export class BandCapture {
  /**
   * @param {object} opts
   * @param {THREE.WebGLRenderer} opts.renderer
   * @param {THREE.Scene} opts.scene
   * @param {object} opts.band  the BAND constant from craive.js
   * @param {number} opts.outW
   * @param {number} opts.outH
   */
  constructor({ renderer, scene, band, outW, outH }) {
    this.renderer = renderer;
    this.scene = scene;
    this.band = band;
    this.outW = outW;
    this.outH = outH;
    this.N = band.slices;
    this.frontFrac = band.frontCenter / band.width;
    this.elevCenter = THREE.MathUtils.degToRad(band.elevationCenter);
    this.vFov = THREE.MathUtils.degToRad(band.verticalFov);
    this.entranceU = band.entranceStart / band.width;
    this.overlap = band.overlapPx / outW;
    this.entrancePx = Math.max(1, Math.floor(this.entranceU * outW));
    this.sliceW = outW;
    this.atlasW = outW;

    this.bandCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.bandScene = new THREE.Scene();
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.bandScene.add(this.quad);

    const mathFails = selfTestBandMath(band);
    if (mathFails.length) {
      console.error('band capture: mapping self-test failed', mathFails);
    }

    this.samples = 0;
    this.tile = null;
    this.atlas = null;
    this.mode = 'slices';
    this.rung = 0;
    this.rungLocked = false;
    this._copyPos = new THREE.Vector2();
    this._frameTimes = [];
    this._warmup = WARMUP_FRAMES;
    this._fps = 0;

    let start = 0;
    const force = captureQuery();
    if (force === 'cube') {
      start = LADDER.length - 1;
      this.rungLocked = true;
    } else {
      try {
        const q = new URLSearchParams(window.location.search).get('rung');
        if (q !== null && q !== '') {
          start = THREE.MathUtils.clamp(Number(q), 0, LADDER.length - 1);
          this.rungLocked = true;
        }
      } catch { /* no search params */ }
    }
    this._applyRung(start);
  }

  get label() {
    const fps = this._fps > 0 ? ` · ${Math.round(this._fps)} fps` : '';
    const dropped = this.rung > 0 ? ' · dropped' : '';
    if (this.mode === 'slices') {
      const aa = this.samples > 0 ? ` msaa${this.samples}` : '';
      return `${this.N} slices ${this.sliceW}×${this.outH}${aa} hdr${fps}${dropped}`;
    }
    return `cube ${this.band.cubeSize} hdr${fps}${dropped}`;
  }

  render(position, yaw) {
    const renderer = this.renderer;
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const prevXr = renderer.xr.enabled;
    const prevClear = new THREE.Color();
    renderer.getClearColor(prevClear);
    const prevAlpha = renderer.getClearAlpha();
    renderer.xr.enabled = false;
    try {
      if (this.mode === 'slices') this._renderSlices(position, yaw);
      else this._renderCube(position, yaw);
    } finally {
      renderer.autoClear = prevAutoClear;
      renderer.xr.enabled = prevXr;
      renderer.setClearColor(prevClear, prevAlpha);
      renderer.setScissorTest(false);
      renderer.setRenderTarget(prevTarget);
      renderer.setViewport(0, 0, this.outW, this.outH);
    }
  }

  /**
   * Frame interval in milliseconds (unclamped). Drops a ladder rung when the
   * rolling mean stays below 60 fps. Canvas size never changes.
   */
  observe(frameMs) {
    if (frameMs > 0 && frameMs < 1000) {
      this._fps = this._fps === 0 ? 1000 / frameMs : this._fps * 0.9 + (1000 / frameMs) * 0.1;
    }
    if (this.rungLocked || this.rung >= LADDER.length - 1) return;
    if (this._warmup > 0) {
      this._warmup--;
      return;
    }
    this._frameTimes.push(frameMs);
    if (this._frameTimes.length < SAMPLE_FRAMES) return;
    if (this._frameTimes.length > SAMPLE_FRAMES) this._frameTimes.shift();
    let sum = 0;
    for (let i = 0; i < this._frameTimes.length; i++) sum += this._frameTimes[i];
    if (sum / this._frameTimes.length > DROP_MS) {
      this._applyRung(this.rung + 1);
      this._frameTimes.length = 0;
      this._warmup = WARMUP_FRAMES;
      console.warn('band capture: dropped to ' + this.label);
    }
  }

  _applyRung(index) {
    let i = index;
    while (i < LADDER.length) {
      const spec = LADDER[i];
      if (spec.mode === 'cube') {
        this._disposeSliceTargets();
        this.N = 0;
        this.sliceW = 0;
        this.mode = 'cube';
        this.samples = 0;
        this.rung = i;
        if (!this.cubeTarget) this._initCube();
        else this.quad.material = this.cubeMaterial;
        return;
      }
      this.N = spec.slices;
      this.sliceW = Math.round(this.outW / this.N);
      this.atlasW = this.sliceW * this.N;
      this.mode = 'slices';
      const nChanged = !this.cameras || this.cameras.length !== this.N;
      if (nChanged) {
        this._disposeSliceTargets();
        const atlas = tryCreateRT(
          this.renderer, this.atlasW, this.outH,
          hdrOptions(0, true)
        );
        if (!atlas) {
          i++;
          continue;
        }
        this._initSlices(atlas);
      }
      this._setSamples(spec.samples);
      this.rung = i;
      return;
    }
    this.N = 0;
    this.mode = 'cube';
    this.rung = LADDER.length - 1;
    if (!this.cubeTarget) this._initCube();
  }

  _setSamples(want) {
    const cap = Math.min(Math.max(0, want), this.renderer.capabilities.maxSamples);
    if (this.tile && this.samples === cap && this.tile.width === this.sliceW) return;
    if (this.tile) {
      this.tile.dispose();
      this.tile = null;
    }
    this.tile = tryCreateRT(this.renderer, this.sliceW, this.outH, hdrOptions(cap, true));
    this.samples = this.tile ? cap : 0;
  }

  _disposeSliceTargets() {
    if (this.atlas) {
      this.atlas.dispose();
      this.atlas = null;
    }
    if (this.tile) {
      this.tile.dispose();
      this.tile = null;
    }
    if (this.sliceMaterial) {
      this.sliceMaterial.dispose();
      this.sliceMaterial = null;
    }
    this.cameras = [];
    this.samples = 0;
  }

  // ---------------------------------------------------------------- slices

  _initSlices(atlas) {
    const N = this.N;
    this.atlas = atlas;
    this.cameras = [];
    this.ranges = [];
    this.uView = [];
    this.uProj = [];

    for (let i = 0; i < N; i++) {
      const left = i / N;
      const right = (i + 1) / N;
      if (left >= this.entranceU) {
        this.ranges.push(null);
        this.cameras.push(null);
        this.uView.push(new THREE.Matrix4());
        this.uProj.push(new THREE.Matrix4());
        continue;
      }
      const fadeLeft = i > 0;
      const fadeRight = right < this.entranceU;
      const u0 = fadeLeft ? left - this.overlap : left;
      const u1 = fadeRight ? Math.min(right + this.overlap, this.entranceU) : Math.min(right, this.entranceU);
      const range = { left, right, u0, u1, uC: 0.5 * (u0 + u1) };
      this.ranges.push(range);

      const cam = new THREE.PerspectiveCamera(this.band.verticalFov, this.sliceW / this.outH, NEAR, FAR);
      this._fitFov(cam, range);
      this.cameras.push(cam);
      this.uView.push(new THREE.Matrix4());
      this.uProj.push(new THREE.Matrix4().copy(cam.projectionMatrix));
    }

    this.sliceMaterial = new THREE.ShaderMaterial({
      uniforms: {
        ...commonUniforms(this.band),
        uAtlas: { value: atlas.texture },
        uView: { value: this.uView },
        uProj: { value: this.uProj },
        uOverlap: { value: this.overlap }
      },
      vertexShader: VERTEX,
      fragmentShader: sliceFragment(N),
      depthTest: false,
      depthWrite: false,
      toneMapped: true
    });
    this.quad.material = this.sliceMaterial;
    this.renderer.initRenderTarget(atlas);
    if (!this._testedCameras) {
      this._selfTestCameras();
      this._testedCameras = true;
    }
  }

  _fitFov(camera, range) {
    camera.position.set(0, 0, 0);
    this._aim(camera, range.uC, 0.5, 0, camera.position);
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();

    let maxX = 0;
    let maxY = 0;
    for (let i = 0; i <= GRID; i++) {
      for (let j = 0; j <= GRID; j++) {
        const u = range.u0 + (range.u1 - range.u0) * (i / GRID);
        const v = j / GRID;
        bandDirection(u, v, 0, this.frontFrac, this.elevCenter, this.vFov, _dir);
        _view.set(_dir.x, _dir.y, _dir.z).applyMatrix4(camera.matrixWorldInverse);
        if (_view.z >= 0) continue;
        const nx = Math.abs(_view.x / -_view.z);
        const ny = Math.abs(_view.y / -_view.z);
        if (nx > maxX) maxX = nx;
        if (ny > maxY) maxY = ny;
      }
    }
    maxX *= FOV_PAD;
    maxY *= FOV_PAD;
    const tanHalfV = Math.max(maxY, maxX / camera.aspect, Math.tan(this.vFov * 0.5));
    camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(tanHalfV));
    camera.updateProjectionMatrix();
  }

  _aim(camera, u, v, yaw, position) {
    bandDirection(u, v, yaw, this.frontFrac, this.elevCenter, this.vFov, _dir);
    camera.position.copy(position);
    camera.up.set(0, 1, 0);
    camera.lookAt(position.x + _dir.x, position.y + _dir.y, position.z + _dir.z);
    camera.updateMatrixWorld();
  }

  _selfTestCameras() {
    const origin = new THREE.Vector3();
    const vHorizon = 0.5 - this.elevCenter / this.vFov;
    const probe = new THREE.PerspectiveCamera(40, 1, NEAR, FAR);
    this._aim(probe, this.frontFrac, vHorizon, 0, origin);
    probe.getWorldDirection(_look);
    // yaw=0, horizon, front wall: the look is -Z.
    if (_look.distanceTo(new THREE.Vector3(0, 0, -1)) > 1e-5) {
      console.error('band capture: lookAt sign is wrong', _look);
    }
    this._aim(probe, this.frontFrac, vHorizon, Math.PI / 2, origin);
    probe.getWorldDirection(_look);
    if (_look.distanceTo(new THREE.Vector3(1, 0, 0)) > 1e-5) {
      console.error('band capture: starboard lookAt is wrong', _look);
    }

    for (let i = 0; i < this.N; i++) {
      const cam = this.cameras[i];
      const range = this.ranges[i];
      if (!cam) continue;
      this._aim(cam, range.uC, 0.5, 0, origin);
      cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
      for (let gi = 0; gi <= GRID; gi++) {
        for (let gj = 0; gj <= GRID; gj++) {
          const u = range.u0 + (range.u1 - range.u0) * (gi / GRID);
          const v = gj / GRID;
          bandDirection(u, v, 0, this.frontFrac, this.elevCenter, this.vFov, _dir);
          _view.set(_dir.x, _dir.y, _dir.z).applyMatrix4(cam.matrixWorldInverse);
          if (_view.z >= 0) {
            console.error(`band capture: slice ${i} ray behind camera at u=${u.toFixed(3)} v=${v.toFixed(3)}`);
            return;
          }
          const ndcX = _view.x / -_view.z * (cam.projectionMatrix.elements[0]);
          const ndcY = _view.y / -_view.z * (cam.projectionMatrix.elements[5]);
          if (Math.abs(ndcX) > 0.98 || Math.abs(ndcY) > 0.98) {
            console.error(`band capture: slice ${i} frustum misses u=${u.toFixed(3)} v=${v.toFixed(3)} ndc=(${ndcX.toFixed(3)}, ${ndcY.toFixed(3)})`);
            return;
          }
        }
      }
    }
  }

  _renderSlices(position, yaw) {
    const renderer = this.renderer;
    const N = this.N;

    renderer.autoClear = false;
    renderer.setClearColor(0x000000, 1);

    if (this.tile) {
      for (let i = 0; i < N; i++) {
        const cam = this.cameras[i];
        const range = this.ranges[i];
        if (!cam) continue;
        this._aim(cam, range.uC, 0.5, yaw, position);
        renderer.setRenderTarget(this.tile);
        renderer.setViewport(0, 0, this.sliceW, this.outH);
        renderer.setScissorTest(false);
        renderer.clear(true, true, false);
        renderer.render(this.scene, cam);
        this.uView[i].copy(cam.matrixWorldInverse);
        this.uProj[i].copy(cam.projectionMatrix);
        this._copyPos.set(i * this.sliceW, 0);
        renderer.copyTextureToTexture(this.tile.texture, this.atlas.texture, null, this._copyPos);
      }
    } else {
      renderer.setRenderTarget(this.atlas);
      renderer.setScissorTest(true);
      for (let i = 0; i < N; i++) {
        const cam = this.cameras[i];
        const range = this.ranges[i];
        if (!cam) continue;
        this._aim(cam, range.uC, 0.5, yaw, position);
        const x = i * this.sliceW;
        renderer.setViewport(x, 0, this.sliceW, this.outH);
        renderer.setScissor(x, 0, this.sliceW, this.outH);
        renderer.clear(true, true, false);
        renderer.render(this.scene, cam);
        this.uView[i].copy(cam.matrixWorldInverse);
        this.uProj[i].copy(cam.projectionMatrix);
      }
    }

    this.sliceMaterial.uniforms.uYaw.value = yaw;

    renderer.setScissorTest(false);
    renderer.setRenderTarget(null);
    renderer.setViewport(0, 0, this.outW, this.outH);
    renderer.clear(true, true, false);
    renderer.setScissorTest(true);
    renderer.setScissor(0, 0, this.entrancePx, this.outH);
    renderer.render(this.bandScene, this.bandCamera);
    renderer.setScissorTest(false);
  }

  // ---------------------------------------------------------------- cube fallback

  _initCube() {
    const size = this.band.cubeSize;
    this.cubeTarget = new THREE.WebGLCubeRenderTarget(size, {
      type: THREE.HalfFloatType,
      colorSpace: THREE.LinearSRGBColorSpace,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false
    });
    this.cubeCamera = new THREE.CubeCamera(NEAR, FAR, this.cubeTarget);
    this.cubeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        ...commonUniforms(this.band),
        uCube: { value: this.cubeTarget.texture }
      },
      vertexShader: VERTEX,
      fragmentShader: cubeFragment(),
      depthTest: false,
      depthWrite: false,
      toneMapped: true
    });
    this.quad.material = this.cubeMaterial;

    const renderer = this.renderer;
    renderer.setClearColor(0x000000, 1);
    for (const face of [2, 3]) {
      renderer.setRenderTarget(this.cubeTarget, face);
      renderer.clear();
    }
    renderer.setRenderTarget(null);
  }

  _renderCube(position, yaw) {
    const renderer = this.renderer;
    const cubeCamera = this.cubeCamera;
    cubeCamera.position.copy(position);
    if (cubeCamera.parent === null) cubeCamera.updateMatrixWorld();
    if (cubeCamera.coordinateSystem !== renderer.coordinateSystem) {
      cubeCamera.coordinateSystem = renderer.coordinateSystem;
      cubeCamera.updateCoordinateSystem();
    }

    const cameras = cubeCamera.children;
    this.cubeTarget.texture.generateMipmaps = false;
    for (let k = 0; k < SIDE_FACES.length; k++) {
      const face = SIDE_FACES[k];
      renderer.setRenderTarget(this.cubeTarget, face);
      renderer.render(this.scene, cameras[face]);
    }

    this.cubeMaterial.uniforms.uYaw.value = yaw;
    renderer.setRenderTarget(null);
    renderer.setViewport(0, 0, this.outW, this.outH);
    renderer.autoClear = true;
    renderer.render(this.bandScene, this.bandCamera);
  }
}
