/**
 * Spatial audio engine.
 *
 * Every body gets its own synthesised drone routed through a PannerNode placed at the
 * body's scene position. The AudioListener sits on whichever body you selected and faces
 * along its direction of travel, so as that body swings around the Sun the entire sound
 * field rotates around your head. Nothing is sampled or downloaded; each voice is built
 * from the recipe in bodies.js.
 */

const RAD = 180 / Math.PI;

/**
 * Distance attenuation shared by the PannerNodes, the on-screen meters and the OSC
 * stream. These are scene units, where Earth's orbit has a radius of 12.
 */
export const DISTANCE = {
  model: 'inverse',
  refDistance: 8,
  rolloffFactor: 0.85,
  maxDistance: 500
};

/** The Web Audio inverse distance model, mirrored so the UI can display real gains. */
export function distanceGain(d) {
  const { refDistance: r, rolloffFactor: f } = DISTANCE;
  return r / (r + f * (Math.max(d, r) - r));
}

/**
 * Doppler was removed from the Web Audio spec, so it is applied by hand as a detune. The
 * scale is chosen to be expressive rather than physical: it tracks scene units per real
 * second, which means the effect grows as you speed the simulation up.
 */
const DOPPLER_CENTS_PER_UNIT = 26;
const DOPPLER_LIMIT_CENTS = 350;

/**
 * Listener-relative geometry for every body. Pure maths, so the radar and the OSC stream
 * still work with the audio muted.
 *
 * @param positions  scene positions, anything with x/y/z
 * @param velocities scene units per real second, same order
 * @param listener   {position, velocity, index} — index is the body being stood on, or a
 *                   negative number when the listener is not a body at all, which is the
 *                   case on the CRAIVE band where the room itself is the vehicle
 * @param out        array reused between frames
 */
export function computeField(positions, velocities, listener, fwd, up, out) {
  const lp = listener.position;
  const lv = listener.velocity;
  const listenerIndex = listener.index;
  // right = forward x up, which is +X for the usual forward = -Z, up = +Y frame.
  const rx = fwd.y * up.z - fwd.z * up.y;
  const ry = fwd.z * up.x - fwd.x * up.z;
  const rz = fwd.x * up.y - fwd.y * up.x;

  for (let i = 0; i < positions.length; i++) {
    const p = positions[i], v = velocities[i];
    const dx = p.x - lp.x, dy = p.y - lp.y, dz = p.z - lp.z;
    const dist = Math.hypot(dx, dy, dz);
    const f = out[i] || (out[i] = {});

    f.distance = dist;
    f.right = dx * rx + dy * ry + dz * rz;
    f.up = dx * up.x + dy * up.y + dz * up.z;
    f.front = dx * fwd.x + dy * fwd.y + dz * fwd.z;
    f.azimuth = (i === listenerIndex || dist < 1e-6) ? 0 : Math.atan2(f.right, f.front) * RAD;
    f.elevation = dist < 1e-6 ? 0 : Math.asin(Math.max(-1, Math.min(1, f.up / dist))) * RAD;
    f.gain = i === listenerIndex ? 1 : distanceGain(dist);

    if (dist < 1e-6) {
      f.radialVelocity = 0;
    } else {
      // Positive means receding, which lowers the pitch.
      f.radialVelocity = ((v.x - lv.x) * dx + (v.y - lv.y) * dy + (v.z - lv.z) * dz) / dist;
    }
  }
  return out;
}

/** One body's voice: oscillator stack, filter, LFO, orbital pulse, panner and bypass. */
class Voice {
  constructor(ctx, body, noiseBuffer, destination) {
    const spec = body.sound;
    this.spec = spec;
    this.sources = [];
    this.detunables = [];

    this.filter = ctx.createBiquadFilter();
    this.filter.type = spec.filter.type;
    this.filter.frequency.value = spec.filter.freq;
    this.filter.Q.value = spec.filter.q ?? 1;

    this.level = ctx.createGain();
    this.pulse = ctx.createGain();
    this.pulse.gain.value = 1;

    this.panner = ctx.createPanner();
    this.panner.panningModel = 'HRTF';
    this.panner.distanceModel = DISTANCE.model;
    this.panner.refDistance = DISTANCE.refDistance;
    this.panner.rolloffFactor = DISTANCE.rolloffFactor;
    this.panner.maxDistance = DISTANCE.maxDistance;

    // A panner sitting exactly on the listener produces nothing useful, so the body you
    // are standing on is crossfaded onto a plain, quieter, non-spatial path instead.
    this.pannerGain = ctx.createGain();
    this.pannerGain.gain.value = 1;
    this.bypassGain = ctx.createGain();
    this.bypassGain.gain.value = 0;

    this.filter.connect(this.level);
    this.level.connect(this.pulse);
    this.pulse.connect(this.pannerGain).connect(this.panner).connect(destination);
    this.pulse.connect(this.bypassGain).connect(destination);

    let carrier = null;
    for (const o of spec.osc) {
      const osc = ctx.createOscillator();
      osc.type = o.type;
      osc.frequency.value = spec.freq * o.ratio;
      osc.detune.value = o.detune ?? 0;
      const g = ctx.createGain();
      g.gain.value = o.gain;
      osc.connect(g).connect(this.filter);
      this.sources.push(osc);
      this.detunables.push({ param: osc.detune, base: o.detune ?? 0 });
      if (!carrier) carrier = osc;
    }

    if (spec.fm && carrier) {
      const mod = ctx.createOscillator();
      mod.type = 'sine';
      mod.frequency.value = spec.freq * spec.fm.ratio;
      const depth = ctx.createGain();
      depth.gain.value = spec.fm.index;
      mod.connect(depth).connect(carrier.frequency);
      this.sources.push(mod);
    }

    if (spec.noise) {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer;
      src.loop = true;
      const nf = ctx.createBiquadFilter();
      nf.type = spec.noise.type;
      nf.frequency.value = spec.noise.freq;
      nf.Q.value = spec.noise.q ?? 1;
      const ng = ctx.createGain();
      ng.gain.value = spec.noise.gain;
      src.connect(nf).connect(ng).connect(this.filter);
      this.sources.push(src);
    }

    this.#wireLfo(ctx, spec);
  }

  #wireLfo(ctx, spec) {
    const lfo = spec.lfo;
    if (!lfo) {
      this.level.gain.value = spec.gain;
      return;
    }
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = lfo.rate;
    const depth = ctx.createGain();
    osc.connect(depth);
    this.sources.push(osc);

    switch (lfo.target) {
      case 'gain': {
        // Swing between gain*(1-depth) and gain, so depth 1 fades fully out and back.
        const half = (spec.gain * lfo.depth) / 2;
        this.level.gain.value = spec.gain - half;
        depth.gain.value = half;
        depth.connect(this.level.gain);
        break;
      }
      case 'filter': {
        this.level.gain.value = spec.gain;
        const swing = Math.min(spec.filter.freq * lfo.depth * 0.7, spec.filter.freq - 30);
        depth.gain.value = Math.max(swing, 0);
        depth.connect(this.filter.frequency);
        break;
      }
      case 'pitch': {
        this.level.gain.value = spec.gain;
        depth.gain.value = lfo.depth; // cents
        for (const d of this.detunables) depth.connect(d.param);
        break;
      }
      default:
        this.level.gain.value = spec.gain;
    }
  }

  start(when) {
    for (const s of this.sources) s.start(when);
  }

  stop(when) {
    for (const s of this.sources) {
      try { s.stop(when); } catch { /* already stopped */ }
    }
  }
}

export class AudioEngine {
  constructor(bodies) {
    this.bodies = bodies;
    this.ctx = null;
    this.voices = [];
    this.running = false;
    this.doppler = true;
    this.volume = 0.8;
  }

  /**
   * Builds the graph if need be and starts it. Browsers only start audio from a user
   * gesture: called outside one, the context waits suspended, and this promise with it,
   * until start() is called again from one. See startWithoutGesture().
   */
  async start() {
    if (this.running) return;
    if (!this.ctx) this.#build();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.running = true;
  }

  /**
   * start() for a page nobody has clicked on yet, which is what the view switch reloads
   * into. Chrome carries the click on the switch across a same-site navigation, so this
   * usually starts at once; other browsers hold the context until the first click or key
   * press anywhere, which then starts it.
   */
  startWithoutGesture() {
    return new Promise((resolve, reject) => {
      const events = ['click', 'keydown'];
      const done = () => {
        for (const type of events) window.removeEventListener(type, retry, true);
        resolve();
      };
      // Click rather than pointerdown: by the time a click reaches the Start audio button,
      // audio started on its pointerdown would already be running, and the button would
      // stop it again.
      const retry = () => { if (!this.running) this.start().then(done, reject); };
      for (const type of events) window.addEventListener(type, retry, true);
      this.start().then(done, reject);
    });
  }

  #build() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) throw new Error('This browser has no Web Audio support.');

    const ctx = new Ctx({ latencyHint: 'interactive' });
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 12;
    comp.ratio.value = 4;
    comp.attack.value = 0.005;
    comp.release.value = 0.25;

    this.bus = ctx.createGain();
    this.bus.connect(comp).connect(this.master).connect(ctx.destination);

    const noise = this.#makeNoise(ctx);
    this.voices = this.bodies.map((b) => new Voice(ctx, b, noise, this.bus));

    // Fade in so nine drones do not arrive as a thud.
    const now = ctx.currentTime;
    this.master.gain.setValueAtTime(0, now);
    this.master.gain.linearRampToValueAtTime(this.volume, now + 1.2);
    for (const v of this.voices) v.start(now);
  }

  stop() {
    if (!this.running) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(this.master.gain.value, now);
    this.master.gain.linearRampToValueAtTime(0, now + 0.3);
    for (const v of this.voices) v.stop(now + 0.4);
    setTimeout(() => ctx.close().catch(() => {}), 600);
    this.ctx = null; // the next start() builds a fresh graph
    this.voices = [];
    this.running = false;
  }

  setVolume(v) {
    this.volume = v;
    if (this.running) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.03);
  }

  setDoppler(on) {
    this.doppler = on;
    if (!on && this.running) {
      const t = this.ctx.currentTime;
      for (const v of this.voices) {
        for (const d of v.detunables) d.param.setTargetAtTime(d.base, t, 0.05);
      }
    }
  }

  /**
   * Pushes one frame of simulation state into the audio graph.
   *
   * @param positions  scene positions of every body
   * @param field      output of computeField for this frame
   * @param listener   {position, index} — index < 0 when the listener is not a body, in
   *                   which case every voice stays spatialised
   * @param fwd        listener heading, unit
   * @param up         listener up, unit
   * @param phases     orbital mean anomaly in radians, drives the once-per-orbit swell
   */
  update(positions, field, listener, fwd, up, phases) {
    if (!this.running) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const smooth = 0.02;
    const listenerIndex = listener.index;

    const L = ctx.listener;
    const lp = listener.position;
    if (L.positionX) {
      L.positionX.setTargetAtTime(lp.x, t, smooth);
      L.positionY.setTargetAtTime(lp.y, t, smooth);
      L.positionZ.setTargetAtTime(lp.z, t, smooth);
      L.forwardX.setTargetAtTime(fwd.x, t, smooth);
      L.forwardY.setTargetAtTime(fwd.y, t, smooth);
      L.forwardZ.setTargetAtTime(fwd.z, t, smooth);
      L.upX.setTargetAtTime(up.x, t, smooth);
      L.upY.setTargetAtTime(up.y, t, smooth);
      L.upZ.setTargetAtTime(up.z, t, smooth);
    } else {
      L.setPosition(lp.x, lp.y, lp.z);
      L.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z);
    }

    for (let i = 0; i < this.voices.length; i++) {
      const v = this.voices[i];
      const p = positions[i];
      const pn = v.panner;
      if (pn.positionX) {
        pn.positionX.setTargetAtTime(p.x, t, smooth);
        pn.positionY.setTargetAtTime(p.y, t, smooth);
        pn.positionZ.setTargetAtTime(p.z, t, smooth);
      } else {
        pn.setPosition(p.x, p.y, p.z);
      }

      const isListener = i === listenerIndex;
      v.pannerGain.gain.setTargetAtTime(isListener ? 0 : 1, t, 0.08);
      v.bypassGain.gain.setTargetAtTime(isListener ? 0.45 : 0, t, 0.08);

      // Once-per-orbit swell peaking at perihelion, so the visuals and the audio agree.
      const depth = v.spec.pulse ?? 0;
      const swell = 1 - depth + depth * (0.5 + 0.5 * Math.cos(phases[i]));
      v.pulse.gain.setTargetAtTime(swell, t, 0.05);

      if (this.doppler) {
        const cents = Math.max(-DOPPLER_LIMIT_CENTS, Math.min(DOPPLER_LIMIT_CENTS,
          -field[i].radialVelocity * DOPPLER_CENTS_PER_UNIT));
        field[i].dopplerCents = isListener ? 0 : cents;
        for (const d of v.detunables) {
          d.param.setTargetAtTime(d.base + (isListener ? 0 : cents), t, 0.06);
        }
      } else {
        field[i].dopplerCents = 0;
      }
    }
  }

  /** Two seconds of white noise, shared by every voice that needs a noise bed. */
  #makeNoise(ctx) {
    const frames = ctx.sampleRate * 2;
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }
}
