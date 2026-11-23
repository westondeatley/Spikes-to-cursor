// Small canvas plotting toolkit: HiDPI sizing, theme-aware colors, fast trace drawing,
// axis ticks and electrophysiology-style scale bars. No chart library needed.

/** Read a CSS custom property (theme token) from :root. */
export function css(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export const FONT_MONO = '"IBM Plex Mono", ui-monospace, "SFMono-Regular", Menlo, monospace';
export const FONT_SANS = '"IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif';

/** Size the backing store to the element's CSS size x devicePixelRatio. */
export function fitCanvas(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(canvas.clientWidth));
  const h = Math.max(1, Math.round(canvas.clientHeight));
  const bw = Math.round(w * dpr);
  const bh = Math.round(h * dpr);
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

/** Redraw when the canvas resizes or the theme changes. */
export function autoRedraw(canvas, draw) {
  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      draw();
    });
  };
  new ResizeObserver(schedule).observe(canvas);
  window.addEventListener('themechange', schedule);
  return schedule;
}

/**
 * Draw samples x[start .. start+count) across `width` pixels.
 * When there are more samples than pixels, draw the min/max envelope per pixel column
 * (how oscilloscopes decimate) so narrow spikes are never skipped.
 */
export function drawTrace(ctx, x, start, count, left, width, yOf) {
  ctx.beginPath();
  if (count <= width * 1.5) {
    for (let i = 0; i < count; i++) {
      const px = left + (i / Math.max(1, count - 1)) * width;
      const py = yOf(x[start + i] ?? 0);
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    }
  } else {
    const cols = Math.floor(width);
    for (let c = 0; c < cols; c++) {
      const i0 = start + Math.floor((c * count) / cols);
      const i1 = start + Math.floor(((c + 1) * count) / cols);
      let lo = Infinity, hi = -Infinity;
      for (let i = i0; i < i1; i++) {
        const v = x[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      const px = left + c + 0.5;
      if (c === 0) ctx.moveTo(px, yOf(hi));
      else ctx.lineTo(px, yOf(hi));
      ctx.lineTo(px, yOf(lo));
    }
  }
  ctx.stroke();
}

/** "Nice" tick values between lo and hi. */
export function niceTicks(lo, hi, target = 5) {
  const span = hi - lo;
  if (!(span > 0)) return [lo];
  const raw = span / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}

/** Decade ticks for log axes. */
export function decadeTicks(lo, hi) {
  const out = [];
  for (let e = Math.ceil(Math.log10(lo)); e <= Math.floor(Math.log10(hi)); e++) out.push(10 ** e);
  return out;
}

export function formatHz(f) {
  return f >= 1000 ? `${+(f / 1000).toFixed(f % 1000 ? 1 : 0)} kHz` : `${Math.round(f)} Hz`;
}

/**
 * Electrophysiology scale bar: an L-shaped bar labeled with a time span and a voltage span,
 * the convention in neuroscience figures instead of full axes.
 */
export function scaleBar(ctx, x, y, pxPerMs, ms, pxPerUv, uv, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.5;
  const wpx = ms * pxPerMs;
  const hpx = uv * pxPerUv;
  ctx.beginPath();
  ctx.moveTo(x, y - hpx);
  ctx.lineTo(x, y);
  ctx.lineTo(x + wpx, y);
  ctx.stroke();
  ctx.font = `11px ${FONT_MONO}`;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillText(`${ms} ms`, x, y + 4);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  ctx.fillText(`${uv} µV`, x - 5, y - hpx / 2);
  ctx.restore();
}

/** Text label with the panel background behind it, so it stays legible over traces. */
export function label(ctx, text, x, y, { color, bg, align = 'left', baseline = 'top', font = `11px ${FONT_MONO}` } = {}) {
  ctx.save();
  ctx.font = font;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  if (bg) {
    const m = ctx.measureText(text);
    const w = m.width + 8;
    const h = 16;
    let bx = align === 'left' ? x - 4 : align === 'right' ? x - w + 4 : x - w / 2;
    let by = baseline === 'top' ? y - 2 : baseline === 'bottom' ? y - h + 2 : y - h / 2;
    ctx.fillStyle = bg;
    ctx.fillRect(bx, by, w, h);
  }
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
}

/** Unit colors come from theme tokens --u1..--u5; noise uses --noise. */
export function unitColor(k) {
  return k < 0 ? css('--noise') : css(`--u${(k % 5) + 1}`);
}

/** Mix a color with transparency (hex or rgb from tokens). */
export function alpha(color, a) {
  const c = color.trim();
  if (c.startsWith('#')) {
    let h = c.slice(1);
    if (h.length === 3) h = h.split('').map((ch) => ch + ch).join('');
    const n = parseInt(h, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const [r, g, b] = m[1].split(',').map((s) => parseFloat(s));
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }
  return c;
}
