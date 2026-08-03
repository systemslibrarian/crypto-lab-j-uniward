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

function readComSideband(buf: ArrayBuffer): { salt: Uint8Array; rate: number; msgLen: number } | null {
  const arr = new Uint8Array(buf);
  if (arr.length < 30 || arr[0] !== 0xFF || arr[1] !== 0xD8) return null;
  if (arr[2] !== 0xFF || arr[3] !== 0xFE) return null;
  const len = (arr[4] << 8) | arr[5];
  if (len !== 26) return null; // 2 (length) + 24 (payload)
  const salt = arr.slice(6, 22);
  const dv = new DataView(arr.buffer, arr.byteOffset + 22, 8);
  const rate = dv.getFloat32(0, false);
  const msgLen = dv.getUint32(4, false);
  return { salt, rate, msgLen };
}

// ─── Uploaded stego file ─────────────────────────────────────────────────────

let uploadedDecoded: JpegDecoded | null = null;
let uploadedBuf: ArrayBuffer | null = null;
let uploadFailed = false;

extractFileInput?.addEventListener('change', async () => {
  const file = extractFileInput.files?.[0];
  if (!file) return;
  // Drop whatever the previous upload left behind first. Otherwise a file that
  // fails to decode leaves the *old* image in `uploadedDecoded` while the new
  // file's bytes sit in `uploadedBuf`, and Extract then runs the new file's
  // sideband parameters against the previous file's coefficients.
  uploadedDecoded = null;
  uploadedBuf = null;
  uploadFailed = false;
  try {
    const buf = await file.arrayBuffer();
    uploadedDecoded = decode(buf);
    uploadedBuf = buf;
  } catch (err) {
    uploadFailed = true;
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
  let extractMsgLen = 0;

  // An explicitly chosen file wins over the in-memory embed result: picking a
  // file is a statement of intent, and silently extracting the last embed
  // instead would answer a question the user did not ask. Each source carries
  // its *own* sideband parameters — they are never mixed across runs.
  if (uploadedDecoded && uploadedBuf) {
    stegoD = uploadedDecoded;
    const sb = readComSideband(uploadedBuf);
    if (sb) { extractSalt = sb.salt; extractRate = sb.rate; extractMsgLen = sb.msgLen; }
  } else if (state.stegoDecoded && state.lastEmbedSalt) {
    stegoD        = state.stegoDecoded;
    extractSalt   = state.lastEmbedSalt;
    extractRate   = state.lastEmbedRate;
    extractMsgLen = state.lastEmbedMsgLen;
  }

  if (!stegoD) {
    showAlert(
      extractOutput,
      uploadFailed
        ? 'That file could not be decoded as a JPEG, so there is nothing to extract from. Upload a valid stego JPEG.'
        : 'No stego JPEG loaded. Embed first or upload a stego JPEG.',
      'error',
    );
    return;
  }
  if (!extractSalt || extractRate <= 0 || extractMsgLen <= 0) {
    showAlert(extractOutput, 'Could not read embedding parameters. Ensure this is a valid stego file.', 'error');
    return;
  }

  try {
    extractBtn.disabled = true;
    extractBtn.innerHTML = '<span class="spinner"></span> Extracting…';

    const bW = stegoD.lumaBlocksWide;
    const bH = stegoD.lumaBlocksHigh;
    const stegoCosts = await computeCostMatrix(stegoD.lumaPixels, stegoD.quantTable, bW, bH);

    const result = await extract(stegoD.dctCoeffs, stegoD.quantTable, stegoCosts, key, extractSalt, extractRate, extractMsgLen);
    showAlert(extractOutput,
      `✓ Recovered (${result.bytesRecovered} bytes):<br><br><code class="extract-msg">${escapeHtml(result.message)}</code>`,
      'success',
    );
  } catch (err) {
    // Extractor errors already carry the "Extraction failed:" prefix; don't
    // stutter it into the banner a second time.
    const cause = (err instanceof Error ? err.message : String(err)).replace(/^Extraction failed:\s*/, '');
    showAlert(extractOutput, `Extraction failed: ${cause}`, 'error');
  } finally {
    extractBtn.disabled = false;
    extractBtn.textContent = '🔓 Extract';
  }
});

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
