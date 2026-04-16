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
let costs:         Float64Array[] | null = null;
let origBuffer:    ArrayBuffer | null = null;
let stegoBuffer:   ArrayBuffer | null = null;
let stegoDecoded:  JpegDecoded | null = null;
let analysisResult: StegAnalysisResult | null = null;
let lastEmbedSalt: Uint8Array | null = null;
let lastEmbedRate: number = 0.10;

// Panel A canvases
const coverCanvas    = document.getElementById('cover-canvas')    as HTMLCanvasElement;
const heatmapCanvas  = document.getElementById('heatmap-canvas')  as HTMLCanvasElement;
const imageInfo      = document.getElementById('image-info')!;
const capacityTable  = document.getElementById('capacity-table')!;

// Panel B (post-embed elements)
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
const postEmbed     = document.getElementById('post-embed')!;
const coverThumb    = document.getElementById('cover-thumb') as HTMLCanvasElement;
const stegoThumb    = document.getElementById('stego-thumb') as HTMLCanvasElement;
const diffCanvas    = document.getElementById('diff-canvas') as HTMLCanvasElement;
const diffLabel     = document.getElementById('diff-label')!;

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

    // Clear stale post-embed display and analysis from previous embed
    postEmbed.classList.add('hidden');
    analysisResult = null;
    updateAnalysisPanel('juniward');

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
    const blocksWide = decoded.lumaBlocksWide;
    const blocksHigh = decoded.lumaBlocksHigh;
    showAlert(imageInfo, '⏳ Computing J-UNIWARD distortion cost map…', 'info');
    await new Promise(r => setTimeout(r, 10));

    costs = computeCostMatrix(decoded.lumaPixels, decoded.quantTable, blocksWide, blocksHigh);

    imageInfo.lastElementChild?.remove();

    // Enable embed button
    embedBtn.disabled   = false;

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
  const bW = decoded.lumaBlocksWide;
  const bH = decoded.lumaBlocksHigh;
  if (heatmapCheckbox.checked) {
    renderCostHeatmap(heatmapCanvas, costs, decoded.quantTable, bW, bH);
    heatmapCanvas.style.width  = coverCanvas.width  + 'px';
    heatmapCanvas.style.height = coverCanvas.height + 'px';
    heatmapCanvas.style.display = 'block';
  } else {
    heatmapCanvas.style.display = 'none';
  }
});

// ─── Sample image loader (cycling) ────────────────────────────────────────────

const BASE = (import.meta as unknown as { env: { BASE_URL: string } }).env.BASE_URL;
const SAMPLES = [
  { path: `${BASE}samples/sample-grass.jpg`,    label: 'Textured (grass)' },
  { path: `${BASE}samples/sample-smooth.jpg`,   label: 'Smooth (gradient)' },
  { path: `${BASE}samples/sample-portrait.jpg`, label: 'Mixed (geometric)' },
];
let sampleIdx = -1;

const loadSampleBtn = document.getElementById('load-sample') as HTMLButtonElement | null;
loadSampleBtn?.addEventListener('click', async () => {
  sampleIdx = (sampleIdx + 1) % SAMPLES.length;
  const sample = SAMPLES[sampleIdx];
  try {
    const res = await fetch(sample.path);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const file = new File([blob], sample.path.split('/').pop()!, { type: 'image/jpeg' });
    await loadImage(file);

    // Show sample label below image
    let lbl = document.getElementById('sample-label');
    if (!lbl) {
      lbl = document.createElement('div');
      lbl.id = 'sample-label';
      lbl.style.cssText = 'font-size:0.75rem; color:var(--text-secondary); margin-top:0.25rem;';
      coverCanvas.parentElement?.appendChild(lbl);
    }
    lbl.textContent = sample.label;

    // Pre-fill message and rate
    msgInput.value = 'J-UNIWARD embeds here — adaptive, wavelet-guided, undetectable.';
    rateSlider.value = '0.10';
    rateSlider.dispatchEvent(new Event('input'));

    // Update button label
    if (loadSampleBtn) loadSampleBtn.textContent = 'Next Sample →';
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

    const result = await embed(decoded.dctCoeffs, decoded.quantTable, costs, message, key, rate);

    // Store salt and rate for extraction round-trip
    lastEmbedSalt = result.salt;
    lastEmbedRate = rate;

    // Encode stego JPEG
    const rawStego = encode(decoded, result.modifiedCoeffs, origBuffer);

    // Inject COM marker with salt (16 bytes) + rate (4 bytes float32) after SOI
    // COM marker: FF FE [length 2 bytes] [payload]
    // Payload = 16 bytes salt + 4 bytes rate (Float32, big-endian) = 20 bytes
    // Length field = 20 + 2 = 22
    const rawArr = new Uint8Array(rawStego);
    const comPayload = new Uint8Array(20);
    comPayload.set(result.salt, 0);
    new DataView(comPayload.buffer).setFloat32(16, rate, false);
    const comMarker = new Uint8Array([0xFF, 0xFE, 0x00, 0x16, ...comPayload]);
    // Insert after SOI (first 2 bytes: FF D8)
    const stegoWithCom = new Uint8Array(2 + comMarker.length + rawArr.length - 2);
    stegoWithCom.set(rawArr.subarray(0, 2), 0); // SOI
    stegoWithCom.set(comMarker, 2);
    stegoWithCom.set(rawArr.subarray(2), 2 + comMarker.length);

    stegoBuffer  = stegoWithCom.buffer;
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

    // ── Post-embed display (Phase 2) ──────────────────────────────────────
    postEmbed.classList.remove('hidden');

    // Cover thumbnail
    drawImageOnCanvas(coverThumb, decoded.pixels, decoded.width, decoded.height);
    // Stego thumbnail
    drawImageOnCanvas(stegoThumb, stegoDecoded.pixels, stegoDecoded.width, stegoDecoded.height);

    // Difference map (10× amplified)
    {
      const w = decoded.width;
      const h = decoded.height;
      diffCanvas.width = w;
      diffCanvas.height = h;
      const ctx = diffCanvas.getContext('2d')!;
      const imgData = ctx.createImageData(w, h);
      const d = imgData.data;
      const coverPx = decoded.pixels;
      const stegoPx = stegoDecoded.pixels;
      let totalDiff = 0;
      const pixCount = w * h;
      for (let i = 0; i < pixCount; i++) {
        const off = i * 4;
        const dr = Math.abs(coverPx[off] - stegoPx[off]);
        const dg = Math.abs(coverPx[off + 1] - stegoPx[off + 1]);
        const db = Math.abs(coverPx[off + 2] - stegoPx[off + 2]);
        const amp = Math.min(255, ((dr + dg + db) / 3) * 10);
        totalDiff += (dr + dg + db) / 3;
        d[off] = amp;
        d[off + 1] = amp;
        d[off + 2] = amp;
        d[off + 3] = 255;
      }
      ctx.putImageData(imgData, 0, 0);
      const avgDiff = totalDiff / pixCount;
      if (avgDiff < 0.5) {
        diffLabel.textContent = 'Pixel difference (10× amplified) — Imperceptible to human vision ✓';
      } else {
        diffLabel.textContent = 'Pixel difference (10× amplified)';
      }
    }

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
        const bW = decoded.lumaBlocksWide;
        const bH = decoded.lumaBlocksHigh;
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
  a.download = `stego.jpg`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// ─── Extract ─────────────────────────────────────────────────────────────────

/**
 * Read salt (16 bytes) and rate (float32) from COM marker injected after SOI.
 * COM marker format: FF FE 00 16 [16-byte salt] [4-byte float32 rate BE]
 */
function readComSideband(buf: ArrayBuffer): { salt: Uint8Array; rate: number } | null {
  const arr = new Uint8Array(buf);
  // SOI = FF D8, then look for FF FE
  if (arr.length < 26 || arr[0] !== 0xFF || arr[1] !== 0xD8) return null;
  if (arr[2] !== 0xFF || arr[3] !== 0xFE) return null;
  const len = (arr[4] << 8) | arr[5];
  if (len !== 22) return null; // 20 payload + 2 length field
  const salt = arr.slice(6, 22);
  const rate = new DataView(arr.buffer, arr.byteOffset + 22, 4).getFloat32(0, false);
  return { salt, rate };
}

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
  let extractSalt: Uint8Array | null = null;
  let extractRate: number = 0;

  if (stegoDecoded && decoded && costs && lastEmbedSalt) {
    stegoD = stegoDecoded;
    extractSalt = lastEmbedSalt;
    extractRate = lastEmbedRate;
  } else {
    const d = (extractFileInput as unknown as Record<string, unknown>)['_decoded'] as JpegDecoded | undefined;
    const b = (extractFileInput as unknown as Record<string, unknown>)['_buf'] as ArrayBuffer | undefined;
    if (d) stegoD = d;
    if (b) {
      const sideband = readComSideband(b);
      if (sideband) {
        extractSalt = sideband.salt;
        extractRate = sideband.rate;
      }
    }
  }

  // Also try reading COM from stegoBuffer if we have it
  if (!extractSalt && stegoBuffer) {
    const sideband = readComSideband(stegoBuffer);
    if (sideband) {
      extractSalt = sideband.salt;
      extractRate = sideband.rate;
    }
  }

  if (!stegoD) {
    showAlert(extractOutput, 'No stego JPEG loaded. Embed a message first or upload a stego JPEG above.', 'error');
    return;
  }

  if (!extractSalt || extractRate <= 0) {
    showAlert(extractOutput, 'Could not read embedding parameters from stego JPEG. Ensure this is a valid stego file.', 'error');
    return;
  }

  try {
    extractBtn.disabled = true;
    extractBtn.innerHTML = '<span class="spinner"></span> Extracting…';

    // We need cost matrix from the stego image itself
    const bW = stegoD.lumaBlocksWide;
    const bH = stegoD.lumaBlocksHigh;
    const stegoCosts = computeCostMatrix(stegoD.lumaPixels, stegoD.quantTable, bW, bH);

    const result = await extract(stegoD.dctCoeffs, stegoD.quantTable, stegoCosts, key, extractSalt, extractRate);
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
    statsContainer.innerHTML = '<p style="color: var(--text-secondary); font-size: 0.85rem;">Load an image and click Embed to see live steganalysis results. The J-UNIWARD advantage only becomes visible after embedding.</p>';
    return;
  }

  const methods: { key: 'lsb' | 'f5' | 'juniward'; label: string }[] = [
    { key: 'lsb', label: 'LSB' },
    { key: 'f5', label: 'F5' },
    { key: 'juniward', label: 'J-UNIWARD' },
  ];

  // Build chi-square p-value bars for all methods
  let barsHtml = `<div style="margin-bottom:1rem;">
    <h3 style="font-size:0.9rem; margin-bottom:0.5rem;">Chi-square p-value</h3>`;
  for (const m of methods) {
    const stats: MethodStats = analysisResult[m.key];
    const pVal = stats.pValue;
    const barWidth = Math.min(100, pVal * 200); // scale: 0.5 → 100%
    let barColor: string;
    let checkMark = '';
    if (pVal < 0.05) {
      barColor = 'var(--error-text)';
    } else if (pVal < 0.20) {
      barColor = 'var(--warning-text)';
    } else {
      barColor = 'var(--success-color)';
      checkMark = ' ✓';
    }
    const pDisplay = pVal < 0.001 ? '< 0.001' : pVal.toFixed(3);
    barsHtml += `<div style="display:flex; align-items:center; gap:0.5rem; margin-bottom:0.35rem;">
      <span style="width:5.5rem; font-size:0.82rem; color:var(--text-secondary); text-align:right;">${m.label}:</span>
      <div style="flex:1; background:var(--bg-tertiary); border-radius:3px; height:18px; overflow:hidden;">
        <div style="width:${barWidth}%; height:100%; background:${barColor}; border-radius:3px; transition:width 0.3s;"></div>
      </div>
      <span style="font-size:0.82rem; font-weight:600; color:${barColor}; min-width:5rem;">${pDisplay}${checkMark}</span>
    </div>`;
  }
  barsHtml += `<span style="font-size:0.72rem; color:var(--text-secondary);">(higher p-value = harder to detect)</span></div>`;

  // Active method detail card
  const stats: MethodStats = analysisResult[method];
  const label = stats.label;
  const labelClass = label === 'Resistant' ? 'resist'
    : label === 'Moderate Risk' ? 'moderate'
    : 'detect';

  statsContainer.innerHTML = `
    ${barsHtml}
    <div class="stats-grid">
      <div class="stat-card">
        <h3>Active: ${stats.name}</h3>
        <div class="stat-value ${labelClass}">${label}</div>
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
