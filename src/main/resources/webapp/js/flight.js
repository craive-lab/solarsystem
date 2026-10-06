/**
 * Keyboard flight, shared by both views: the arrow keys fly and turn, PageUp/PageDown
 * climb and dive, Shift boosts. On the CRAIVE band the ship is the room itself; on the
 * desktop it is what you become when you take off from a body.
 *
 * Yaw only: a room full of people should never have the horizon roll, and the speeds are
 * deliberately unhurried — this is a space you walk around inside, not a game. Earth's
 * orbit has a radius of 12 scene units and Neptune's about 78.
 */

import * as THREE from 'three';

const SPEED = 14;                                 // scene units per second
const BOOST = 4;                                  // multiplier while Shift is held
const TURN_RATE = THREE.MathUtils.degToRad(30);   // radians per second
const MIN_RADIUS = 3.2;                           // never fly into the middle of the Sun

/**
 * Keys are collected as they go down and applied once per frame, so a held key glides
 * instead of stuttering at the OS repeat rate.
 */
const FLIGHT_KEYS = new Set([
  'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'pageup', 'pagedown', 'shift'
]);

/**
 * A listener that is not a body. It goes straight to computeField, the audio engine and
 * the OSC bridge, which read its position, velocity, index and name.
 */
export class Ship {
  constructor(name) {
    this.name = name;
    this.index = -1;
    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    // Heading 0 points along -Z. Increasing yaw swings it toward +X, which is clockwise
    // seen from above: a turn to starboard. So the right arrow adds and the left subtracts.
    this.yaw = 0;
    this.forward = new THREE.Vector3(0, 0, -1);
    this.up = new THREE.Vector3(0, 1, 0); // level flight: the horizon stays put
    this.held = new Set();
    this.from = new THREE.Vector3();
  }

  /**
   * Records a flight key. Returns false for anything else, so the caller can carry on
   * with its own shortcuts.
   */
  press(e) {
    const k = e.key.toLowerCase();
    if (!FLIGHT_KEYS.has(k) || e.ctrlKey || e.metaKey || e.altKey) return false;
    this.held.add(k);
    e.preventDefault(); // these keys would otherwise scroll the page
    return true;
  }

  release(e) { this.held.delete(e.key.toLowerCase()); }

  /** Alt-tabbing away eats the keyup, and a blurred window must not keep flying. */
  releaseAll() { this.held.clear(); }

  /** Call before anything moves the ship this frame; endFrame() then derives its velocity. */
  beginFrame() { this.from.copy(this.position); }

  /** The ship's own motion matters to the Doppler shift as much as the planets' does. */
  endFrame(dt) {
    this.velocity.copy(this.position).sub(this.from).divideScalar(Math.max(dt, 1e-4));
  }

  /** Applies whatever keys are held, for one frame. */
  fly(dt) {
    const held = this.held;
    const turn = (held.has('arrowright') ? 1 : 0) - (held.has('arrowleft') ? 1 : 0);
    if (turn) this.yaw += turn * TURN_RATE * dt;
    this.forward.set(Math.sin(this.yaw), 0, -Math.cos(this.yaw));

    const move = (held.has('arrowup') ? 1 : 0) - (held.has('arrowdown') ? 1 : 0);
    const climb = (held.has('pageup') ? 1 : 0) - (held.has('pagedown') ? 1 : 0);
    if (!move && !climb) return;

    const speed = SPEED * (held.has('shift') ? BOOST : 1) * dt;
    this.position.addScaledVector(this.forward, move * speed);
    this.position.y += climb * speed;

    // Push back out if someone flies into the Sun.
    const r = this.position.length();
    if (r < MIN_RADIUS) this.position.multiplyScalar(MIN_RADIUS / Math.max(r, 1e-6));
  }
}
