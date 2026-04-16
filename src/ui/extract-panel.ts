/**
 * extract-panel.ts — Panel B extract tab
 */

import { state } from '../state/app-state.ts';
import { decode, type JpegDecoded } from '../codec/JpegCodec.ts';
import { computeCostMatrix } from '../steg/WaveletCost.ts';
import { extract } from '../steg/Extractor.ts';
import { showAlert } from './renderers.ts';

// ─── DOM refs ────────────────────────────────────────────────────────────────

const embedPane    = document.getElementById('embed-pane')!;
const extractPane  = document.getElementById('extract-pane')!;
const tabEmbed     = document.getElementById('tab-embed') as HTMLButtonElement;
const tabExtract   = document.getElementById('tab-extract') as HTMLButtonElement;
const extractBtn   = document.getElementById('extract-btn') as HTMLButtonElement;
const extractKeyInput   = document.getElementById('extract-key-input') as HTMLInputElement;
const extractFileInput  = document.getElementById('extract-file-input') as HTMLInputElement;
const extractOutput     = document.getElementById('extract-output')!;

// ─── Tab switching ───────────────────────────────────────────────────────────

function activateTab(tab: HTMLButtonElement, pane: HTMLElement): void {
  tabEmbed.classList.remove('active');
  tabEmbed.setAttribute('aria-selected', 'false');
  tabEmbed.tabIndex = -1;
  tabExtract.classList.remove('active');
  tabExtract.setAttribute('aria-selected', 'false');
  tabExtract.tabIndex = -1;
  embedPane.classList.remove('active');
  extractPane.classList.remove('active');

  tab.classList.add('active');
  tab.setAttribute('aria-selected', 'true');
  tab.tabIndex = 0;
  tab.focus();
  pane.classList.add('active');
}

tabEmbed.addEventListener('click', () => activateTab(tabEmbed, embedPane));
tabExtract.addEventListener('click', () => activateTab(tabExtract, extractPane));

// Arrow key navigation
const tabs = [tabEmbed, tabExtract];
tabs.forEach((tab, idx) => {
  tab.addEventListener('keydown', (e: KeyboardEvent) => {
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (idx + 1) % tabs.length;
    if (e.key === 'ArrowLeft'  || e.key === 'ArrowUp')   next = (idx - 1 + tabs.length) % tabs.length;
    if (e.key === 'Home') next = 0;
    if (e.key === 'End')  next = tabs.length - 1;
    if (next >= 0) {
      e.preventDefault();
      activateTab(tabs[next], tabs[next] === tabEmbed ? embedPane : extractPane);
    }
  });
});
tabExtract.tabIndex = -1;

// ─── COM marker reader ──────────────────────────────────────────────────────

function readComSideband(buf: ArrayBuffer): { salt: Uint8Array; rate: number } | null {
  const arr = new Uint8Array(buf);
  if (arr.length < 26 || arr[0] !== 0xFF || arr[1] !== 0xD8) return null;
  if (arr[2] !== 0xFF || arr[3] !== 0xFE) return null;
  const len = (arr[4] << 8) | arr[5];
  if (len !== 22) return null;
  const salt = arr.slice(6, 22);
  const rate = new DataView(arr.buffer, arr.byteOffset + 22, 4).getFloat32(0, false);
  return { salt, rate };
}

// ─── Uploaded stego file ─────────────────────────────────────────────────────

let uploadedDecoded: JpegDecoded | null = null;
let uploadedBuf: ArrayBuffer | null = null;

extractFileInput?.addEventListener('change', async () => {
  const file = extractFileInput.files?.[0];
  if (!file) return;
  try {
    uploadedBuf = await file.arrayBuffer();
    uploadedDecoded = decode(uploadedBuf);
  } catch (err) {
    showAlert(extractOutput, `Failed to load stego JPEG: ${err instanceof Error ? err.message : String(err)}`, 'error');
  }
});

// ─── Extract action ──────────────────────────────────────────────────────────

extractBtn.addEventListener('click', async () => {
  const key = extractKeyInput.value.trim();
  if (!key) { showAlert(extractOutput, 'Key cannot be empty.', 'error'); return; }

  let stegoD: JpegDecoded | null = null;
  let extractSalt: Uint8Array | null = null;
  let extractRate = 0;

  // Prefer active embed result, then uploaded file
  if (state.stegoDecoded && state.lastEmbedSalt) {
    stegoD      = state.stegoDecoded;
    extractSalt = state.lastEmbedSalt;
    extractRate = state.lastEmbedRate;
  } else if (uploadedDecoded) {
    stegoD = uploadedDecoded;
    if (uploadedBuf) {
      const sb = readComSideband(uploadedBuf);
      if (sb) { extractSalt = sb.salt; extractRate = sb.rate; }
    }
  }

  if (!extractSalt && state.stegoBuffer) {
    const sb = readComSideband(state.stegoBuffer);
    if (sb) { extractSalt = sb.salt; extractRate = sb.rate; }
  }

  if (!stegoD) {
    showAlert(extractOutput, 'No stego JPEG loaded. Embed first or upload a stego JPEG.', 'error');
    return;
  }
  if (!extractSalt || extractRate <= 0) {
    showAlert(extractOutput, 'Could not read embedding parameters. Ensure this is a valid stego file.', 'error');
    return;
  }

  try {
    extractBtn.disabled = true;
    extractBtn.innerHTML = '<span class="spinner"></span> Extracting…';

    const bW = stegoD.lumaBlocksWide;
    const bH = stegoD.lumaBlocksHigh;
    const stegoCosts = await computeCostMatrix(stegoD.lumaPixels, stegoD.quantTable, bW, bH);

    const result = await extract(stegoD.dctCoeffs, stegoD.quantTable, stegoCosts, key, extractSalt, extractRate);
    showAlert(extractOutput,
      `✓ Recovered (${result.bytesRecovered} bytes):<br><br><code class="extract-msg">${escapeHtml(result.message)}</code>`,
      'success',
    );
  } catch (err) {
    showAlert(extractOutput, `Extraction failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
  } finally {
    extractBtn.disabled = false;
    extractBtn.textContent = '🔓 Extract';
  }
});

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
