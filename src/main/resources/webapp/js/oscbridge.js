/**
 * OSC output, built on osc.js.
 *
 * A browser cannot open a UDP socket, so osc.js encodes real OSC packets and pushes them
 * down a WebSocket to the Jetty server, which relays the bytes verbatim as UDP datagrams.
 * Everything downstream sees ordinary OSC.
 *
 * osc.js is loaded as a classic script (vendor/osc-browser.min.js) and exposes the global
 * `osc`; this module wraps it in a reconnecting port and a per-frame bundle builder.
 *
 * The address schema is documented in README.md. Argument types are explicit because
 * `metadata: true` is set, which matters to receivers that dispatch on the type tag.
 */

const RECONNECT_MIN_MS = 800;
const RECONNECT_MAX_MS = 10000;
/** How often /ss/bodies is repeated, so late-joining receivers learn the layout. */
const LAYOUT_INTERVAL_MS = 5000;

/** Reduces an OSC-unfriendly name to a lower-case address component. */
function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

/**
 * Something readable out of whatever osc.js hands to an error listener. A failed
 * WebSocket surfaces as the browser's own error Event, which deliberately carries no
 * detail — stringifying it gives "[object Event]", which tells a user nothing.
 */
function describeError(err) {
  if (!err) return 'connection failed';
  if (typeof err === 'string') return err;
  if (err.message) return err.message;
  if (typeof Event !== 'undefined' && err instanceof Event) return 'connection refused';
  return String(err);
}

const f = (value) => ({ type: 'f', value: Number.isFinite(value) ? value : 0 });
const i = (value) => ({ type: 'i', value: Math.round(value) | 0 });
const s = (value) => ({ type: 's', value: String(value) });

export class OscBridge extends EventTarget {
  /**
   * @param bodies body list, used to precompute addresses and to announce the layout
   */
  constructor(bodies) {
    super();
    this.bodies = bodies;
    this.addresses = bodies.map((b) => `/ss/body/${slug(b.name)}`);
    this.port = null;
    this.state = 'idle';
    this.url = null;
    this.retryDelay = RECONNECT_MIN_MS;
    this.retryTimer = null;
    this.closedByUs = false;
    this.sent = 0;
    this.lastError = null;
    this.lastLayout = 0;
  }

  get connected() {
    return this.state === 'connected';
  }

  /** Opens a connection, replacing any existing one so the URL can change at runtime. */
  connect(url) {
    if (typeof osc === 'undefined') {
      this.#setState('error', 'osc.js failed to load');
      return;
    }
    clearTimeout(this.retryTimer);
    if (this.port) {
      // Drop the reference first: the old port's close handler checks it before deciding
      // to schedule a retry, and we do not want the previous URL coming back.
      const previous = this.port;
      this.port = null;
      try { previous.close(); } catch { /* already gone */ }
    }
    this.url = url;
    this.closedByUs = false;
    this.retryDelay = RECONNECT_MIN_MS;
    this.#open();
  }

  disconnect() {
    this.closedByUs = true;
    clearTimeout(this.retryTimer);
    if (this.port) {
      try { this.port.close(); } catch { /* already gone */ }
      this.port = null;
    }
    this.#setState('idle');
  }

  #open() {
    clearTimeout(this.retryTimer);
    this.#setState('connecting');
    // metadata:true keeps explicit OSC type tags on every argument.
    const port = new osc.WebSocketPort({ url: this.url, metadata: true });
    this.port = port;

    port.on('ready', () => {
      this.retryDelay = RECONNECT_MIN_MS;
      this.#setState('connected');
      this.sendLayout();
    });
    port.on('close', () => {
      if (this.port === port) this.#scheduleRetry();
    });
    port.on('error', (err) => {
      this.lastError = describeError(err);
      if (this.port === port) this.#scheduleRetry();
    });

    try {
      port.open();
    } catch (err) {
      this.lastError = describeError(err);
      this.#scheduleRetry();
    }
  }

  #scheduleRetry() {
    if (this.closedByUs) return;
    this.#setState('reconnecting');
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.#open(), this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 1.7, RECONNECT_MAX_MS);
  }

  #setState(state, error) {
    this.state = state;
    if (error) this.lastError = error;
    this.dispatchEvent(new CustomEvent('state', { detail: { state, error: this.lastError } }));
  }

  #send(packet) {
    if (!this.connected) return false;
    try {
      this.port.send(packet);
      this.sent++;
      return true;
    } catch (err) {
      this.lastError = String(err);
      return false;
    }
  }

  /**
   * Announces the body table so a receiver can build its own lookup. Repeated every few
   * seconds as well as on connect, so a monitor started midway through still learns the
   * names, frequencies and addresses.
   */
  sendLayout() {
    this.lastLayout = performance.now();
    this.#send({
      address: '/ss/bodies',
      args: [i(this.bodies.length), ...this.bodies.flatMap((b, idx) => [
        i(idx), s(b.name), s(this.addresses[idx]), f(b.sound.freq), s(b.sound.note)
      ])]
    });
  }

  /** Fired once when the user picks a new body to listen from. */
  sendSelect(index, name) {
    this.#send({ address: '/ss/select', args: [i(index), s(name)] });
  }

  /** Fired when the audio engine is started or stopped. */
  sendAudioState(running) {
    this.#send({ address: '/ss/audio', args: [i(running ? 1 : 0)] });
  }

  /**
   * One bundle per tick: transport, listener pose, then every body's world position and
   * its listener-relative geometry. Sent as a single bundle so a receiver sees a coherent
   * snapshot rather than nine independently timed messages.
   */
  sendFrame(state) {
    if (!this.connected) return;
    if (performance.now() - this.lastLayout > LAYOUT_INTERVAL_MS) this.sendLayout();
    const { positions, field, listener, fwd, up, phases, simDays, j2000Days, daysPerSecond, paused } = state;
    const lp = listener.position;
    const packets = [
      {
        // Days since J2000 rather than the raw Julian date: an OSC float32 only resolves
        // a number near 2.45 million to a quarter of a day. Add 2451545.0 for the JD.
        address: '/ss/time',
        args: [f(simDays), f(j2000Days), f(daysPerSecond), i(paused ? 1 : 0)]
      },
      {
        // A negative index means the listener is not a body: on the CRAIVE band it is the
        // room itself, flying free.
        address: '/ss/listener',
        args: [
          i(listener.index), s(listener.name),
          f(lp.x), f(lp.y), f(lp.z),
          f(fwd.x), f(fwd.y), f(fwd.z),
          f(up.x), f(up.y), f(up.z)
        ]
      }
    ];

    for (let n = 0; n < this.bodies.length; n++) {
      const p = positions[n];
      const g = field[n];
      packets.push({
        address: this.addresses[n],
        args: [
          i(n),
          f(p.x), f(p.y), f(p.z),
          f(g.right), f(g.up), f(g.front),
          f(g.distance), f(g.azimuth), f(g.elevation),
          f(g.gain), f(this.bodies[n].sound.freq),
          f(phases[n] / (2 * Math.PI)),
          f(g.dopplerCents ?? 0)
        ]
      });
    }

    // timeTag 0 means "interpret immediately", which is what a live stream wants.
    this.#send({ timeTag: osc.timeTag(0), packets });
  }
}
