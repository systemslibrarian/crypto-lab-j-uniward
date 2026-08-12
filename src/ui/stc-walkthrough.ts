/**
 * stc-walkthrough.ts — stepped schematic of STC / Viterbi minimum-distortion placement.
 *
 * The review flagged that "minimum-distortion Viterbi search" is named repeatedly
 * but never shown, so HOW the scheme chooses which coefficients to flip stays
 * abstract. This is a labelled *schematic* (explicitly not a live run of the real
 * embedder) that walks a newcomer through the three ideas the real STC in
 * src/stc.ts implements:
 *
 *   1. A keyed permutation spreads the payload across the whole carrier pool, so
 *      changes never cluster.
 *   2. Over the cost map, MANY candidate flip patterns satisfy the message.
 *   3. The Viterbi trellis picks the cheapest pattern in that block exactly — not a greedy
 *      per-coefficient guess.
 *
 * No cryptographic result is fabricated: the numbers here are a small teaching
 * example, clearly framed as an illustration, and the real Viterbi-optimal
 * embedding still runs elsewhere in the app.
 */

interface StepDef {
  title: string;
  caption: string;
  render: (svg: SVGSVGElement) => void;
}

const NS = 'http://www.w3.org/2000/svg';

// Small illustrative carrier costs (cheap = textured, expensive = smooth).
const COSTS = [0.2, 1.6, 0.4, 0.3, 1.9, 0.5, 0.25, 1.4];
// One cheap valid flip-set the trellis would choose; a costlier alternative to contrast.
const CHEAP_SET = [0, 3, 6];     // indices flipped by the minimum-distortion path
const GREEDY_SET = [1, 4, 7];    // a naive/expensive alternative that also encodes bits

function el(name: string, attrs: Record<string, string | number>): SVGElement {
  const e = document.createElementNS(NS, name);
  for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  return e;
}

/** The ink every cell's cost is written in. Constant, so the ramp must suit it. */
const CELL_INK = '#0b1512';

/**
 * Cost → cell fill: low cost cool (textured), high cost warm (smooth), matching
 * the heatmap story the rest of the lab tells.
 *
 * The ramp is deliberately PALE. It used to run rgb(60,120,200) → rgb(220,60,50)
 * — saturated enough that the dark cost label written on top measured 3.55:1 to
 * 4.04:1 against it, under the 4.5:1 floor at every step of the ramp. There is
 * no lightness of a saturated blue-to-red ramp at which near-black text clears
 * AA, so the ramp moved instead of the ink: every stop of this one measures at
 * least 8.9:1 against CELL_INK, and the blue→red reading is unchanged.
 *
 * `dim` desaturates toward a light neutral rather than dropping the cell's
 * opacity. Opacity was the second half of the same bug: a 0.35-alpha cell over
 * the dark-theme `--bg-tertiary` stage composited to a mid-tone, and the label —
 * a full-opacity sibling, not part of the faded group — read 1.70:1 to 1.80:1
 * against it. Washing the colour out keeps the cell light in both themes, so the
 * de-emphasis costs nothing legible, and saturation is a cue that survives a
 * colour-vision deficiency better than the hue shift alone.
 */
function costColor(cost: number, dim = false): string {
  const t = Math.min(1, cost / 2);
  let r = 150 + t * 100;
  let g = 195 - t * 40;
  let b = 250 - t * 105;
  if (dim) {
    const NEUTRAL = 0.6;
    r = r * (1 - NEUTRAL) + 196 * NEUTRAL;
    g = g * (1 - NEUTRAL) + 199 * NEUTRAL;
    b = b * (1 - NEUTRAL) + 204 * NEUTRAL;
  }
  return `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
}

function drawCarriers(svg: SVGSVGElement, highlight: number[], dim = false): void {
  const cellW = 46, cellH = 40, y = 46, x0 = 20;
  COSTS.forEach((cost, i) => {
    const x = x0 + i * cellW;
    const chosen = highlight.includes(i);
    const rect = el('rect', {
      x, y, width: cellW - 8, height: cellH, rx: 5,
      fill: costColor(cost, dim && !chosen),
      // A chosen cell is ringed in the same near-black as the labels — 8:1 or
      // better against every stop of the ramp. The old #ffd166 ring measured
      // 1.33:1 against the cells it was supposed to pick out, so the ring
      // carried none of the selection; the ↧ marker and the full-saturation
      // fill did all the work on their own.
      stroke: chosen ? CELL_INK : 'rgba(0,0,0,0.35)',
      'stroke-width': chosen ? 3 : 1,
    });
    svg.appendChild(rect);
    const label = el('text', {
      x: x + (cellW - 8) / 2, y: y + cellH / 2 + 4,
      'text-anchor': 'middle', 'font-size': 11, fill: CELL_INK, 'font-weight': 700,
    });
    label.textContent = cost.toFixed(2);
    svg.appendChild(label);
    if (chosen) {
      const flip = el('text', {
        x: x + (cellW - 8) / 2, y: y - 6,
        // Sits ABOVE the cell, so its backdrop is the .stc-stage panel, not the
        // ramp. The fixed #ffd166 it used to be measured 1.24:1 on the light
        // theme's stage; the themed token is 7.8:1 dark and 6.0:1 light.
        'text-anchor': 'middle', 'font-size': 13, fill: 'var(--warning-text)', 'font-weight': 700,
      });
      flip.textContent = '↧';
      svg.appendChild(flip);
    }
  });
}

function axisLabel(svg: SVGSVGElement): void {
  const t = el('text', { x: 20, y: 26, 'font-size': 11, fill: 'currentColor', 'font-weight': 600 });
  t.textContent = 'carrier coefficients — number = cost of a ±1 flip (blue cheap ▸ red costly)';
  svg.appendChild(t);
}

const STEPS: StepDef[] = [
  {
    title: '1 · Keyed permutation spreads the payload',
    caption:
      'A key-seeded permutation scatters the message bits across every usable coefficient in the ' +
      'image, so changes never bunch up in one region. Same key on both ends → same order.',
    render(svg) {
      axisLabel(svg);
      drawCarriers(svg, []);
      // draw permutation arrows from a "payload" row to scattered carriers
      const order = [6, 0, 3, 2, 5, 7, 1, 4];
      order.forEach((target, src) => {
        const x1 = 20 + src * 46 + 19;
        const x2 = 20 + target * 46 + 19;
        svg.appendChild(el('path', {
          d: `M ${x1} 118 C ${x1} 100, ${x2} 104, ${x2} 92`,
          fill: 'none', stroke: 'currentColor', 'stroke-width': 1, opacity: 0.5,
        }));
      });
      const pay = el('text', { x: 20, y: 132, 'font-size': 11, fill: 'currentColor' });
      pay.textContent = 'payload bits (in order) ─ permuted ─▸ carrier positions';
      svg.appendChild(pay);
    },
  },
  {
    title: '2 · Many flip-sets satisfy the message',
    caption:
      'STC is a coding problem: lots of different ±1 flip patterns encode the exact same secret ' +
      'bits. A greedy pick (top row) works but wastes distortion on smooth, costly coefficients.',
    render(svg) {
      axisLabel(svg);
      drawCarriers(svg, GREEDY_SET, true);
      const sum = GREEDY_SET.reduce((a, i) => a + COSTS[i], 0);
      const t = el('text', { x: 20, y: 116, 'font-size': 12, fill: 'var(--error-text, #ff7b72)', 'font-weight': 700 });
      t.textContent = `greedy / naive flip-set total distortion = ${sum.toFixed(2)}  (costly!)`;
      svg.appendChild(t);
    },
  },
  {
    title: '3 · Viterbi picks the cheapest set for this block',
    caption:
      'The trellis evaluates candidate paths across the whole row at once and returns the ONE ' +
      'minimum-distortion flip-set that still encodes the message — hitting the cheap, textured ' +
      'coefficients. This is what the real embedder computes (h=12, 4096 states).',
    render(svg) {
      axisLabel(svg);
      drawCarriers(svg, CHEAP_SET, true);
      const sum = CHEAP_SET.reduce((a, i) => a + COSTS[i], 0);
      const t = el('text', { x: 20, y: 116, 'font-size': 12, fill: 'var(--success-color, #3fb950)', 'font-weight': 700 });
      t.textContent = `Viterbi minimum-distortion flip-set total = ${sum.toFixed(2)}  (chosen)`;
      svg.appendChild(t);
    },
  },
];

let step = 0;

function paint(): void {
  const svg = document.getElementById('stc-svg') as unknown as SVGSVGElement | null;
  const title = document.getElementById('stc-step-title');
  const caption = document.getElementById('stc-step-caption');
  const counter = document.getElementById('stc-step-counter');
  const live = document.getElementById('stc-live');
  if (!svg || !title || !caption || !counter) return;
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const s = STEPS[step];
  s.render(svg);
  title.textContent = s.title;
  caption.textContent = s.caption;
  counter.textContent = `Step ${step + 1} of ${STEPS.length}`;
  if (live) live.textContent = `${s.title}. ${s.caption}`;
}

export function setupStcWalkthrough(): void {
  const prev = document.getElementById('stc-prev');
  const next = document.getElementById('stc-next');
  if (!prev || !next) return;
  prev.addEventListener('click', () => { step = (step - 1 + STEPS.length) % STEPS.length; paint(); });
  next.addEventListener('click', () => { step = (step + 1) % STEPS.length; paint(); });
  paint();
}
