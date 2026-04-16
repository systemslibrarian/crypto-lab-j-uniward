/**
 * embed-panel.ts — Panel B embed tab: message input, rate slider, embed action
 */

import { state, resetEmbedState } from '../state/app-state.ts';
import { embed, countNZAC } from '../steg/Embedder.ts';
import { encode, decode } from '../codec/JpegCodec.ts';
import { drawImageOnCanvas, renderDiffMap, showAlert } from './renderers.ts';
import { runAnalysis, renderChangesHeatmap } from '../analysis/StegAnalysis.ts';
import { updateAnalysisPanel } from './analysis-panel.ts';

// ─── DOM refs ────────────────────────────────────────────────────────────────

const embedBtn      = document.getElementById('embed-btn') as HTMLButtonElement;
const downloadBtn   = document.getElementById('download-btn') as HTMLButtonElement;
const rateSlider    = document.getElementById('rate-slider') as HTMLInputElement;
const rateDisplay   = document.getElementById('rate-display')!;
const rateWarning   = document.getElementById('rate-warning')!;
const msgInput      = document.getElementById('msg-input') as HTMLTextAreaElement;
const keyInput      = document.getElementById('key-input') as HTMLInputElement;
const embedStatus   = document.getElementById('embed-status')!;
const postEmbed     = document.getElementById('post-embed')!;
const coverThumb    = document.getElementById('cover-thumb') as HTMLCanvasElement;
const stegoThumb    = document.getElementById('stego-thumb') as HTMLCanvasElement;
const diffCanvas    = document.getElementById('diff-canvas') as HTMLCanvasElement;
const diffLabel     = document.getElementById('diff-label')!;
const charCount     = document.getElementById('char-count')!;
const byteCount     = document.getElementById('byte-count')!;
const capacityWarn  = document.getElementById('capacity-warn')!;
const summaryCard   = document.getElementById('embed-summary')!;
const resetBtn      = document.getElementById('reset-btn') as HTMLButtonElement | null;
const copyMsgBtn    = document.getElementById('copy-extracted') as HTMLButtonElement | null;
const changesCanvas = document.getElementById('changes-canvas') as HTMLCanvasElement;
const analysisSlider = document.getElementById('analysis-payload-slider') as HTMLInputElement;
const analysisDisplay= document.getElementById('analysis-payload-display')!;

// ─── Payload presets ─────────────────────────────────────────────────────────

const presetBtns = document.querySelectorAll<HTMLButtonElement>('.preset-btn');
presetBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const rate = btn.dataset['rate'];
    if (rate) {
      rateSlider.value = rate;
      rateSlider.dispatchEvent(new Event('input'));
    }
    presetBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

// ─── Character / byte counter ────────────────────────────────────────────────

function updateCharCount(): void {
  const text = msgInput.value;
  const bytes = new TextEncoder().encode(text).length;
  charCount.textContent = `${text.length} chars`;
  byteCount.textContent = `${bytes} bytes`;

  // Check capacity
  if (state.decoded && state.costs) {
    const nzac = countNZAC(state.decoded.dctCoeffs);
    const rate = parseFloat(rateSlider.value);
    const cap  = Math.floor((nzac * rate) / 8) - 20; // subtract header + HMAC
    if (bytes > cap) {
      capacityWarn.textContent = `⚠ Message exceeds capacity (${cap} bytes at current rate)`;
      capacityWarn.className = 'alert alert-error';
      capacityWarn.classList.remove('hidden');
    } else if (bytes > cap * 0.8) {
      capacityWarn.textContent = `Approaching capacity limit (${cap} bytes)`;
      capacityWarn.className = 'alert alert-warning';
      capacityWarn.classList.remove('hidden');
    } else {
      capacityWarn.classList.add('hidden');
    }
  }
}

msgInput.addEventListener('input', updateCharCount);

// ─── Rate slider ─────────────────────────────────────────────────────────────

rateSlider.addEventListener('input', () => {
  const v = parseFloat(rateSlider.value);
  rateDisplay.textContent = v.toFixed(2) + ' bpnzac';
  rateWarning.classList.toggle('hidden', v <= 0.3);

  // Sync analysis slider
  analysisSlider.value = rateSlider.value;
  analysisDisplay.textContent = v.toFixed(2) + ' bpnzac';

  // Update preset active states
  presetBtns.forEach(btn => {
    btn.classList.toggle('active', btn.dataset['rate'] === v.toFixed(2));
  });

  updateCharCount();
});

// ─── Embed action ────────────────────────────────────────────────────────────

embedBtn.addEventListener('click', async () => {
  if (!state.decoded || !state.costs || !state.origBuffer) {
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

    const result = await embed(
      state.decoded.dctCoeffs, state.decoded.quantTable,
      state.costs, message, key, rate,
    );

    state.lastEmbedSalt = result.salt;
    state.lastEmbedRate = rate;

    // Encode stego JPEG
    const rawStego = encode(state.decoded, result.modifiedCoeffs, state.origBuffer);

    // Inject COM marker (salt + rate) after SOI
    const rawArr = new Uint8Array(rawStego);
    const comPayload = new Uint8Array(20);
    comPayload.set(result.salt, 0);
    new DataView(comPayload.buffer).setFloat32(16, rate, false);
    const comMarker = new Uint8Array([0xFF, 0xFE, 0x00, 0x16, ...comPayload]);
    const stegoWithCom = new Uint8Array(2 + comMarker.length + rawArr.length - 2);
    stegoWithCom.set(rawArr.subarray(0, 2), 0);
    stegoWithCom.set(comMarker, 2);
    stegoWithCom.set(rawArr.subarray(2), 2 + comMarker.length);

    state.stegoBuffer  = stegoWithCom.buffer;
    state.stegoDecoded = decode(state.stegoBuffer);

    // Round-trip fidelity check
    let mismatch = 0;
    for (let bi = 0; bi < result.modifiedCoeffs.length; bi++) {
      for (let zi = 0; zi < 64; zi++) {
        if (result.modifiedCoeffs[bi][zi] !== state.stegoDecoded.dctCoeffs[bi][zi]) mismatch++;
      }
    }

    const fidelityNote = mismatch === 0
      ? `Round-trip OK — all ${result.changesCount} changes preserved.`
      : `⚠ Round-trip: ${mismatch} unexpected differences.`;

    showAlert(embedStatus,
      `✓ Embedded via STC (Viterbi-optimal, h=12). ${fidelityNote}`,
      'success',
    );

    // Embedding summary card
    const msgBytes = new TextEncoder().encode(message).length;
    summaryCard.classList.remove('hidden');
    summaryCard.innerHTML = `
      <h3 class="summary-title">Embedding Summary</h3>
      <div class="summary-grid">
        <div class="summary-item">
          <span class="summary-label">Payload</span>
          <span class="summary-value">${msgBytes + 20} bytes <span class="text-muted">(${msgBytes} msg + 4 hdr + 16 MAC)</span></span>
        </div>
        <div class="summary-item">
          <span class="summary-label">Actual rate</span>
          <span class="summary-value">${result.actualRate.toFixed(4)} bpnzac</span>
        </div>
        <div class="summary-item">
          <span class="summary-label">Carriers used</span>
          <span class="summary-value">${result.carriersUsed.toLocaleString()} / ${result.nzac.toLocaleString()} NZAC</span>
        </div>
        <div class="summary-item">
          <span class="summary-label">Coefficients changed</span>
          <span class="summary-value">${result.changesCount.toLocaleString()}</span>
        </div>
        <div class="summary-item">
          <span class="summary-label">Total distortion</span>
          <span class="summary-value">${result.totalDistortion.toFixed(2)}</span>
        </div>
        <div class="summary-item">
          <span class="summary-label">Metadata</span>
          <span class="summary-value">Salt + rate in COM marker <span class="text-muted">(demo sideband)</span></span>
        </div>
      </div>
      <p class="summary-note">
        <span class="badge badge-moderate">Demo metadata</span>
        COM markers may not survive all image pipelines. Real-world steganography should
        not rely on JPEG metadata for parameter transmission.
      </p>
    `;

    // Post-embed visual comparison
    postEmbed.classList.remove('hidden');
    drawImageOnCanvas(coverThumb, state.decoded.pixels, state.decoded.width, state.decoded.height);
    drawImageOnCanvas(stegoThumb, state.stegoDecoded.pixels, state.stegoDecoded.width, state.stegoDecoded.height);

    const { avgDiff } = renderDiffMap(
      diffCanvas, state.decoded.pixels, state.stegoDecoded.pixels,
      state.decoded.width, state.decoded.height,
    );
    diffLabel.textContent = avgDiff < 0.5
      ? 'Pixel difference (10× amplified) — Imperceptible to human vision ✓'
      : 'Pixel difference (10× amplified)';

    // Run steganalysis
    try {
      const payloadBytes = new TextEncoder().encode(message).length + 4 + 16;
      state.analysisResult = runAnalysis(
        state.decoded.lumaPixels,
        state.decoded.dctCoeffs,
        result.modifiedCoeffs,
        payloadBytes,
        state.decoded.quantTable,
      );
      updateAnalysisPanel(state.activeMethod);
      renderChangesHeatmap(
        changesCanvas, state.decoded.dctCoeffs, result.modifiedCoeffs,
        state.decoded.lumaBlocksWide, state.decoded.lumaBlocksHigh,
      );
    } catch { /* analysis non-critical */ }

  } catch (err) {
    showAlert(embedStatus, `Embedding failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
  } finally {
    embedBtn.disabled = false;
    embedBtn.textContent = '🔒 Embed';
  }
});

// ─── Download ────────────────────────────────────────────────────────────────

downloadBtn.addEventListener('click', () => {
  if (!state.stegoBuffer) return;
  const blob = new Blob([state.stegoBuffer], { type: 'image/jpeg' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `${state.coverFileName || 'stego'}_stego.jpg`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// ─── Reset session ───────────────────────────────────────────────────────────

resetBtn?.addEventListener('click', () => {
  resetEmbedState();
  msgInput.value = '';
  keyInput.value = '';
  rateSlider.value = '0.10';
  rateSlider.dispatchEvent(new Event('input'));
  embedStatus.classList.add('hidden');
  postEmbed.classList.add('hidden');
  summaryCard.classList.add('hidden');
  capacityWarn.classList.add('hidden');
  updateCharCount();
  updateAnalysisPanel(state.activeMethod);
});

// ─── Copy extracted message ──────────────────────────────────────────────────

copyMsgBtn?.addEventListener('click', () => {
  const output = document.getElementById('extract-output');
  const codeEl = output?.querySelector<HTMLElement>('.extract-msg');
  const text = codeEl?.textContent ?? output?.textContent ?? '';
  if (text) {
    navigator.clipboard.writeText(text);
    copyMsgBtn.textContent = '✓ Copied';
    setTimeout(() => { copyMsgBtn.textContent = '📋 Copy'; }, 1500);
  }
});

// ─── Quick Demo ──────────────────────────────────────────────────────────────

export function prefillForDemo(): void {
  msgInput.value = 'Hello from J-UNIWARD — adaptive steganography in action.';
  keyInput.value = 'demo-key-2024';
  rateSlider.value = '0.10';
  rateSlider.dispatchEvent(new Event('input'));
  updateCharCount();
}
