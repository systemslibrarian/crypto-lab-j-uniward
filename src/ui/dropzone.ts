/**
 * dropzone.ts — Cover image upload and sample loading
 */

import { state, resetEmbedState } from '../state/app-state.ts';
import { decode } from '../codec/JpegCodec.ts';
import { computeCostMatrix, renderCostHeatmap } from '../steg/WaveletCost.ts';
import { countNZAC, capacityBytes } from '../steg/Embedder.ts';
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
    postEmbed.classList.add('hidden');

    const nzac = countNZAC(state.decoded.dctCoeffs);

    // Image info
    imageInfo.innerHTML = '';
    const info = document.createElement('div');
    info.className = 'image-info-row';
    info.textContent = `${state.decoded.width} × ${state.decoded.height} px · ${state.decoded.blockCount} luma blocks · ${nzac.toLocaleString()} non-zero ACs`;
    imageInfo.appendChild(info);

    // Capacity table
    capacityTable.innerHTML = `
      <table class="capacity-table">
        <thead><tr><th>Rate</th><th>Capacity</th><th>Risk</th></tr></thead>
        <tbody>
          <tr><td>0.1 bpnzac</td><td>${capacityBytes(nzac, 0.1)} bytes</td>
              <td><span class="badge badge-safe">Safe</span></td></tr>
          <tr><td>0.2 bpnzac</td><td>${capacityBytes(nzac, 0.2)} bytes</td>
              <td><span class="badge badge-moderate">Moderate</span></td></tr>
          <tr><td>0.4 bpnzac</td><td>${capacityBytes(nzac, 0.4)} bytes</td>
              <td><span class="badge badge-risky">Risky</span></td></tr>
        </tbody>
      </table>`;

    // Image suitability indicator
    const avgCost = estimateAvgCost(state.decoded);
    if (avgCost < 50) {
      suitability.innerHTML = '<span class="badge badge-risky">⚠ Poor carrier</span> <span class="text-muted">Flat / smooth image — limited texture for hiding data</span>';
    } else if (avgCost < 200) {
      suitability.innerHTML = '<span class="badge badge-moderate">Moderate carrier</span> <span class="text-muted">Some texture — adequate for small payloads</span>';
    } else {
      suitability.innerHTML = '<span class="badge badge-safe">Good carrier</span> <span class="text-muted">Rich texture — ideal for adaptive embedding</span>';
    }

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

/** Rough estimate of average wavelet cost — used for suitability indicator. */
function estimateAvgCost(dec: NonNullable<typeof state.decoded>): number {
  // Quick proxy: variance of luma pixel intensities
  const px = dec.lumaPixels;
  let sum = 0, sum2 = 0;
  const n = Math.min(px.length, 10000); // sample
  const stride = Math.max(1, Math.floor(px.length / n));
  let count = 0;
  for (let i = 0; i < px.length; i += stride) {
    sum  += px[i];
    sum2 += px[i] * px[i];
    count++;
  }
  const mean = sum / count;
  return (sum2 / count) - mean * mean; // variance as proxy for texture
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
