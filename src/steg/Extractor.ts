/**
 * Extractor — J-UNIWARD payload extraction via Syndrome-Trellis Codes
 *
 * Reverses the STC embedding performed by Embedder.ts.
 * Phase 1: Reads the 24-bit sideband header (direct LSB) to recover n
 *          (number of STC carriers).
 * Phase 2: Uses stcExtract on exactly n carriers to recover H · y mod 2 = msg.
 */

import {
  selectCarriers,
  keyToSeed,
  shuffleIndices,
  expandPRNG,
  stcExtract,
} from './Embedder.ts';

/** Constraint height — must match Embedder.ts */
const STC_H = 10;

/** Number of carriers reserved for the sideband n-header */
const HEADER_CARRIERS = 24;

/** Regenerate the same submatrix used during embedding */
function generateSubmatrix(seed: Uint8Array): Uint32Array {
  const cols = STC_H + 1;
  const subH = new Uint32Array(cols);
  const rng = expandPRNG(seed, cols * 4);

  for (let c = 0; c < cols; c++) {
    const off = c * 4;
    const r = rng[off] | (rng[off+1] << 8) | (rng[off+2] << 16) | (rng[off+3] << 24);
    subH[c] = (r & ((1 << STC_H) - 1)) || 1;
  }
  return subH;
}

export interface ExtractResult {
  message: string;
  bytesRecovered: number;
  carriersRead: number;
}

/**
 * Extract an embedded message from stego DCT coefficients.
 *
 * @param dctCoeffs   Luma DCT blocks of the stego JPEG
 * @param quantTable  Luma quantization table (zigzag order)
 * @param costs       Cost matrix from the stego image (used for carrier selection)
 * @param key         Shared secret key (must match embed key)
 * @param maxBytes    Maximum bytes to extract (safety bound)
 */
export function extract(
  dctCoeffs: Int16Array[],
  quantTable: Uint16Array,
  costs: Float32Array[],
  key: string,
  maxBytes: number = 65536,
): ExtractResult {
  const allCarriers = selectCarriers(dctCoeffs, quantTable, costs);

  if (allCarriers.length <= HEADER_CARRIERS) {
    throw new Error('Image too small for extraction.');
  }

  // Reconstruct the same carrier permutation used during embedding
  const seed = keyToSeed(`embed:${key}`);
  const shuffled = shuffleIndices(allCarriers.length, seed);
  const permuted = Array.from(shuffled).map(i => allCarriers[i]);

  // ── Phase 1: Read n from the first HEADER_CARRIERS carriers (direct LSB) ──
  let n = 0;
  for (let i = 0; i < HEADER_CARRIERS; i++) {
    const c = permuted[i];
    const v = dctCoeffs[c.blockIdx][c.zzIdx];
    const bit = (Math.abs(v)) & 1;
    n = (n << 1) | bit;
  }

  if (n <= 0 || n > allCarriers.length - HEADER_CARRIERS) {
    throw new Error('Extraction failed: invalid carrier count in header. Check key and ensure this is a stego JPEG.');
  }

  // ── Phase 2: STC extraction on carriers[HEADER_CARRIERS .. +n) ─────────────
  const stcCarriers = permuted.slice(HEADER_CARRIERS, HEADER_CARRIERS + n);
  const stegoLSBs = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const c = stcCarriers[i];
    const v = dctCoeffs[c.blockIdx][c.zzIdx];
    stegoLSBs[i] = (Math.abs(v)) & 1;
  }

  // Reconstruct the STC submatrix
  const subSeed = keyToSeed(`stc-sub:${key}`);
  const subH = generateSubmatrix(subSeed);

  // The message length m: we need to determine it from the payload header.
  // The payload format is: [4-byte msgLen big-endian] [message bytes]
  // So m = (4 + msgLen) * 8.  But we don't know msgLen yet.
  //
  // Strategy: try to extract just the 32-bit header first.  Since
  // m must divide evenly into the trellis mapping with n carriers,
  // we do a two-pass approach:
  //   Pass 1: extract with m = 32 to get msgLen
  //   Pass 2: extract with m = (4 + msgLen) * 8 to get full payload

  // Pass 1: extract header
  if (n < 32) {
    throw new Error('Extraction failed: not enough carriers for header.');
  }

  // For pass 1, we need the STC to map n carriers → 32 message bits
  const headerBits = stcExtract(stegoLSBs, 32, subH);

  let msgLen = 0;
  for (let i = 0; i < 32; i++) {
    msgLen = (msgLen << 1) | headerBits[i];
  }

  if (msgLen <= 0 || msgLen > maxBytes) {
    throw new Error('Extraction failed: invalid message length. Check key and ensure this is a stego JPEG.');
  }

  // Pass 2: extract full payload with correct m
  const fullM = (4 + msgLen) * 8;
  if (fullM > n) {
    throw new Error(`Extraction failed: payload requires ${fullM} bits but only ${n} carriers.`);
  }

  const fullBits = stcExtract(stegoLSBs, fullM, subH);

  // Verify header consistency
  let verifyLen = 0;
  for (let i = 0; i < 32; i++) {
    verifyLen = (verifyLen << 1) | fullBits[i];
  }
  if (verifyLen !== msgLen) {
    throw new Error('Extraction failed: inconsistent header after full extraction.');
  }

  // Decode message bytes
  const msgBits = fullBits.subarray(32, 32 + msgLen * 8);
  const bytes = new Uint8Array(msgLen);
  for (let i = 0; i < msgLen; i++) {
    let byte = 0;
    for (let b = 0; b < 8; b++) {
      byte = (byte << 1) | (msgBits[i * 8 + b] ?? 0);
    }
    bytes[i] = byte;
  }

  const decoder = new TextDecoder('utf-8', { fatal: false });
  const message = decoder.decode(bytes);

  return {
    message,
    bytesRecovered: msgLen,
    carriersRead: HEADER_CARRIERS + n,
  };
}
