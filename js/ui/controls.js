// Helpers that wire HTML controls (sliders, segmented buttons, switches) to callbacks.

/**
 * Bind a range input. `toValue` maps the slider position to a real value
 * (use it for log-scaled sliders), `format` renders the readout.
 */
export function bindRange(id, { toValue = (v) => v, fromValue = (v) => v, format = String, initial, onInput }) {
  const input = document.getElementById(id);
  const out = document.querySelector(`output[for="${id}"]`);
  const show = (v) => {
    if (out) out.textContent = format(v);
  };
  if (initial !== undefined) input.value = fromValue(initial);
  show(toValue(parseFloat(input.value)));
  input.addEventListener('input', () => {
    const v = toValue(parseFloat(input.value));
    show(v);
    onInput(v);
  });
  return {
    input,
    set(v) {
      input.value = fromValue(v);
      show(v);
    },
  };
}

/** Log-scale slider mapping: slider runs 0..1000 between lo and hi. */
export function logScale(lo, hi) {
  const a = Math.log(lo), b = Math.log(hi);
  return {
    toValue: (s) => Math.exp(a + ((b - a) * s) / 1000),
    fromValue: (v) => (1000 * (Math.log(v) - a)) / (b - a),
  };
}

/** A group of buttons that behave like radio buttons. Values come from data-value. */
export function bindSegmented(el, { initial, onChange }) {
  const buttons = [...el.querySelectorAll('button')];
  const select = (value, fire) => {
    for (const b of buttons) b.setAttribute('aria-checked', String(b.dataset.value === String(value)));
    if (fire) onChange(value);
  };
  el.setAttribute('role', 'radiogroup');
  for (const b of buttons) {
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.addEventListener('click', () => select(b.dataset.value, true));
  }
  // Arrow keys move between options, as in a native radio group.
  el.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    const i = buttons.findIndex((b) => b.getAttribute('aria-checked') === 'true');
    const next = buttons[(i + (e.key === 'ArrowRight' ? 1 : buttons.length - 1)) % buttons.length];
    next.focus();
    select(next.dataset.value, true);
  });
  select(initial, false);
  return { select: (v) => select(v, false) };
}

/** A checkbox switch. */
export function bindSwitch(id, { initial, onChange }) {
  const input = document.getElementById(id);
  input.checked = !!initial;
  input.addEventListener('change', () => onChange(input.checked));
  return input;
}

export const fmt = {
  hz: (v) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)} kHz` : `${Math.round(v)} Hz`),
  pct: (v) => `${(v * 100).toFixed(1)}%`,
  bps(v) {
    if (v >= 1e9) return `${(v / 1e9).toFixed(v >= 1e10 ? 0 : 1)} Gb/s`;
    if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e8 ? 0 : 1)} Mb/s`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(v >= 1e5 ? 0 : 1)} kb/s`;
    return `${Math.round(v)} b/s`;
  },
  int: (v) => Math.round(v).toLocaleString('en-US'),
};
