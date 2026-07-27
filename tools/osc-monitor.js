#!/usr/bin/env node
/**
 * Zero-dependency OSC monitor for the solar system demo, for people who would rather use
 * Node than Python. Same behaviour as tools/osc-monitor.py.
 *
 *   node tools/osc-monitor.js                 # live table on udp 57120
 *   node tools/osc-monitor.js --port 9000
 *   node tools/osc-monitor.js --raw           # print every message
 *
 * Nothing outside the Node standard library is used, so this also serves as a short
 * reference implementation of OSC 1.0 decoding.
 */

'use strict';
const dgram = require('dgram');

// ----------------------------------------------------------------- OSC decoding

const padded = (n) => (n + 3) & ~3;

function readString(buf, i) {
  let end = i;
  while (end < buf.length && buf[end] !== 0) end++;
  return [buf.toString('utf8', i, end), i + padded(end - i + 1)];
}

function decodeMessage(buf, i, end) {
  let address;
  [address, i] = readString(buf, i);
  const args = [];
  let tags = ',';
  if (i < end) {
    [tags, i] = readString(buf, i);
    for (const tag of tags.slice(1)) {
      switch (tag) {
        case 'i': args.push(buf.readInt32BE(i)); i += 4; break;
        case 'f': args.push(buf.readFloatBE(i)); i += 4; break;
        case 'd': args.push(buf.readDoubleBE(i)); i += 8; break;
        case 'h': args.push(buf.readBigInt64BE(i)); i += 8; break;
        case 't': args.push(buf.readBigUInt64BE(i)); i += 8; break;
        case 's': case 'S': { let v; [v, i] = readString(buf, i); args.push(v); break; }
        case 'b': { const n = buf.readInt32BE(i); i += 4; args.push(buf.subarray(i, i + n)); i += padded(n); break; }
        case 'c': args.push(String.fromCharCode(buf.readInt32BE(i))); i += 4; break;
        case 'r': case 'm': args.push(buf.readUInt32BE(i)); i += 4; break;
        case 'T': args.push(true); break;
        case 'F': args.push(false); break;
        case 'N': args.push(null); break;
        case 'I': args.push(Infinity); break;
        default: throw new Error('unsupported OSC type tag ' + tag);
      }
    }
  }
  return { address, args, types: tags.slice(1) };
}

/** Returns a flat list of messages for a packet, descending into bundles. */
function decode(buf, i = 0, end = buf.length, out = []) {
  if (end - i >= 8 && buf.toString('latin1', i, i + 8) === '#bundle\0') {
    i += 16; // marker plus the 8-byte time tag
    while (i + 4 <= end) {
      const size = buf.readInt32BE(i);
      i += 4;
      if (size < 0 || i + size > end) break;
      decode(buf, i, i + size, out);
      i += size;
    }
  } else {
    out.push(decodeMessage(buf, i, end));
  }
  return out;
}

// ----------------------------------------------------------------- display

const BODY_FIELDS = ['index', 'x', 'y', 'z', 'right', 'up', 'front',
  'distance', 'azimuth', 'elevation', 'gain', 'freq', 'phase', 'doppler'];

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf('--' + name);
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
};
const PORT = Number(flag('port', 57120));
const HOST = flag('host', '127.0.0.1');
const RAW = argv.includes('--raw');

const names = new Map();
const bodies = new Map();
let order = [];
let listener = null;
let simTime = null;
let packets = 0;
let rate = 0;
let windowStart = Date.now();
let windowCount = 0;
let lastDraw = 0;

function feed({ address, args }) {
  if (address === '/ss/bodies') {
    order = [];
    for (let n = 0; n < args[0]; n++) {
      const [, name, addr, , note] = args.slice(1 + n * 5, 6 + n * 5);
      names.set(addr, `${name} (${note})`);
      order.push(addr);
    }
  } else if (address === '/ss/listener') {
    listener = args;
  } else if (address === '/ss/time') {
    simTime = args;
  } else if (address.startsWith('/ss/body/')) {
    const body = {};
    BODY_FIELDS.forEach((k, n) => { body[k] = args[n]; });
    bodies.set(address, body);
    if (!order.includes(address)) order.push(address);
  }
}

const pad = (s, n) => String(s).padEnd(n);
const num = (v, n, d) => v.toFixed(d).padStart(n);

/** Readable fallback if /ss/bodies has not been seen yet: /ss/body/sun -> Sun. */
const displayName = (address) => {
  const leaf = address.split('/').pop().replace(/-/g, ' ');
  return leaf.replace(/\b\w/g, (c) => c.toUpperCase());
};

/** Formats one argument the way its OSC type tag implies. */
function formatArg(value, type) {
  if (type === 'f' || type === 'd') return value.toFixed(3);
  if (type === 's' || type === 'S') return JSON.stringify(value);
  if (type === 'b') return `<blob ${value.length}>`;
  return String(value);
}

function draw() {
  const out = ['\x1b[H\x1b[J'];
  out.push(`\x1b[1mSolar System OSC monitor\x1b[0m   ${packets} packets   ${rate.toFixed(1)} pkt/s\n`);
  if (listener) {
    out.push(`listening from \x1b[36m${listener[1]}\x1b[0m  at (${listener.slice(2, 5).map((v) => v.toFixed(1)).join(', ')})`
      + `  heading (${listener.slice(5, 8).map((v) => v.toFixed(2)).join(', ')})\n`);
  }
  if (simTime) {
    const [sim, j2000, dps, paused] = simTime;
    out.push(`t+${sim.toFixed(2)} d   J2000${j2000 >= 0 ? '+' : ''}${j2000.toFixed(2)} d   ${dps.toFixed(2)} d/s${paused ? '   PAUSED' : ''}\n`);
  }
  out.push(`\n  ${pad('body', 20)} ${'az deg'.padStart(8)} ${'el deg'.padStart(7)} ${'dist'.padStart(8)} ${'gain'.padStart(7)}  level\n`);
  for (const address of order) {
    const b = bodies.get(address);
    if (!b) continue;
    out.push(`  ${pad(names.get(address) ?? displayName(address), 20)} ${num(b.azimuth, 8, 1)} ${num(b.elevation, 7, 1)}`
      + ` ${num(b.distance, 8, 2)} ${num(b.gain, 7, 3)}  ${'#'.repeat(Math.round(b.gain * 28))}\n`);
  }
  out.push('\nCtrl-C to stop.\n');
  process.stdout.write(out.join(''));
}

const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

socket.on('message', (buf, from) => {
  let messages;
  try {
    messages = decode(buf);
  } catch (err) {
    if (RAW) console.log(`  malformed packet from ${from.address}: ${err.message}`);
    return;
  }
  if (RAW) {
    for (const m of messages) {
      console.log(`${from.address}  ${m.address} ` +
        m.args.map((v, n) => formatArg(v, m.types[n])).join(' '));
    }
    return;
  }
  messages.forEach(feed);

  packets++;
  windowCount++;
  const now = Date.now();
  if (now - windowStart >= 1000) {
    rate = (windowCount * 1000) / (now - windowStart);
    windowStart = now;
    windowCount = 0;
  }
  if (now - lastDraw >= 100) {
    lastDraw = now;
    draw();
  }
});

socket.bind(PORT, HOST, () => console.log(`listening for OSC on udp ${HOST}:${PORT}`));
process.on('SIGINT', () => { socket.close(); console.log('\nstopped'); process.exit(0); });
