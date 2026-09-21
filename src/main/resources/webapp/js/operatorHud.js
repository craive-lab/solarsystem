/**
 * Operator readouts drawn into the Pixelwarp canvas on the front wall, under
 * the sky. DOM overlays sit on the projectors as wallpaper; this mesh is
 * photographed with the band.
 *
 * PlaneGeometry faces +Z. The band ortho camera looks −Z, so a plane at z = −0.5
 * with its default +Z normal faces the camera.
 */
import * as THREE from 'three';

const TEX_W = 2048;
const TEX_H = 256;
/** HUD height in band pixels — sits in the bottom strip, below the useful sky. */
const BAND_PX_H = 90;
const BAND_PX_PAD = 18;

export class OperatorHud {
  constructor({ bandScene, frontFrac, bandHeight, outputWidth }) {
    this.visible = true;
    this._canvas = document.createElement('canvas');
    this._canvas.width = TEX_W;
    this._canvas.height = TEX_H;
    this._g = this._canvas.getContext('2d');

    this.texture = new THREE.CanvasTexture(this._canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;

    const ndcH = (BAND_PX_H / bandHeight) * 2;
    const ndcW = ndcH * (TEX_W / TEX_H);
    const x = frontFrac * 2 - 1;
    const y = -1 + ndcH * 0.5 + (BAND_PX_PAD / bandHeight) * 2;

    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(ndcW, ndcH),
      new THREE.MeshBasicMaterial({
        map: this.texture,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
        fog: false
      })
    );
    this.mesh.position.set(x, y, -0.5);
    this.mesh.renderOrder = 10;
    this.mesh.frustumCulled = false;
    bandScene.add(this.mesh);

    this.ndc = { x, y, w: ndcW, h: ndcH };
    this._frontCanvasX = frontFrac * outputWidth;
  }

  setVisible(on) {
    this.visible = on;
    this.mesh.visible = on;
  }

  /** Band UV (v = 0 at the bottom). True when the operator inset covers this pixel. */
  containsUv(u, v) {
    if (!this.visible) return false;
    const ndcX = u * 2 - 1;
    const ndcY = v * 2 - 1;
    const { x, y, w, h } = this.ndc;
    return Math.abs(ndcX - x) <= w * 0.5 && Math.abs(ndcY - y) <= h * 0.5;
  }

  draw({ heading, position, nearest, captureLabel, labelsOn }) {
    if (!this.visible) return;
    const g = this._g;
    const w = TEX_W;
    const h = TEX_H;
    g.clearRect(0, 0, w, h);
    g.fillStyle = 'rgba(4, 10, 22, 0.62)';
    g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(111, 180, 255, 0.45)';
    g.fillRect(0, 0, w, 4);

    g.fillStyle = '#cfe2ff';
    g.font = '600 52px ui-monospace, "Cascadia Mono", Consolas, monospace';
    g.fillText(position, 28, 70);

    g.fillStyle = '#7fa2cc';
    g.font = '40px ui-monospace, "Cascadia Mono", Consolas, monospace';
    g.fillText(nearest, 28, 128);

    g.fillStyle = '#55708f';
    g.font = '34px ui-monospace, "Cascadia Mono", Consolas, monospace';
    const keys = `H HUD  ·  L labels ${labelsOn ? 'on' : 'off'}  ·  P panels  ·  heading ${heading}°  ·  ${captureLabel}`;
    g.fillText(keys, 28, 190);

    this.texture.needsUpdate = true;
  }
}
