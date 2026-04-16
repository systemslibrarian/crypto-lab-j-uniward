/**
 * main.ts — J-UNIWARD demo entry point
 *
 * Coordinates:
 *  - Dark/light theme toggle (Part A)
 *  - Panel A: Cover image upload, block info, capacity report
 *  - Panel B: Embed / Extract tabs
 *  - Panel C: Three-way steganalysis comparison
 */

import './style.css';
import * as jpeg from 'jpeg-js';
import { decode, encode, type JpegDecoded } from './codec/JpegCodec.ts';
import { computeCostMatrix, renderCostHeatmap } from './steg/WaveletCost.ts';
import { embed, countNZAC, capacityBytes } from './steg/Embedder.ts';
import { extract } from './steg/Extractor.ts';
import {
  runAnalysis,
  renderChangesHeatmap,
  type StegAnalysisResult,
  type MethodStats,
} from './analysis/StegAnalysis.ts';

// Expose jpeg-js on window so JpegCodec can use it (codec uses dynamic access
// to avoid a circular dep on the browser-only jpeg-js module).
(window as unknown as Record<string, unknown>)['__jpegJs'] = jpeg;

// ─── Theme toggle (Part A) ────────────────────────────────────────────────────

function applyTheme(theme: string): void {
  document.documentElement.setAttribute('data-theme', theme);
  const btn = document.getElementById('theme-toggle') as HTMLButtonElement;
  if (!btn) return;
  if (theme === 'dark') {
    btn.textContent = '🌙';
    btn.setAttribute('aria-label', 'Switch to light mode');
  } else {
    btn.textContent = '☀️';
    btn.setAttribute('aria-label', 'Switch to dark mode');
  }
}

document.getElementById('theme-toggle')?.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme') ?? 'dark';
  const next = current === 'dark' ? 'light' : 'dark';
  localStorage.setItem('theme', next);
  applyTheme(next);
});

// Initialize from localStorage (anti-flash script already set data-theme,
// but we still need to set button state)
applyTheme(document.documentElement.getAttribute('data-theme') ?? 'dark');

// ─── State ────────────────────────────────────────────────────────────────────

let decoded:       JpegDecoded | null = null;
let costs:         Float32Array[] | null = null;
let origBuffer:    ArrayBuffer | null = null;
let stegoBuffer:   ArrayBuffer | null = null;
let stegoDecoded:  JpegDecoded | null = null;
let analysisResult: StegAnalysisResult | null = null;

// Panel A canvases
const coverCanvas    = document.getElementById('cover-canvas')    as HTMLCanvasElement;
const heatmapCanvas  = document.getElementById('heatmap-canvas')  as HTMLCanvasElement;
const imageInfo      = document.getElementById('image-info')!;
const capacityTable  = document.getElementById('capacity-table')!;

// Panel B
const embedPane    = document.getElementById('embed-pane')!;
const extractPane  = document.getElementById('extract-pane')!;
const tabEmbed     = document.getElementById('tab-embed')   as HTMLButtonElement;
const tabExtract   = document.getElementById('tab-extract') as HTMLButtonElement;
const embedBtn     = document.getElementById('embed-btn')   as HTMLButtonElement;
const downloadBtn  = document.getElementById('download-btn') as HTMLButtonElement;
const extractBtn   = document.getElementById('extract-btn') as HTMLButtonElement;
const rateSlider   = document.getElementById('rate-slider') as HTMLInputElement;
const rateDisplay  = document.getElementById('rate-display')!;
const rateWarning  = document.getElementById('rate-warning')!;
const msgInput     = document.getElementById('msg-input')   as HTMLTextAreaElement;
const keyInput     = document.getElementById('key-input')   as HTMLInputElement;
const extractKeyInput = document.getElementById('extract-key-input') as HTMLInputElement;
const extractFileInput = document.getElementById('extract-file-input') as HTMLInputElement;
const extractOutput = document.getElementById('extract-output')!;
const embedStatus   = document.getElementById('embed-status')!;

// Panel C
const analysisPayloadSlider = document.getElementById('analysis-payload-slider') as HTMLInputElement;
const analysisPayloadDisplay = document.getElementById('analysis-payload-display')!;
const methodTabs = document.querySelectorAll<HTMLButtonElement>('.method-tab');
const statsContainer = document.getElementById('stats-container')!;
const changesCanvas = document.getElementById('changes-canvas') as HTMLCanvasElement;

// ─── Utility ──────────────────────────────────────────────────────────────────

function showAlert(el: HTMLElement, msg: string, type: 'error' | 'success' | 'info' | 'warning' = 'info'): void {
  el.className = `alert alert-${type}`;
  el.textContent = msg;
  el.classList.remove('hidden');
}

function drawImageOnCanvas(canvas: HTMLCanvasElement, imageData: Uint8ClampedArray, w: number, h: number): void {
  canvas.width  = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const imgData = new ImageData(imageData as any, w, h);
  ctx.putImageData(imgData, 0, 0);
}

// ─── Panel A: Cover image ─────────────────────────────────────────────────────

const dropzone = document.getElementById('dropzone') as HTMLElement;
const fileInput = document.getElementById('file-input') as HTMLInputElement;

function setupDropzone(): void {
  dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('dragover'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', e => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    const file = e.dataTransfer?.files[0];
    if (file) loadImage(file);
  });
  // Keyboard: Enter or Space opens file picker
  dropzone.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files?.[0]) loadImage(fileInput.files[0]);
  });
}

async function loadImage(file: File): Promise<void> {
  if (!file.type.includes('jpeg') && !file.name.toLowerCase().endsWith('.jpg') && !file.name.toLowerCase().endsWith('.jpeg')) {
    showAlert(imageInfo, 'Please upload a JPEG (.jpg / .jpeg) file. PNG and WebP are not supported — J-UNIWARD operates in the JPEG DCT domain.', 'error');
    return;
  }

  try {
    showAlert(imageInfo, '⏳ Decoding JPEG and computing wavelet costs…', 'info');
    origBuffer = await file.arrayBuffer();

    // Decode with our codec
    decoded = decode(origBuffer);

    // Display cover image
    drawImageOnCanvas(coverCanvas, decoded.pixels, decoded.width, decoded.height);
    heatmapCanvas.style.display = 'none';

    // Image info
    const nzac = countNZAC(decoded.dctCoeffs);
    imageInfo.innerHTML = '';
    const info = document.createElement('div');
    info.className = 'image-info';
    info.textContent = `${decoded.width} × ${decoded.height} px — ${decoded.blockCount} luma blocks — ${nzac.toLocaleString()} non-zero ACs`;
    imageInfo.appendChild(info);

    // Capacity table
    capacityTable.innerHTML = `
      <table class="capacity-table">
        <thead><tr><th>Rate</th><th>Capacity</th><th>Risk</th></tr></thead>
        <tbody>
          <tr><td>0.1 bpnzac</td><td>${capacityBytes(nzac, 0.1)} bytes</td>
              <td class="rate-safe">Safe</td></tr>
          <tr><td>0.2 bpnzac</td><td>${capacityBytes(nzac, 0.2)} bytes</td>
              <td class="rate-moderate">Moderate</td></tr>
          <tr><td>0.4 bpnzac</td><td>${capacityBytes(nzac, 0.4)} bytes</td>
              <td class="rate-aggressive">⚠ Aggressive</td></tr>
        </tbody>
      </table>`;

    // Compute wavelet costs in a small async timeout to keep UI responsive
    const blocksWide = Math.ceil(decoded.width  / 8);
    const blocksHigh = Math.ceil(decoded.height / 8);
    showAlert(imageInfo, '⏳ Computing J-UNIWARD distortion cost map…', 'info');
    await new Promise(r => setTimeout(r, 10));

    costs = computeCostMatrix(decoded.lumaPixels, decoded.quantTable, blocksWide, blocksHigh);

    imageInfo.lastElementChild?.remove();

    // Enable embed/extract buttons
    embedBtn.disabled   = false;
    downloadBtn.disabled = true;

    showAlert(imageInfo, `Image loaded. Cost map ready. (${file.name}, ${Math.round(file.size/1024)} KB)`, 'success');

    // Show heatmap toggle
    heatmapToggleRow.classList.remove('hidden');

  } catch (err) {
    showAlert(imageInfo, `Error loading JPEG: ${err instanceof Error ? err.message : String(err)}`, 'error');
  }
}

// Heatmap overlay
const heatmapToggleRow  = document.getElementById('heatmap-toggle-row')!;
const heatmapCheckbox   = document.getElementById('heatmap-checkbox') as HTMLInputElement;

heatmapCheckbox.addEventListener('change', () => {
  if (!decoded || !costs) return;
  const bW = Math.ceil(decoded.width  / 8);
  const bH = Math.ceil(decoded.height / 8);
  if (heatmapCheckbox.checked) {
    renderCostHeatmap(heatmapCanvas, costs, decoded.quantTable, bW, bH);
    heatmapCanvas.style.width  = coverCanvas.width  + 'px';
    heatmapCanvas.style.height = coverCanvas.height + 'px';
    heatmapCanvas.style.display = 'block';
  } else {
    heatmapCanvas.style.display = 'none';
  }
});

// ─── Sample image loader ──────────────────────────────────────────────────────

document.getElementById('load-sample')?.addEventListener('click', async () => {
  try {
    const base = (import.meta as unknown as { env: { BASE_URL: string } }).env.BASE_URL;
    const res = await fetch(`${base}assets/sample.jpg`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const file = new File([blob], 'sample.jpg', { type: 'image/jpeg' });
    await loadImage(file);
  } catch (err) {
    showAlert(imageInfo, `Could not load sample: ${err instanceof Error ? err.message : String(err)}`, 'error');
  }
});

// ─── Panel B tabs (accessible: arrow key navigation + ARIA selected) ────────────

function activateTab(tab: HTMLButtonElement, pane: HTMLElement): void {
  // Deactivate both
  tabEmbed.classList.remove('active');
  tabEmbed.setAttribute('aria-selected', 'false');
  tabEmbed.tabIndex = -1;
  tabExtract.classList.remove('active');
  tabExtract.setAttribute('aria-selected', 'false');
  tabExtract.tabIndex = -1;
  embedPane.classList.remove('active');
  extractPane.classList.remove('active');
  // Activate target
  tab.classList.add('active');
  tab.setAttribute('aria-selected', 'true');
  tab.tabIndex = 0;
  tab.focus();
  pane.classList.add('active');
}

tabEmbed.addEventListener('click', () => activateTab(tabEmbed, embedPane));
tabExtract.addEventListener('click', () => activateTab(tabExtract, extractPane));

// Arrow key navigation within tablist
const tabButtons = [tabEmbed, tabExtract];
tabButtons.forEach((tab, idx) => {
  tab.addEventListener('keydown', (e: KeyboardEvent) => {
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (idx + 1) % tabButtons.length;
    if (e.key === 'ArrowLeft'  || e.key === 'ArrowUp')   next = (idx - 1 + tabButtons.length) % tabButtons.length;
    if (e.key === 'Home') next = 0;
    if (e.key === 'End')  next = tabButtons.length - 1;
    if (next >= 0) {
      e.preventDefault();
      const target = tabButtons[next];
      const pane = target === tabEmbed ? embedPane : extractPane;
      activateTab(target, pane);
    }
  });
});
// Set initial tabindex: active tab = 0, inactive = -1
tabExtract.tabIndex = -1;

// Rate slider
rateSlider.addEventListener('input', () => {
  const v = parseFloat(rateSlider.value);
  rateDisplay.textContent = v.toFixed(2) + ' bpnzac';
  if (v > 0.3) {
    rateWarning.classList.remove('hidden');
  } else {
    rateWarning.classList.add('hidden');
  }
  // Sync analysis slider
  analysisPayloadSlider.value = rateSlider.value;
  analysisPayloadDisplay.textContent = v.toFixed(2) + ' bpnzac';
});

// ─── Embed ────────────────────────────────────────────────────────────────────

embedBtn.addEventListener('click', async () => {
  if (!decoded || !costs || !origBuffer) {
    showAlert(embedStatus, 'Please load a JPEG image first.', 'error');
    return;
  }

  const message = msgInput.value.trim();
  const key     = keyInput.value.trim();
  const rate    = parseFloat(rateSlider.value);

  if (!message) { showAlert(embedStatus, 'Message cannot be empty.', 'error'); return; }
  if (!key)     { showAlert(embedStatus, 'Key cannot be empty.', 'error'); return; }

  try {
    embedBtn.disabled = true;
    embedBtn.innerHTML = '<span class="spinner"></span> Embedding…';
    embedStatus.classList.add('hidden');
    await new Promise(r => setTimeout(r, 10));

    const result = embed(decoded.dctCoeffs, decoded.quantTable, costs, message, key, rate);

    stegoBuffer  = encode(decoded, result.modifiedCoeffs, origBuffer);
    stegoDecoded = decode(stegoBuffer);

    // Round-trip fidelity check: compare intended modifications vs re-decoded
    let mismatch = 0;
    for (let bi = 0; bi < result.modifiedCoeffs.length; bi++) {
      for (let zi = 0; zi < 64; zi++) {
        if (result.modifiedCoeffs[bi][zi] !== stegoDecoded.dctCoeffs[bi][zi]) mismatch++;
      }
    }
    const fidelityNote = mismatch === 0
      ? `Round-trip OK (${result.changesCount} coefficient changes, distortion ${result.totalDistortion.toFixed(2)}).`
      : `⚠ Round-trip: ${mismatch} unexpected differences.`;

    showAlert(embedStatus, `✓ Embedded via STC! ${result.carriersUsed} carriers, ${result.changesCount} changes, ${result.actualRate.toFixed(3)} bpnzac. ${fidelityNote}`, 'success');

    downloadBtn.disabled = false;

    // Run steganalysis with the embedded result
    if (decoded.lumaPixels && decoded.dctCoeffs && stegoDecoded) {
      try {
        const payloadBytes = new TextEncoder().encode(message).length + 4;
        analysisResult = runAnalysis(
          decoded.lumaPixels,
          decoded.dctCoeffs,
          result.modifiedCoeffs,
          payloadBytes,
          decoded.quantTable,
        );
        updateAnalysisPanel('juniward');
        // Render change heatmap
        const bW = Math.ceil(decoded.width  / 8);
        const bH = Math.ceil(decoded.height / 8);
        renderChangesHeatmap(changesCanvas, decoded.dctCoeffs, result.modifiedCoeffs, bW, bH);
      } catch (_) { /* analysis non-critical */ }
    }

  } catch (err) {
    showAlert(embedStatus, `Embedding failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
  } finally {
    embedBtn.disabled = false;
    embedBtn.textContent = '🔒 Embed';
  }
});

// ─── Download stego JPEG ──────────────────────────────────────────────────────

downloadBtn.addEventListener('click', () => {
  if (!stegoBuffer) return;
  const blob = new Blob([stegoBuffer], { type: 'image/jpeg' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'stego.jpg';
  a.click();
  URL.revokeObjectURL(url);
});

// ─── Extract ─────────────────────────────────────────────────────────────────

extractFileInput?.addEventListener('change', async () => {
  const file = extractFileInput.files?.[0];
  if (!file) return;
  try {
    const buf = await file.arrayBuffer();
    const d   = decode(buf);
    (extractFileInput as unknown as Record<string, unknown>)['_decoded'] = d;
    (extractFileInput as unknown as Record<string, unknown>)['_buf']     = buf;
  } catch (err) {
    showAlert(extractOutput, `Failed to load stego JPEG: ${err instanceof Error ? err.message : String(err)}`, 'error');
  }
});

extractBtn.addEventListener('click', async () => {
  const key = extractKeyInput.value.trim();
  if (!key) { showAlert(extractOutput, 'Key cannot be empty.', 'error'); return; }

  // Try active stego buffer first, then uploaded file
  let stegoD: JpegDecoded | null = null;
  if (stegoDecoded && decoded && costs) {
    stegoD = stegoDecoded;
  } else {
    const d = (extractFileInput as unknown as Record<string, unknown>)['_decoded'] as JpegDecoded | undefined;
    if (d) stegoD = d;
  }

  if (!stegoD) {
    showAlert(extractOutput, 'No stego JPEG loaded. Embed a message first or upload a stego JPEG above.', 'error');
    return;
  }

  try {
    extractBtn.disabled = true;
    extractBtn.innerHTML = '<span class="spinner"></span> Extracting…';

    // We need cost matrix from the stego image itself
    const bW = Math.ceil(stegoD.width  / 8);
    const bH = Math.ceil(stegoD.height / 8);
    const stegoCosts = computeCostMatrix(stegoD.lumaPixels, stegoD.quantTable, bW, bH);

    const result = extract(stegoD.dctCoeffs, stegoD.quantTable, stegoCosts, key);
    showAlert(extractOutput, `✓ Recovered (${result.bytesRecovered} bytes):\n\n${result.message}`, 'success');
    extractOutput.style.whiteSpace = 'pre-wrap';

  } catch (err) {
    showAlert(extractOutput, `Extraction failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
  } finally {
    extractBtn.disabled = false;
    extractBtn.textContent = '🔓 Extract';
  }
});

// ─── Panel C: Steganalysis ────────────────────────────────────────────────────

analysisPayloadSlider.addEventListener('input', () => {
  const v = parseFloat(analysisPayloadSlider.value);
  analysisPayloadDisplay.textContent = v.toFixed(2) + ' bpnzac';
  rateSlider.value = String(v);
  rateDisplay.textContent = v.toFixed(2) + ' bpnzac';
  if (v > 0.3) rateWarning.classList.remove('hidden');
  else         rateWarning.classList.add('hidden');
});

let activeMethod: 'lsb' | 'f5' | 'juniward' = 'juniward';

methodTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    methodTabs.forEach(t => { t.classList.remove('active'); t.setAttribute('aria-pressed', 'false'); });
    tab.classList.add('active');
    tab.setAttribute('aria-pressed', 'true');
    activeMethod = (tab.dataset['method'] as 'lsb' | 'f5' | 'juniward') ?? 'juniward';
    updateAnalysisPanel(activeMethod);
  });
});

function updateAnalysisPanel(method: 'lsb' | 'f5' | 'juniward'): void {
  if (!analysisResult) {
    statsContainer.innerHTML = '<p style="color: var(--text-secondary); font-size: 0.85rem;">Load an image and embed a message to see steganalysis results.</p>';
    return;
  }

  const stats: MethodStats = analysisResult[method];
  const label = stats.label;
  const labelClass = label === 'Resistant' ? 'resist'
    : label === 'Moderate Risk' ? 'moderate'
    : 'detect';

  const pValDisplay = stats.pValue < 0.001
    ? '< 0.001 (highly detectable)'
    : stats.pValue < 0.05
    ? `${stats.pValue.toFixed(4)} (detectable)`
    : `${stats.pValue.toFixed(4)} (not significant)`;

  statsContainer.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card">
        <h3>Method</h3>
        <div class="stat-value">${stats.name}</div>
      </div>
      <div class="stat-card">
        <h3>Detectability</h3>
        <div class="stat-value ${labelClass}">${label}</div>
      </div>
      <div class="stat-card">
        <h3>Chi-Square Statistic</h3>
        <div class="stat-value">${stats.chiSq.toFixed(2)}</div>
      </div>
      <div class="stat-card">
        <h3>Chi-Square p-value</h3>
        <div class="stat-value">${pValDisplay}</div>
      </div>
      <div class="stat-card">
        <h3>DCT Coefficients Modified</h3>
        <div class="stat-value">${stats.changesCount.toLocaleString()} / ${stats.totalCoeffs.toLocaleString()}</div>
      </div>
    </div>
    <div class="hist-wrap">
      <p style="font-size:0.8rem; color: var(--text-secondary); margin-top: 0.75rem;">DCT Coefficient Histogram (non-DC, ±64 range)</p>
      <canvas id="hist-canvas" class="hist-canvas"></canvas>
    </div>`;

  // Draw histogram
  requestAnimationFrame(() => {
    const histCanvas = document.getElementById('hist-canvas') as HTMLCanvasElement;
    if (!histCanvas) return;
    renderHistogram(histCanvas, stats.dctHist);
  });
}

function renderHistogram(canvas: HTMLCanvasElement, hist: Int32Array): void {
  const W = canvas.offsetWidth || 300;
  const H = 100;
  canvas.width  = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;

  const offset = 128;
  const range  = 64; // ±64
  const barW   = W / (range * 2 + 1);

  const slice  = Array.from(hist.slice(offset - range, offset + range + 1));
  const maxVal = Math.max(...slice, 1);

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg-tertiary').trim();
  ctx.fillRect(0, 0, W, H);

  slice.forEach((v, i) => {
    const h = (v / maxVal) * (H - 4);
    const x = i * barW;
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text-accent').trim();
    ctx.fillRect(x, H - h, Math.max(1, barW - 0.5), h);
  });

  // Zero line
  const zeroX = range * barW;
  ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--error-text').trim();
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(zeroX, 0); ctx.lineTo(zeroX, H); ctx.stroke();
}

// ─── Init ────────────────────────────────────────────────────────────────────

setupDropzone();
embedBtn.disabled  = true;
downloadBtn.disabled = true;
