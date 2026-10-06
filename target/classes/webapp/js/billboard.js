/**
 * Yaw-only facing: upright quads that turn about Y to face a viewpoint.
 *
 * PlaneGeometry's visible face is +Z. lookAt aims that +Z at the flattened
 * viewpoint, so every slice camera sitting on the ship sees the same silhouette.
 *
 *   body at (0, 0, 10), viewpoint at origin → quad +Z is (0, 0, -1)
 *   body at (10, 0, 0), viewpoint at origin → quad +Z is (-1, 0, 0)
 */

import * as THREE from '../vendor/three.module.js';

const _toView = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/** World size of an object that should subtend `deg` degrees at `distance`. */
export function angularSize(distance, deg) {
  return 2 * Math.max(distance, 1e-6) * Math.tan(THREE.MathUtils.degToRad(deg) * 0.5);
}

/**
 * Yaw the object so its +Z faces `viewpointPos` in the XZ plane. Returns false
 * when the two positions share an XZ point (directly above/below) and the
 * yaw is left as it was.
 */
export function aimYawOnly(object, viewpointPos) {
  _toView.copy(viewpointPos).sub(object.position);
  _toView.y = 0;
  if (_toView.lengthSq() < 1e-12) return false;
  object.up.copy(UP);
  object.lookAt(
    object.position.x + _toView.x,
    object.position.y,
    object.position.z + _toView.z
  );
  return true;
}
