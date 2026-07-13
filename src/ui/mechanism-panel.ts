/**
 * mechanism-panel.ts — "Why does this block cost what it costs?" explorer.
 *
 * The pedagogy review's central finding: the wavelet cost function is the entire
 * point of J-UNIWARD, yet it stays a black box — the heatmap shows WHICH blocks
 * are cheap but never WHY. This panel opens the box.
 *
 * Click (or arrow-key) a single 8×8 block on the cover image. We perturb JUST
 * that block by a +1 quantization step in the first AC DCT mode and, using the
 * real Daubechies-8 decomposition (src/steg/WaveletCost.ts → probeBlock, the
 * literal J-UNIWARD definition — no faked numbers), show:
 *
 *   • the ripple |ΔW| each of the 9 wavelet detail subbands feels,
 *   • the cover magnitude |W_cover| already present there (the DENOMINATOR),
 *   • and the resulting normalized cost contribution per subband.
 *
 * The learner SEES that the same ±1 change lands as a small normalized
 * disturbance in busy texture (big denominator → low cost) but a large one in a
 * flat region (tiny denominator → high cost). That is the heart of the scheme,
 * turned from asserted to observed.
 */

import { state } from '../state/app-state.ts';
import { probeBlock, type BlockProbe } from '../steg/WaveletCost.ts';
import { wireGlossary } from './glossary.ts';

const coverCanvas = document.getElementById('cover-canvas') as HTMLCanvasElement;

let mount: HTMLElement | null = null;
let markerCanvas: HTMLCanvasElement | null = null;
let selRow = -1, selCol = -1;

function fmt(n: number): string {
  if (n === 0) return '0';
  if (Math.abs(n) >= 1000) return n.toExponential(1);
  if (Math.abs(n) >= 1) return n.toFixed(2);
  if (Math.abs(n) >= 0.001) return n.toFixed(4);
  return n.toExponential(1);
}

/** Insert the panel host + selection-marker overlay once. */
function ensureMount(): HTMLElement | null {
  if (mount) return mount;
  const anchor = document.getElementById('heatmap-toggle-row');
  if (!anchor || !anchor.parentElement) return null;

  const section = document.createElement('div');
  section.id = 'mechanism-panel';
  section.className = 'mechanism-panel hidden';
  section.setAttribute('aria-labelledby', 'mechanism-heading');
  section.innerHTML = `
    <h3 id="mechanism-heading" class="section-label">Inside the cost: probe a block</h3>
    <p class="text-muted text-xs mechanism-intro">
      Click a spot on the cover image (or focus it and press an arrow key) to nudge that one
      8×8 block by a +1 <span data-term="dct">DCT</span> step and watch the ripple hit the
      nine <span data-term="wavelet">wavelet</span> detail subbands. The
      <span data-term="cost">cost</span> is the ripple divided by the texture already there —
      so busy blocks come out cheap.
    </p>
    <div id="mechanism-body" class="mechanism-body" role="region"
         aria-label="Wavelet cost breakdown for the selected block" tabindex="0">
      <p class="text-muted text-xs">No block selected yet — click the cover image above.</p>
    </div>`;

  anchor.parentElement.insertBefore(section, anchor.nextSibling);
  mount = section;

  // Transparent overlay canvas to draw the selected-block outline over the cover.
  const wrap = coverCanvas.parentElement;
  if (wrap) {
    markerCanvas = document.createElement('canvas');
    markerCanvas.id = 'mechanism-marker';
    markerCanvas.className = 'overlay-canvas';
    markerCanvas.setAttribute('aria-hidden', 'true');
    wrap.appendChild(markerCanvas);
  }
  return mount;
}

function drawMarker(): void {
  if (!markerCanvas || !state.decoded) return;
  const W = state.decoded.width, H = state.decoded.height;
  markerCanvas.width = W;
  markerCanvas.height = H;
  markerCanvas.style.width = coverCanvas.clientWidth + 'px';
  markerCanvas.style.height = coverCanvas.clientHeight + 'px';
  const ctx = markerCanvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, W, H);
  if (selRow < 0) return;
  // High-contrast double stroke (dark halo + bright core) so it reads on any
  // image content in either theme — never color alone.
  const x = selCol * 8, y = selRow * 8;
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(0,0,0,0.9)';
  ctx.strokeRect(x - 1, y - 1, 10, 10);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#ffd166';
  ctx.strokeRect(x - 1, y - 1, 10, 10);
}

function classifyCost(cost: number, allCosts: Float64Array[] | null): { word: string; cls: string } {
  if (!allCosts) return { word: '', cls: '' };
  // Rank this block's probed cost against the low-AC cost distribution.
  const samples: number[] = [];
  for (const b of allCosts) {
    const c = b[1];
    if (isFinite(c) && c < 1e7) samples.push(c);
  }
  if (samples.length === 0) return { word: '', cls: '' };
  samples.sort((a, b) => a - b);
  let lo = 0, hi = samples.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (samples[m] < cost) lo = m + 1; else hi = m; }
  const pct = lo / samples.length;
  if (pct < 0.33) return { word: 'CHEAP — hides in texture', cls: 'cheap' };
  if (pct < 0.66) return { word: 'MODERATE', cls: 'moderate' };
  return { word: 'COSTLY — would stand out', cls: 'costly' };
}

function render(probe: BlockProbe): void {
  const body = document.getElementById('mechanism-body');
  if (!body) return;

  const maxContribution = Math.max(...probe.subbands.map(s => s.contribution), 1e-12);
  const { word, cls } = classifyCost(probe.totalCost, state.costs);

  let rows = '';
  for (const s of probe.subbands) {
    const w = Math.max(1, (s.contribution / maxContribution) * 100);
    rows += `<tr>
      <th scope="row" class="mech-band">${s.name}</th>
      <td class="mech-num">${fmt(s.deltaSum)}</td>
      <td class="mech-num">${fmt(s.coverMag)}</td>
      <td class="mech-bar-cell">
        <span class="mech-bar" style="width:${w}%"></span>
        <span class="mech-num mech-contrib">${fmt(s.contribution)}</span>
      </td>
    </tr>`;
  }

  body.innerHTML = `
    <div class="mech-verdict">
      <span class="mech-block-id">Block (row ${selRow}, col ${selCol})</span>
      <span class="mech-cost-badge mech-${cls}">cost ${fmt(probe.totalCost)}${word ? ' · ' + word : ''}</span>
    </div>
    <p class="text-muted text-xs mech-formula">
      For each subband the cost adds <strong>|ripple| ÷ (|cover texture| + σ)</strong>. A big
      "cover texture" denominator (busy block) shrinks the contribution → low cost. Change tested:
      +1 step of ${probe.q} in the first <span data-term="ac">AC</span> mode.
    </p>
    <table class="mech-table">
      <caption class="sr-only">Per-subband wavelet ripple, cover magnitude, and cost contribution</caption>
      <thead>
        <tr>
          <th scope="col">Subband</th>
          <th scope="col">|ripple| ΣΔ</th>
          <th scope="col">|cover| (÷)</th>
          <th scope="col">cost share</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;

  // Newly injected data-term spans need wiring.
  wireGlossary(body);
}

function selectBlock(row: number, col: number): void {
  if (!state.decoded || !state.costs) return;
  const maxRow = state.decoded.lumaBlocksHigh - 1;
  const maxCol = state.decoded.lumaBlocksWide - 1;
  selRow = Math.max(0, Math.min(maxRow, row));
  selCol = Math.max(0, Math.min(maxCol, col));

  const probe = probeBlock(
    state.decoded.lumaPixels, state.decoded.quantTable,
    state.decoded.lumaBlocksWide, state.decoded.lumaBlocksHigh,
    selRow, selCol,
  );
  drawMarker();
  render(probe);
}

function pointerToBlock(e: MouseEvent): void {
  if (!state.decoded) return;
  const rect = coverCanvas.getBoundingClientRect();
  const scaleX = coverCanvas.width / rect.width;
  const scaleY = coverCanvas.height / rect.height;
  const px = (e.clientX - rect.left) * scaleX;
  const py = (e.clientY - rect.top) * scaleY;
  selectBlock(Math.floor(py / 8), Math.floor(px / 8));
}

/** Show the panel after an image + cost map are ready; reset selection. */
export function activateMechanismPanel(): void {
  const m = ensureMount();
  if (!m) return;
  m.classList.remove('hidden');
  selRow = -1; selCol = -1;
  const body = document.getElementById('mechanism-body');
  if (body) body.innerHTML =
    `<p class="text-muted text-xs">No block selected yet — click the cover image above,
     or focus it and press an arrow key.</p>`;
  drawMarker();

  wireGlossary(m);
}

// ─── Wire cover-canvas interaction once ────────────────────────────────────────

coverCanvas.addEventListener('click', (e) => {
  if (state.costs) pointerToBlock(e);
});

// Keyboard access: make the cover canvas focusable and arrow-navigable.
const ARROWS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
coverCanvas.setAttribute('tabindex', '0');
coverCanvas.addEventListener('keydown', (e) => {
  if (!state.costs || !ARROWS.includes(e.key)) return;
  e.preventDefault();
  // First arrow press with no selection yet → start at the top-left block.
  if (selRow < 0) { selectBlock(0, 0); return; }
  switch (e.key) {
    case 'ArrowUp':    selectBlock(selRow - 1, selCol); break;
    case 'ArrowDown':  selectBlock(selRow + 1, selCol); break;
    case 'ArrowLeft':  selectBlock(selRow, selCol - 1); break;
    case 'ArrowRight': selectBlock(selRow, selCol + 1); break;
  }
});
