// Tap-to-define glossary. Any <button class="term" data-term="key"> in the page shows
// a short plain-language definition, so students without a neuroscience or signal
// processing background can follow along.

export const GLOSSARY = {
  neuron: ['Neuron', 'A nerve cell. Neurons send signals to each other as brief electrical pulses.'],
  spike: ['Spike', 'A brief electrical pulse, about 1 millisecond long, that a neuron fires to send a signal. Also called an action potential.'],
  electrode: ['Electrode', 'A tiny conductive tip placed next to neurons that measures the voltage around it.'],
  bci: ['Brain–computer interface (BCI)', 'A system that records brain activity and turns it into commands for a computer, such as moving a cursor or typing.'],
  channel: ['Channel', "One electrode's stream of measurements. A 1,024-channel implant records 1,024 streams at once."],
  'sample-rate': ['Sample rate', 'How many times per second the voltage is measured. 20 kHz means 20,000 measurements per second on every channel.'],
  bits: ['Bit', 'A single 0 or 1. Each measurement is stored using a fixed number of bits: 10 bits can represent 1,024 different voltage levels.'],
  bandwidth: ['Data rate (bandwidth)', 'How much data a link carries per second. 1 Mb/s is one million bits per second.'],
  compression: ['Compression', 'Representing the same information with fewer bits. This implant must shrink its data more than 200-fold to fit through its radio.'],
  lfp: ['Local field potential (LFP)', 'Slow voltage waves, mostly below 300 Hz, made by the combined activity of thousands of neurons and connections around the electrode.'],
  'line-noise': ['Line noise', "Electrical hum picked up from the building's wiring: 60 Hz in the US, 50 Hz in Europe."],
  frequency: ['Frequency (Hz)', 'How fast something wiggles, in cycles per second (hertz). Spikes are fast wiggles, hundreds to thousands of Hz. The LFP is slow.'],
  filter: ['Filter', 'A rule applied to a signal that removes some frequencies and keeps others, like the bass and treble knobs on a stereo.'],
  'band-pass': ['Band-pass filter', 'Keeps only the frequencies between two cutoffs. It combines a high-pass (removes slow waves) and a low-pass (removes very fast noise).'],
  spectrum: ['Power spectrum', 'A chart of how much of the signal sits at each frequency. Peaks show which kinds of wiggle dominate.'],
  causal: ['Causal filter', 'A filter that uses only the present and the past. A real-time implant must work this way, because it cannot see the future.'],
  microvolt: ['Microvolt (µV)', 'One millionth of a volt. Spikes measured from outside a neuron are tens to a few hundred µV.'],
  threshold: ['Threshold', 'A cutoff level. Any dip in the voltage below it is counted as a spike.'],
  sigma: ['Noise level σ', 'The typical size of the background noise. We estimate it from the median, so that big spikes don’t inflate it.'],
  recall: ['Recall', 'Of all the real spikes, the share we found. Missing spikes lowers recall.'],
  precision: ['Precision', 'Of everything we counted as a spike, the share that was real. Counting noise lowers precision.'],
  waveform: ['Waveform', "The shape of the voltage during one spike. Each neuron's spikes have a slightly different shape, like a voice."],
  pca: ['PCA', 'Principal component analysis. It summarizes each 32-point waveform with the two numbers that capture the biggest differences between waveforms, so each spike becomes one dot on a chart.'],
  kmeans: ['k-means', 'A way to find groups of dots: place k centers, give each dot to its nearest center, move each center to the middle of its dots, and repeat until nothing changes.'],
  'ground-truth': ['Ground truth', 'The correct answer. Because this recording is simulated, we know exactly when each neuron fired, so we can grade every step.'],
  'motor-cortex': ['Motor cortex', 'The strip of brain that plans and controls voluntary movement. Most cursor-control BCIs record from it.'],
  tuning: ['Tuning (favorite direction)', "How a neuron's firing depends on movement. A cosine-tuned neuron fires most for its favorite direction, average when moving sideways to it, and least for the opposite direction."],
  decoder: ['Decoder', 'The algorithm that turns neural activity into a command, here the velocity of the cursor.'],
  calibration: ['Calibration', 'A short session to fit the decoder: the person watches a cursor move to targets and imagines moving it, while the system records which neurons fire.'],
  'population-vector': ['Population vector', "Each neuron votes for its favorite direction. The more it fires above its usual rate, the stronger its vote. Adding up all the votes gives the intended movement."],
  'linear-regression': ['Linear regression', "Finds the best weight for each neuron so that a weighted sum of all neurons' spike counts matches the intended velocity during calibration."],
  kalman: ['Kalman filter', 'Combines two guesses: where the cursor was heading a moment ago (movements are smooth), and what the spikes say right now. It weighs each by how reliable it has been. Widely used in clinical BCI research.'],
  r2: ['R² (variance explained)', "The share of the movement the decoder explains. 1 is perfect. 0 is no better than always guessing 'not moving'."],
  drift: ['Drift', 'Recorded signals change over days as electrodes shift slightly and cells change, so a decoder fitted on day 0 slowly gets worse.'],
  bps: ['Bits per second', 'How much information you deliver per second. Choosing 1 square out of N carries log₂(N − 1) bits. Wrong clicks cancel right ones.'],
  'closed-loop': ['Closed loop', 'The user watches the decoded cursor and corrects as they go. The brain and the decoder work together, so the user can compensate for decoder errors.'],
};

let tip;
let current = null;

function hide() {
  if (!tip) return;
  tip.hidden = true;
  current?.setAttribute('aria-expanded', 'false');
  current = null;
}

function show(btn) {
  const entry = GLOSSARY[btn.dataset.term];
  if (!entry) return;
  if (current === btn) return hide();
  hide();
  tip.innerHTML = '';
  const h = document.createElement('strong');
  h.textContent = entry[0];
  const p = document.createElement('span');
  p.textContent = entry[1];
  tip.append(h, p);
  tip.hidden = false;
  current = btn;
  btn.setAttribute('aria-expanded', 'true');
  btn.setAttribute('aria-describedby', 'glossary-tip');
  // Place below the term, kept inside the viewport.
  const r = btn.getBoundingClientRect();
  const tw = tip.offsetWidth;
  const th = tip.offsetHeight;
  const margin = 12;
  let left = r.left + r.width / 2 - tw / 2;
  left = Math.max(margin, Math.min(window.innerWidth - tw - margin, left));
  let top = r.bottom + 8;
  if (top + th > window.innerHeight - margin) top = r.top - th - 8;
  tip.style.left = `${left + window.scrollX}px`;
  tip.style.top = `${top + window.scrollY}px`;
}

export function initGlossary() {
  tip = document.createElement('div');
  tip.id = 'glossary-tip';
  tip.className = 'glossary-tip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  document.body.append(tip);

  document.querySelectorAll('.term').forEach((btn) => {
    btn.type = 'button';
    btn.setAttribute('aria-expanded', 'false');
    if (!GLOSSARY[btn.dataset.term]) console.warn('Missing glossary term:', btn.dataset.term);
  });
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.term');
    if (btn) {
      e.preventDefault();
      show(btn);
    } else if (!e.target.closest('.glossary-tip')) {
      hide();
    }
  });
  document.addEventListener('keydown', (e) => e.key === 'Escape' && hide());
  window.addEventListener('resize', hide);
  window.addEventListener('hashchange', hide);
}
