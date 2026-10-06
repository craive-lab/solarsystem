/**
 * Top-down radar of the sound field as heard from the selected body.
 *
 * Straight up is the listener's heading, angle is azimuth, radius is a log-compressed
 * distance and dot size follows the distance gain. It is the clearest way to see that the
 * whole field really does rotate as the body you are standing on moves along its orbit.
 */

const TAU = Math.PI * 2;
const MAX_UNITS = 130;

export class Radar {
  constructor(canvas, bodies) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.bodies = bodies;
    this.colors = bodies.map((b) => '#' + b.color.toString(16).padStart(6, '0'));
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const size = this.canvas.clientWidth || 200;
    this.canvas.width = Math.round(size * dpr);
    this.canvas.height = Math.round(size * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.size = size;
  }

  /** Log compression so Mercury and Neptune are both legible on a 200 px dial. */
  #radius(distance, max) {
    const t = Math.log1p(distance / 6) / Math.log1p(MAX_UNITS / 6);
    return Math.min(t, 1) * max;
  }

  draw(field, listenerIndex) {
    const ctx = this.ctx;
    const size = this.size;
    const cx = size / 2, cy = size / 2;
    const max = size / 2 - 14;

    ctx.clearRect(0, 0, size, size);

    ctx.strokeStyle = 'rgba(126,168,214,0.22)';
    ctx.lineWidth = 1;
    for (const frac of [0.33, 0.66, 1]) {
      ctx.beginPath();
      ctx.arc(cx, cy, max * frac, 0, TAU);
      ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(126,168,214,0.15)';
    for (let a = 0; a < 4; a++) {
      const th = (a * TAU) / 8;
      ctx.beginPath();
      ctx.moveTo(cx - Math.sin(th) * max, cy - Math.cos(th) * max);
      ctx.lineTo(cx + Math.sin(th) * max, cy + Math.cos(th) * max);
      ctx.stroke();
    }

    // Heading marker: the listener always faces the top of the dial.
    ctx.fillStyle = 'rgba(150,200,255,0.75)';
    ctx.beginPath();
    ctx.moveTo(cx, cy - max - 9);
    ctx.lineTo(cx - 5, cy - max - 1);
    ctx.lineTo(cx + 5, cy - max - 1);
    ctx.closePath();
    ctx.fill();

    ctx.font = '9px ui-monospace, monospace';
    ctx.fillStyle = 'rgba(150,200,255,0.5)';
    ctx.textAlign = 'center';
    ctx.fillText('AHEAD', cx, cy - max - 12);
    ctx.textAlign = 'left';
    ctx.fillText('R', cx + max + 3, cy + 3);
    ctx.textAlign = 'right';
    ctx.fillText('L', cx - max - 3, cy + 3);

    for (let n = 0; n < field.length; n++) {
      if (n === listenerIndex) continue;
      const g = field[n];
      const r = this.#radius(g.distance, max);
      const th = (g.azimuth * Math.PI) / 180;
      const x = cx + Math.sin(th) * r;
      const y = cy - Math.cos(th) * r;
      const dot = 2.2 + 6 * g.gain;

      // A soft halo scaled by gain reads as loudness at a glance.
      ctx.globalAlpha = 0.16 + 0.28 * g.gain;
      ctx.fillStyle = this.colors[n];
      ctx.beginPath();
      ctx.arc(x, y, dot * 2.4, 0, TAU);
      ctx.fill();

      ctx.globalAlpha = 0.55 + 0.45 * g.gain;
      ctx.beginPath();
      ctx.arc(x, y, dot, 0, TAU);
      ctx.fill();

      // A tick above or below the dot indicates elevation.
      if (Math.abs(g.elevation) > 1.5) {
        const len = Math.min(Math.abs(g.elevation) / 6, 8);
        ctx.globalAlpha = 0.8;
        ctx.strokeStyle = this.colors[n];
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x, y - Math.sign(g.elevation) * (dot + len));
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // The listener itself.
    ctx.fillStyle = '#e9f2ff';
    ctx.beginPath();
    ctx.arc(cx, cy, 3, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = 'rgba(233,242,255,0.4)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, 6.5, 0, TAU);
    ctx.stroke();
  }
}
