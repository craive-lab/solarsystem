/**
 * DOM panels: the body list with live bearings, the transport, the audio controls and the
 * OSC panel. Everything the user changes is reported through the handlers object; nothing
 * in here touches three.js or Web Audio directly.
 */

const $ = (id) => document.getElementById(id);

/** Where a user-chosen WebSocket URL is remembered between visits. */
const WS_URL_KEY = 'solarsystem.wsUrl';

/** The URL the user typed, or '' if they have not overridden the server's. */
export function savedWsUrl() {
  try {
    return (localStorage.getItem(WS_URL_KEY) || '').trim();
  } catch {
    return ''; // private browsing, or storage disabled
  }
}

function rememberWsUrl(url) {
  try {
    if (url) localStorage.setItem(WS_URL_KEY, url);
    else localStorage.removeItem(WS_URL_KEY);
  } catch { /* nothing we can do, the URL just will not persist */ }
}

/**
 * Checks a WebSocket URL before we hand it to osc.js, so an obvious mistake produces a
 * useful message instead of a bare connection failure.
 */
export function checkWsUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return 'not a URL — expected something like ws://127.0.0.1:8080/osc';
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    return `scheme must be ws:// or wss://, not ${parsed.protocol}//`;
  }
  if (location.protocol === 'https:' && parsed.protocol === 'ws:') {
    return 'this page is https, so the socket must be wss:// — browsers block mixed content';
  }
  return null;
}

/** Slider position 0-1000 to simulation rate in days per second, logarithmically. */
export const speedFromSlider = (v) => 0.05 * Math.pow(6000, v / 1000);
export const sliderFromSpeed = (d) => Math.round((Math.log(d / 0.05) / Math.log(6000)) * 1000);

function hex(color) {
  return '#' + color.toString(16).padStart(6, '0');
}

/** Julian date to a readable UTC calendar date. */
function calendar(jd) {
  const ms = (jd - 2440587.5) * 86400000;
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return 'out of range';
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

export class UI {
  constructor(bodies, handlers) {
    this.bodies = bodies;
    this.h = handlers;
    this.rows = [];
    this.selected = -1;
    this.#buildList();
    this.#wire();
  }

  #buildList() {
    const list = $('body-list');
    this.bodies.forEach((body, index) => {
      const li = document.createElement('li');
      li.dataset.index = String(index);
      li.style.color = hex(body.color);
      li.innerHTML = `
        <span class="swatch"></span>
        <span><span class="name">${body.name}</span><span class="note">${body.sound.note}</span></span>
        <span class="bearing">&mdash;</span>
        <span class="meter"><i></i></span>`;
      li.addEventListener('click', () => this.h.onSelect(index));
      list.appendChild(li);
      this.rows.push({
        li,
        bearing: li.querySelector('.bearing'),
        meter: li.querySelector('.meter > i')
      });
    });
  }

  #wire() {
    const h = this.h;

    $('gate-start').addEventListener('click', () => { this.#closeGate(); h.onStartAudio(); });
    $('gate-silent').addEventListener('click', () => this.#closeGate());

    $('btn-pause').addEventListener('click', () => h.onTogglePause());
    $('btn-now').addEventListener('click', () => h.onNow());
    $('btn-audio').addEventListener('click', () => h.onToggleAudio());

    $('in-speed').addEventListener('input', (e) => {
      const days = speedFromSlider(+e.target.value);
      $('out-speed').textContent = (days < 10 ? days.toFixed(2) : days.toFixed(0)) + ' d/s';
      h.onSpeed(days);
    });

    $('in-tilt').addEventListener('input', (e) => {
      const tilt = +e.target.value / 10;
      $('out-tilt').textContent = tilt.toFixed(1) + '×';
      h.onTilt(tilt);
    });

    $('in-volume').addEventListener('input', (e) => {
      $('out-volume').textContent = e.target.value + '%';
      h.onVolume(+e.target.value / 100);
    });

    $('in-doppler').addEventListener('change', (e) => h.onDoppler(e.target.checked));
    $('in-heading').addEventListener('change', (e) => h.onHeading(e.target.checked ? 'orbit' : 'camera'));
    $('in-labels').addEventListener('change', (e) => h.onLabels(e.target.checked));

    $('in-osc-rate').addEventListener('input', (e) => {
      const hz = +e.target.value;
      $('out-osc-rate').textContent = hz === 0 ? 'off' : hz + ' Hz';
      h.onOscRate(hz);
    });

    $('btn-osc-apply').addEventListener('click', () => {
      h.onOscTarget($('in-osc-host').value.trim(), +$('in-osc-port').value);
    });
    for (const id of ['in-osc-host', 'in-osc-port']) {
      $(id).addEventListener('keydown', (e) => {
        if (e.key === 'Enter') h.onOscTarget($('in-osc-host').value.trim(), +$('in-osc-port').value);
      });
    }

    const applyWsUrl = () => {
      const url = $('in-ws-url').value.trim();
      // Emptying the box drops the override and goes back to whatever the server offers.
      rememberWsUrl(url === (this.oscConfig?.wsUrl ?? '') ? '' : url);
      h.onWsUrl(url);
    };
    $('btn-ws-apply').addEventListener('click', applyWsUrl);
    $('in-ws-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') applyWsUrl(); });

    document.addEventListener('keydown', (e) => {
      if (e.target.matches('input, textarea')) return;
      if (e.key >= '1' && e.key <= '9') {
        const index = +e.key - 1;
        if (index < this.bodies.length) h.onSelect(index);
      } else if (e.key === ' ') {
        e.preventDefault();
        h.onTogglePause();
      }
    });
  }

  #closeGate() {
    const gate = $('gate');
    gate.classList.add('hiding');
    setTimeout(() => gate.remove(), 550);
  }

  setSelected(index) {
    this.selected = index;
    const body = this.bodies[index];
    this.rows.forEach((r, n) => r.li.classList.toggle('here', n === index));
    $('here-swatch').style.color = hex(body.color);
    $('here-swatch').style.background = hex(body.color);
    $('here-name').textContent = body.name;
    $('here-note').textContent = `${body.sound.note} · ${body.sound.freq.toFixed(2)} Hz`;
    $('here-timbre').textContent = body.sound.timbre;
    $('here-facts').textContent = body.facts;
  }

  setAudioRunning(running) {
    $('btn-audio').textContent = running ? 'Stop audio' : 'Start audio';
  }

  setPaused(paused) {
    $('btn-pause').textContent = paused ? 'Resume' : 'Pause';
  }

  /**
   * Reflects the server's view of the bridge into the OSC panel. When the server runs no
   * relay the UDP destination controls are hidden outright rather than left showing
   * values that nothing acts on.
   */
  setOscConfig(config, activeWsUrl) {
    if (!config) return;
    this.oscConfig = config;
    const relay = config.websocket !== false;

    $('osc-dest').hidden = !relay;
    if (relay) {
      if (document.activeElement !== $('in-osc-host')) $('in-osc-host').value = config.oscHost;
      if (document.activeElement !== $('in-osc-port')) $('in-osc-port').value = config.oscPort;
      $('in-osc-host').disabled = !config.allowRetarget;
      $('in-osc-port').disabled = !config.allowRetarget;
      $('btn-osc-apply').disabled = !config.allowRetarget;
    }

    if (activeWsUrl !== undefined) {
      this.activeWsUrl = activeWsUrl;
      if (document.activeElement !== $('in-ws-url')) $('in-ws-url').value = activeWsUrl || '';
    }
  }

  /** Records where osc.js is actually pointed, which decides what the status can claim. */
  setActiveWsUrl(url) {
    this.activeWsUrl = url;
    if (document.activeElement !== $('in-ws-url')) $('in-ws-url').value = url || '';
  }

  /**
   * True only when the socket is aimed at this server's own relay. Anywhere else and the
   * page has no idea what happens to the packets, so it must not claim a UDP destination.
   */
  #onLocalRelay() {
    const relayUrl = this.oscConfig && this.oscConfig.relayUrl;
    return Boolean(relayUrl) && this.activeWsUrl === relayUrl;
  }

  setOscState(state, detail) {
    const dot = $('osc-dot');
    dot.className = 'dot ' + ({
      connected: 'ok', connecting: 'warn', reconnecting: 'warn', error: 'bad', idle: ''
    }[state] ?? '');

    const local = this.#onLocalRelay();
    const connected = local
      ? `relaying to udp ${this.oscConfig.oscHost}:${this.oscConfig.oscPort}`
      : 'connected to an external bridge';
    const text = {
      connected,
      connecting: 'opening WebSocket…',
      reconnecting: 'reconnecting…',
      error: 'error',
      idle: this.activeWsUrl ? 'not connected' : 'set a WebSocket URL above'
    }[state] ?? state;
    $('osc-status').textContent = detail ? `${text} — ${detail}` : text;
  }

  setOscStats(sent, stats) {
    // The relay's counters only describe this page's traffic when this page is the one
    // using it; otherwise report just what we sent.
    if (!stats || !this.#onLocalRelay()) { $('osc-stats').textContent = `${sent} bundles sent`; return; }
    const kb = (stats.bytesOut / 1024).toFixed(0);
    $('osc-stats').textContent =
      `${sent} bundles · ${stats.packetsOut} udp out (${kb} KB) · ${stats.packetsIn} in`;
  }

  /** Per-frame readouts. Kept to text writes so it stays cheap at 60 fps. */
  update(field, jd, simDays) {
    for (let n = 0; n < this.rows.length; n++) {
      const r = this.rows[n];
      const g = field[n];
      if (n === this.selected) {
        r.bearing.textContent = 'you are here';
        r.meter.style.width = '100%';
      } else {
        const az = g.azimuth >= 0 ? `+${g.azimuth.toFixed(0)}` : g.azimuth.toFixed(0);
        r.bearing.textContent = `az ${az}° el ${g.elevation.toFixed(0)}° · ${g.distance.toFixed(1)}u`;
        r.meter.style.width = (g.gain * 100).toFixed(1) + '%';
      }
    }
    $('out-date').textContent = calendar(jd);
    $('out-jd').textContent = jd.toFixed(2);
  }
}
