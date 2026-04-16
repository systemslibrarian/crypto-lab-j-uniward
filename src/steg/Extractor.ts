/**
 * Extractor — J-UNIWARD payload extraction via full STC (h=12, 4096 states)
 *
 * Reverses the STC embedding performed by Embedder.ts.
 * Salt is read from the stego JPEG's sideband (first 16 bytes prepended
 * to the carrier pool as direct LSB, or passed explicitly by the caller).
 */

import { deriveSTCKeys } from '../kdf.ts';
import { stcExtract } from '../stc.ts';
import { selectCarriers } from './Embedder.ts';

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
 * @param passphrase  Shared secret (must match embed passphrase)
 * @param salt        16-byte salt (read from stego JPEG COM marker or sideband)
 * @param rate        Embedding rate used during embed (needed to reconstruct w)
 * @param maxBytes    Maximum bytes to extract (safety bound)
 */
export async function extract(
  dctCoeffs: Int16Array[],
  quantTable: Uint16Array,
  costs: Float64Array[],
  passphrase: string,
  salt: Uint8Array,
  rate: number,
  maxBytes: number = 65536,
): Promise<ExtractResult> {
  const allCarriers = selectCarriers(costs);

  // Derive same keys
  const { hatKey, permKey } = await deriveSTCKeys(passphrase, salt);

  const STC_H = 12;
  const w = Math.ceil(STC_H / rate);

  // We don't know the exact message length yet, so we do two-pass extraction:
  // Pass 1: extract enough bits to read the 4-byte length header (32 bits)
  // We need at least ceil(32/H) * w carriers for the header
  const headerBlocks = Math.ceil(32 / STC_H);
  const headerCarriers = headerBlocks * w;
  const headerMsgBits = headerBlocks * STC_H; // >= 32

  if (allCarriers.length < headerCarriers) {
    throw new Error('Image too small for extraction.');
  }

  // Build stego LSBs for header extraction
  const headerStego = new Uint8Array(headerCarriers);
  for (let i = 0; i < headerCarriers; i++) {
    const c = allCarriers[i];
    headerStego[i] = (Math.abs(dctCoeffs[c.blockIdx][c.zzIdx])) & 1;
  }

  const headerBits = await stcExtract(hatKey, permKey, headerStego, headerMsgBits, rate);

  // Decode 32-bit big-endian message length from first 32 extracted bits
  let msgLen = 0;
  for (let i = 0; i < 32; i++) {
    msgLen = (msgLen << 1) | headerBits[i];
  }

  if (msgLen <= 0 || msgLen > maxBytes) {
    throw new Error('Extraction failed: invalid message length. Check key and ensure this is a stego JPEG.');
  }

  // Full payload: 4 bytes length + msgLen bytes
  const fullM = (4 + msgLen) * 8;
  const mPadded = Math.ceil(fullM / STC_H) * STC_H;
  const numBlocks = mPadded / STC_H;
  const carriersNeeded = numBlocks * w;

  if (carriersNeeded > allCarriers.length) {
    throw new Error(`Extraction failed: payload requires ${carriersNeeded} carriers but only ${allCarriers.length} available.`);
  }

  // Build full stego LSBs
  const fullStego = new Uint8Array(carriersNeeded);
  for (let i = 0; i < carriersNeeded; i++) {
    const c = allCarriers[i];
    fullStego[i] = (Math.abs(dctCoeffs[c.blockIdx][c.zzIdx])) & 1;
  }

  const fullBits = await stcExtract(hatKey, permKey, fullStego, mPadded, rate);

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
    carriersRead: carriersNeeded,
  };
}
