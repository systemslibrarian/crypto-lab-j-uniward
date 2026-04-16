/**
 * Extractor — J-UNIWARD payload extraction
 *
 * Reverses the Hamming(7,4) syndrome embedding performed by Embedder.ts.
 * Using the same key-derived carrier ordering, reads the syndrome of every
 * group of 7 carriers to recover 3 message bits per group.
 */

import { sha3_256 as sha3 } from 'js-sha3';
import { selectCarriers, countNZAC, type Carrier } from './Embedder.ts';

// Re-import shuffle helper (copy to avoid circular deps)
function keyToSeed(key: string): Uint8Array {
  return new Uint8Array(sha3.arrayBuffer(key));
}

function shuffleIndices(n: number, seedBytes: Uint8Array): Uint32Array {
  const idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;

  const needed = n * 4;
  const blocks = Math.ceil(needed / 32);
  const rngBytes = new Uint8Array(blocks * 32);
  for (let b = 0; b < blocks; b++) {
    const counterBuf = new Uint8Array(seedBytes.length + 4);
    counterBuf.set(seedBytes);
    counterBuf[seedBytes.length]     = (b >> 24) & 0xff;
    counterBuf[seedBytes.length + 1] = (b >> 16) & 0xff;
    counterBuf[seedBytes.length + 2] = (b >>  8) & 0xff;
    counterBuf[seedBytes.length + 3] =  b        & 0xff;
    const h = new Uint8Array(sha3.arrayBuffer(counterBuf));
    rngBytes.set(h, b * 32);
  }

  for (let i = n - 1; i > 0; i--) {
    const off = i * 4;
    const r = (rngBytes[off] | (rngBytes[off+1] << 8) |
               (rngBytes[off+2] << 16) | ((rngBytes[off+3] & 0x7f) << 24));
    const j = r % (i + 1);
    const tmp = idx[i]; idx[i] = idx[j]; idx[j] = tmp;
  }
  return idx;
}

const H_MAT: readonly number[][] = [
  [1, 0, 1, 0, 1, 0, 1],
  [0, 1, 1, 0, 0, 1, 1],
  [0, 0, 0, 1, 1, 1, 1],
];

function syndrome(carriers: number[]): number {
  let s = 0;
  for (let row = 0; row < 3; row++) {
    let bit = 0;
    for (let col = 0; col < 7; col++) {
      bit ^= H_MAT[row][col] & carriers[col];
    }
    s = (s << 1) | (bit & 1);
  }
  return s;
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
 * @param costs       Cost matrix from the SAME cover image (used for carrier selection)
 * @param key         Shared secret key (must match embed key)
 * @param maxBytes    Maximum bytes to extract (e.g., known payload size bound)
 */
export function extract(
  dctCoeffs: Int16Array[],
  quantTable: Uint16Array,
  costs: Float32Array[],
  key: string,
  maxBytes: number = 65536,
): ExtractResult {
  const carriers = selectCarriers(dctCoeffs, quantTable, costs);

  // Use 2× pool to match embed behaviour
  const maxGroupsNeeded = Math.ceil((maxBytes + 4) * 8 / 3);
  const maxCarriersNeeded = maxGroupsNeeded * 7;

  const seed = keyToSeed(`embed:${key}`);
  const pool = carriers.slice(0, Math.min(maxCarriersNeeded * 2, carriers.length));
  const shuffled = shuffleIndices(pool.length, seed);
  const orderedPool = Array.from(shuffled).map(i => pool[i]);
  const usedCarriers = orderedPool.slice(0, maxCarriersNeeded);

  const bits: number[] = [];

  // Read syndromes to extract bits
  const totalGroups = Math.floor(usedCarriers.length / 7);
  for (let g = 0; g < totalGroups; g++) {
    const groupCarriers = usedCarriers.slice(g * 7, g * 7 + 7);
    const lsbs = groupCarriers.map(c => {
      const v = dctCoeffs[c.blockIdx][c.zzIdx];
      return ((v < 0 ? -v : v) & 1);
    });
    const s = syndrome(lsbs);
    // Extract 3 bits from syndrome (MSB first)
    bits.push((s >> 2) & 1, (s >> 1) & 1, s & 1);

    // Once we have at least 32 bits (4-byte header), decode length
    if (bits.length >= 32 && bits.length % 24 === 8) {
      // Try to decode the length prefix after each byte
      const headerBits = bits.slice(0, 32);
      let msgLen = 0;
      for (let i = 0; i < 32; i++) msgLen = (msgLen * 2) + headerBits[i];
      if (msgLen > 0 && msgLen <= maxBytes) {
        const totalBitsNeeded = 32 + msgLen * 8;
        if (bits.length >= totalBitsNeeded) {
          // Have enough bits — decode
          return decodeBits(bits, msgLen, usedCarriers.slice(0, (g + 1) * 7).length);
        }
      }
    }
  }

  // Decode whatever we have
  if (bits.length >= 32) {
    const headerBits = bits.slice(0, 32);
    let msgLen = 0;
    for (let i = 0; i < 32; i++) msgLen = (msgLen * 2) + headerBits[i];
    if (msgLen > 0 && msgLen <= maxBytes && bits.length >= 32 + msgLen * 8) {
      return decodeBits(bits, msgLen, usedCarriers.length);
    }
  }

  throw new Error('Extraction failed: no valid payload found. Check key and ensure this is a stego JPEG.');
}

function decodeBits(bits: number[], msgLen: number, carriersRead: number): ExtractResult {
  const msgBits = bits.slice(32, 32 + msgLen * 8);
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

  return { message, bytesRecovered: msgLen, carriersRead };
}
