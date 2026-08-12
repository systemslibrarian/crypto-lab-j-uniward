/**
 * dropzone.ts — Cover image upload and sample loading
 */

import { state, resetEmbedState } from '../state/app-state.ts';
import { decode } from '../codec/JpegCodec.ts';
import { computeCostMatrix, renderCostHeatmap } from '../steg/WaveletCost.ts';
import { countNZAC, capacityBytes, ENVELOPE_BYTES } from '../steg/Embedder.ts';
import { drawImageOnCanvas, showAlert } from './renderers.ts';

// ─── DOM refs ────────────────────────────────────────────────────────────────

const dropzone      = document.getElementById('dropzone') as HTMLElement;
const fileInput     = document.getElementById('file-input') as HTMLInputElement;
const coverCanvas   = document.getElementById('cover-canvas') as HTMLCanvasElement;
const heatmapCanvas = document.getElementById('heatmap-canvas') as HTMLCanvasElement;
const imageInfo     = document.getElementById('image-info')!;
const loadProgress  = document.getElementById('image-load-progress')!;
const loadProgressLabel = document.getElementById('image-load-progress-label')!;
const loadProgressDetail = document.getElementById('image-load-progress-detail')!;
const capacityTable = document.getElementById('capacity-table')!;
const heatmapRow    = document.getElementById('heatmap-toggle-row')!;
const heatmapCb     = document.getElementById('heatmap-checkbox') as HTMLInputElement;
const embedBtn      = document.getElementById('embed-btn') as HTMLButtonElement;
const postEmbed     = document.getElementById('post-embed')!;
const embedSummary  = document.getElementById('embed-summary')!;
const embedStatus   = document.getElementById('embed-status')!;
const suitability   = document.getElementById('image-suitability')!;

let isLoadingImage = false;

// ─── Callbacks (set by orchestrator) ──────────────────────────────────────────

let onImageLoaded: (() => void) | null = null;
export function setOnImageLoaded(cb: () => void): void { onImageLoaded = cb; }

function setLoadProgress(step: string, detail: string): void {
  loadProgressLabel.textContent = step;
  loadProgressDetail.textContent = detail;
  loadProgress.classList.remove('hidden');
  dropzone.setAttribute('aria-busy', 'true');
}

function clearLoadProgress(): void {
  loadProgress.classList.add('hidden');
  dropzone.removeAttribute('aria-busy');
}

async function nextPaint(): Promise<void> {
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
}

// ─── Image loading ───────────────────────────────────────────────────────────

export async function loadImage(file: File): Promise<void> {
  if (isLoadingImage) return;

  if (
    !file.type.includes('jpeg') &&
    !file.name.toLowerCase().endsWith('.jpg') &&
    !file.name.toLowerCase().endsWith('.jpeg')
  ) {
    showAlert(imageInfo, 'Please upload a JPEG (.jpg / .jpeg). J-UNIWARD operates in the JPEG DCT domain.', 'error');
    return;
  }

  try {
    isLoadingImage = true;
    embedBtn.disabled = true;
    loadSampleBtn && (loadSampleBtn.disabled = true);
    imageInfo.innerHTML = '';
    suitability.innerHTML = '';
    capacityTable.innerHTML = '';
    heatmapRow.classList.add('hidden');
    setLoadProgress('Loading JPEG…', 'Reading the uploaded image into memory.');
    await nextPaint();

    state.origBuffer    = await file.arrayBuffer();
    state.coverFileName = file.name.replace(/\.[^.]+$/, '');

    setLoadProgress('Decoding JPEG structure…', 'Parsing blocks, coefficients, and quantization tables.');
    await nextPaint();

    state.decoded = decode(state.origBuffer);
    resetEmbedState();

    drawImageOnCanvas(coverCanvas, state.decoded.pixels, state.decoded.width, state.decoded.height);
    heatmapCanvas.classList.add('hidden');

    // Retire everything the *previous* cover's embed produced. The comparison
    // strip used to be the only panel cleared here, leaving the Embedding
    // Summary — payload, carriers, NZAC — quoting an image that is no longer on
    // screen, and the "✓ Embedded" banner still sitting under the button.
    postEmbed.classList.add('hidden');
    embedSummary.classList.add('hidden');
    embedSummary.innerHTML = '';
    embedStatus.classList.add('hidden');
    embedStatus.innerHTML = '';

    const nzac = countNZAC(state.decoded.dctCoeffs);

    // Image info
    imageInfo.innerHTML = '';
    const info = document.createElement('div');
    info.className = 'image-info-row';
    info.textContent = `${state.decoded.width} × ${state.decoded.height} px · ${state.decoded.blockCount} luma blocks · ${nzac.toLocaleString()} non-zero ACs`;
    imageInfo.appendChild(info);

    // Capacity table.
    //
    // The column used to print the raw bpnzac budget while the banner under the
    // message box subtracted the 20-byte envelope from the same figure, so the two
    // surfaces disagreed by exactly 20 bytes — and on the bundled smooth sample
    // (nzac 1,088) the table said "0.1 bpnzac | 13 bytes | Safe" while typing one
    // character said "Message exceeds capacity (-7 bytes)". Print the number the
    // Embed button actually enforces, and never print a negative byte count.
    //
    // The Risk column asserted a security verdict ("Safe" at 0.1 bpnzac) that
    // nothing here computes and that the Limitations panel contradicts. Payload
    // size is what the rate sets; that is what it now says.
    const capRows = [0.1, 0.2, 0.4].map((r) => {
      const usable = capacityBytes(nzac, r) - ENVELOPE_BYTES;
      const cell = usable > 0
        ? `${usable} bytes`
        : `0 bytes <span class="text-muted">(too small for the ${ENVELOPE_BYTES}-byte envelope)</span>`;
      const band = r <= 0.1 ? ['badge-safe', 'Lower payload']
        : r <= 0.2 ? ['badge-moderate', 'Medium payload']
        : ['badge-risky', 'Higher payload'];
      return `<tr><td>${r} bpnzac</td><td>${cell}</td>
              <td><span class="badge ${band[0]}">${band[1]}</span></td></tr>`;
    }).join('');

    capacityTable.innerHTML = `
      <table class="capacity-table">
        <thead><tr><th>Rate</th><th>Message capacity</th><th>Payload</th></tr></thead>
        <tbody>${capRows}</tbody>
      </table>
      <p class="text-muted text-xs">Capacity is after the 4-byte length header and 16-byte MAC.</p>`;

    // Image suitability indicator — see carrierDensityBadge().
    suitability.innerHTML = carrierDensityBadge(nzac, state.decoded.blockCount);

    setLoadProgress(
      'Computing J-UNIWARD distortion cost map…',
      'Running the wavelet-domain cost model. This can take a moment on larger images.',
    );
    await nextPaint();

    const bW = state.decoded.lumaBlocksWide;
    const bH = state.decoded.lumaBlocksHigh;
    state.costs = await computeCostMatrix(
      state.decoded.lumaPixels, state.decoded.quantTable, bW, bH,
      (frac) => {
        loadProgressDetail.textContent =
          `Ranking every DCT coefficient by wavelet distortion cost… ${Math.round(frac * 100)}%`;
      },
    );

    clearLoadProgress();
    embedBtn.disabled = false;

    const doneStatus = document.createElement('div');
    doneStatus.className = 'alert alert-success';
    doneStatus.textContent = `Image loaded. Cost map ready. (${file.name}, ${Math.round(file.size / 1024)} KB)`;
    imageInfo.appendChild(doneStatus);

    heatmapRow.classList.remove('hidden');
    onImageLoaded?.();
  } catch (err) {
    clearLoadProgress();
    showAlert(imageInfo, `Error loading JPEG: ${err instanceof Error ? err.message : String(err)}`, 'error');
  } finally {
    isLoadingImage = false;
    loadSampleBtn && (loadSampleBtn.disabled = false);
  }
}

/**
 * Carrier-density badge.
 *
 * This used to be the variance of the luma pixels, thresholded at 50/200 and
 * captioned "Rich texture — ideal for adaptive embedding". Variance is not
 * texture: a smooth gradient sweeps the whole intensity range and scores high.
 * The bundled `sample-smooth.jpg` — the lab's own "Smooth (sunset gradient)" —
 * measured variance 498 and was therefore labelled a **Good carrier, rich
 * texture, ideal**, while its cost map gives it the lowest non-zero AC count of
 * the three bundled covers (1,088 against 3,501 and 5,185) and a message capacity
 * of **-7 bytes** at the shipped 0.10 bpnzac default. The badge asserted the
 * opposite of what every other number on the page said.
 *
 * Non-zero AC density is the quantity the rest of this lab is actually built on:
 * it is the bpnzac denominator, it is printed beside the badge, and it is what
 * runs out. The band edges (3% / 7%) are a presentation choice calibrated on the
 * bundled covers — smooth 1.7%, grass 5.4%, portrait 8.0% — so the number that
 * drove the verdict is shown next to it rather than hidden behind an adjective.
 */
function carrierDensityBadge(nzac: number, blockCount: number): string {
  const acPool = blockCount * 63;
  const density = acPool > 0 ? nzac / acPool : 0;
  const pct = (density * 100).toFixed(1);
  const evidence = `<span class="text-muted">${nzac.toLocaleString()} of ${acPool.toLocaleString()} `
    + `AC coefficients are non-zero (${pct}%)`;

  if (density < 0.03) {
    return `<span class="badge badge-risky">⚠ Low-texture carrier</span> ${evidence} — `
      + 'little room, and the cheap coefficients run out fast.</span>';
  }
  if (density < 0.07) {
    return `<span class="badge badge-moderate">Moderate-texture carrier</span> ${evidence}.</span>`;
  }
  return `<span class="badge badge-safe">High-texture carrier</span> ${evidence} — `
    + 'more cheap coefficients to spend the payload on.</span>';
}

// ─── Heatmap toggle ──────────────────────────────────────────────────────────

heatmapCb.addEventListener('change', () => {
  if (!state.decoded || !state.costs) return;
  if (heatmapCb.checked) {
    renderCostHeatmap(
      heatmapCanvas, state.costs, state.decoded.quantTable,
      state.decoded.lumaBlocksWide, state.decoded.lumaBlocksHigh,
    );
    heatmapCanvas.style.width  = coverCanvas.width  + 'px';
    heatmapCanvas.style.height = coverCanvas.height + 'px';
    heatmapCanvas.classList.remove('hidden');
  } else {
    heatmapCanvas.classList.add('hidden');
  }
});

// ─── Sample image cycling ────────────────────────────────────────────────────

const BASE = (import.meta as unknown as { env: { BASE_URL: string } }).env.BASE_URL;
const SAMPLES = [
  { path: `${BASE}samples/sample-grass.jpg`,    label: 'Textured (natural green)' },
  { path: `${BASE}samples/sample-smooth.jpg`,   label: 'Smooth (sunset gradient)' },
  { path: `${BASE}samples/sample-portrait.jpg`, label: 'Mixed (geometric shapes)' },
];

const loadSampleBtn = document.getElementById('load-sample') as HTMLButtonElement | null;

export async function loadNextSample(): Promise<boolean> {
  if (isLoadingImage) return false;

  state.sampleIdx = (state.sampleIdx + 1) % SAMPLES.length;
  const sample = SAMPLES[state.sampleIdx];
  try {
    setLoadProgress('Loading sample image…', `Fetching ${sample.label.toLowerCase()} from the bundled demo set.`);
    await nextPaint();

    const res = await fetch(sample.path);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const file = new File([blob], sample.path.split('/').pop()!, { type: 'image/jpeg' });
    await loadImage(file);

    let lbl = document.getElementById('sample-label');
    if (!lbl) {
      lbl = document.createElement('div');
      lbl.id = 'sample-label';
      lbl.className = 'text-muted text-xs';
      coverCanvas.parentElement?.appendChild(lbl);
    }
    lbl.textContent = sample.label;

    if (loadSampleBtn) loadSampleBtn.textContent = 'Next Sample →';
    return true;
  } catch (err) {
    clearLoadProgress();
    showAlert(imageInfo, `Could not load sample: ${err instanceof Error ? err.message : String(err)}`, 'error');
    return false;
  }
}

loadSampleBtn?.addEventListener('click', loadNextSample);

// ─── Dropzone event wiring ───────────────────────────────────────────────────

export function setupDropzone(): void {
  dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('dragover'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', e => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    const file = e.dataTransfer?.files[0];
    if (file) loadImage(file);
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files?.[0]) loadImage(fileInput.files[0]);
  });
}
