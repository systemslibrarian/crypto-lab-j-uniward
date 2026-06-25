/**
 * Extractor — J-UNIWARD payload extraction via full STC (h=12, 4096 states)
 *
 * Reverses the STC embedding performed by Embedder.ts.
 * Salt is read from the stego JPEG's sideband (first 16 bytes prepended
 * to the carrier pool as direct LSB, or passed explicitly by the caller).
 */

import { deriveSTCKeys } from '../kdf.ts';
import { stcExtract } from '../stc.ts';
import { derivePermutation } from '../stc-keys.ts';
import { selectCarriers } from './Embedder.ts';

export interface ExtractResult {
  message: string;
  bytesRecovered: number;
  carriersRead: number;
}

/**
 * Extract an embedded message from stego DCT coefficients.
 *
 * The payload byte length is supplied by the caller (carried in the stego JPEG's
 * COM sideband alongside the salt and rate). This lets extraction run in a single
 * pass over exactly `carriersNeeded` carriers — the same carrier set, in the same
 * keyed permutation domain, that embedding used. (An earlier two-pass design read
 * the length from an STC "header" block first, but that derived the permutation
 * over a different, smaller carrier count than embedding, so it never decoded.)
 *
 * @param dctCoeffs   Luma DCT blocks of the stego JPEG
 * @param quantTable  Luma quantization table (zigzag order)
 * @param costs       Cost matrix from the stego image (used for carrier selection)
 * @param passphrase  Shared secret (must match embed passphrase)
 * @param salt        16-byte salt (read from stego JPEG COM marker)
 * @param rate        Embedding rate used during embed (needed to reconstruct w)
 * @param msgLen      Message byte length (read from the COM sideband)
 * @param maxBytes    Maximum bytes to extract (safety bound)
 */
export async function extract(
  dctCoeffs: Int16Array[],
  quantTable: Uint16Array,
  costs: Float64Array[],
  passphrase: string,
  salt: Uint8Array,
  rate: number,
  msgLen: number,
  maxBytes: number = 65536,
): Promise<ExtractResult> {
  const allCarriers = selectCarriers(costs);

  // Derive same keys
  const { hatKey, permKey, macKey } = await deriveSTCKeys(passphrase, salt);

  const STC_H = 12;
  const w = Math.ceil(STC_H / rate);

  if (!Number.isInteger(msgLen) || msgLen <= 0 || msgLen > maxBytes) {
    throw new Error('Extraction failed: invalid payload length from sideband. Ensure this is a valid stego JPEG.');
  }

  // Full payload: 4 bytes length + msgLen bytes + 16 bytes HMAC tag
  const fullM = (4 + msgLen + 16) * 8;
  const mPadded = Math.ceil(fullM / STC_H) * STC_H;
  const numBlocks = mPadded / STC_H;
  const carriersNeeded = numBlocks * w;

  if (carriersNeeded > allCarriers.length) {
    throw new Error(`Extraction failed: payload requires ${carriersNeeded} carriers but only ${allCarriers.length} available.`);
  }

  // Reconstruct the same keyed permutation over the full structural pool, then
  // read the first `carriersNeeded` stego LSBs in permuted order (mirrors embed).
  const perm = await derivePermutation(permKey, allCarriers.length);
  const fullStego = new Uint8Array(carriersNeeded);
  for (let i = 0; i < carriersNeeded; i++) {
    const c = allCarriers[perm[i]];
    fullStego[i] = (Math.abs(dctCoeffs[c.blockIdx][c.zzIdx])) & 1;
  }

  const fullBits = await stcExtract(hatKey, fullStego, mPadded, rate);

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

  // Decode 16-byte HMAC tag
  const macStartBit = 32 + msgLen * 8;
  const macBits = fullBits.subarray(macStartBit, macStartBit + 128);
  const extractedMac = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    let byte = 0;
    for (let b = 0; b < 8; b++) {
      byte = (byte << 1) | (macBits[i * 8 + b] ?? 0);
    }
    extractedMac[i] = byte;
  }

  // Verify HMAC-SHA-256 (truncated to 16 bytes)
  const hmacKey = await crypto.subtle.importKey(
    'raw', macKey as unknown as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const fullMac = new Uint8Array(
    await crypto.subtle.sign('HMAC', hmacKey, bytes as unknown as ArrayBuffer),
  );
  const expectedMac = fullMac.slice(0, 16);

  // Constant-time comparison
  let diff = 0;
  for (let i = 0; i < 16; i++) diff |= extractedMac[i] ^ expectedMac[i];
  if (diff !== 0) {
    throw new Error('Extraction failed: HMAC verification failed. Wrong key or corrupted stego image.');
  }

  const decoder = new TextDecoder('utf-8', { fatal: false });
  const message = decoder.decode(bytes);

  return {
    message,
    bytesRecovered: msgLen,
    carriersRead: carriersNeeded,
  };
}
