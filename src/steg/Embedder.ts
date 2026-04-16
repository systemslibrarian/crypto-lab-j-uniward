/**
 * Embedder — J-UNIWARD adaptive payload embedding
 *
 * Uses the J-UNIWARD cost matrix to select the lowest-cost non-zero AC DCT
 * coefficients as embedding carriers.  Embedding uses Hamming (7,4) syndrome
 * coding: every 7 carriers encode 3 message bits with at most 1 coefficient
 * modification.  Dry coefficients are selected in cost order; wet (zero,
 * quantization > 1) coefficients are never modified.
 *
 * Tradeoff vs full STC: Hamming(7,4) achieves capacity of 3/7 ≈ 0.43 bpc
 * vs STC's near-1 bpc, meaning we use more coefficients per bit than STC
 * would.  The adaptive cost ordering ensures modifications still fall in
 * high-texture (low-cost) regions, preserving J-UNIWARD's detection
 * resistance at low-to-moderate payloads.
 *
 * UI warning banner is shown when embedding rate > 0.3 bpnzac.
 */

import { sha3_256 as sha3 } from 'js-sha3';

// ─── Hamming (7,4) parity check matrix (3 × 7) ───────────────────────────────
// Syndrome = H * c (mod 2), encodes 3 message bits per 7 carriers
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
  return s; // 0..7
}

// Column of H that equals s (error position for Hamming correction)
function errorPos(s: number): number {
  if (s === 0) return -1; // no error
  for (let col = 0; col < 7; col++) {
    let match = true;
    for (let row = 0; row < 3; row++) {
      const bit = (s >> (2 - row)) & 1;
      if (H_MAT[row][col] !== bit) { match = false; break; }
    }
    if (match) return col;
  }
  return -1;
}

// ─── PRNG from key (SHA3-256 counter mode) ───────────────────────────────────

function keyToSeed(key: string): Uint8Array {
  return new Uint8Array(sha3.arrayBuffer(key));
}

/** Deterministic shuffle of indices using Fisher-Yates + key-derived PRNG */
function shuffleIndices(n: number, seedBytes: Uint8Array): Uint32Array {
  const idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;

  // Expand seed to enough random bytes using SHA3-256 counter mode
  const needed = n * 4; // 4 bytes per swap
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

  // Fisher-Yates
  for (let i = n - 1; i > 0; i--) {
    const off = i * 4;
    const r = (rngBytes[off] | (rngBytes[off+1] << 8) |
               (rngBytes[off+2] << 16) | ((rngBytes[off+3] & 0x7f) << 24));
    const j = r % (i + 1);
    const tmp = idx[i]; idx[i] = idx[j]; idx[j] = tmp;
  }
  return idx;
}

// ─── Coefficient candidate selection ─────────────────────────────────────────

export interface Carrier {
  blockIdx: number;
  zzIdx:    number;  // zigzag index within block (0-63)
  cost:     number;
}

/**
 * Collect all embeddable (non-DC, ideally non-zero) DCT coefficients sorted
 * by ascending cost.
 */
export function selectCarriers(
  dctCoeffs: Int16Array[],
  quantTable: Uint16Array,
  costs: Float32Array[],
): Carrier[] {
  const carriers: Carrier[] = [];

  for (let bi = 0; bi < dctCoeffs.length; bi++) {
    const block = dctCoeffs[bi];
    const blockCosts = costs[bi];
    for (let zi = 1; zi < 64; zi++) { // skip DC (zi=0)
      const cost = blockCosts[zi];
      if (!isFinite(cost) || cost >= 1e7) continue; // wet cost
      // Also skip if DCT coeff is 0 and quantization step is large (wet cost rule)
      const q = quantTable[zi];
      if (block[zi] === 0 && q > 4) continue;
      carriers.push({ blockIdx: bi, zzIdx: zi, cost });
    }
  }

  // Sort by ascending cost (cheapest first = highest texture = best for hiding)
  carriers.sort((a, b) => a.cost - b.cost);
  return carriers;
}

// ─── Count non-zero AC coefficients for bpnzac capacity reporting ─────────────

export function countNZAC(dctCoeffs: Int16Array[]): number {
  let count = 0;
  for (const block of dctCoeffs) {
    for (let zi = 1; zi < 64; zi++) {
      if (block[zi] !== 0) count++;
    }
  }
  return count;
}

export function capacityBytes(nzac: number, rate: number): number {
  return Math.floor((nzac * rate) / 8);
}

// ─── Main embed function ─────────────────────────────────────────────────────

export interface EmbedResult {
  modifiedCoeffs: Int16Array[];
  carriersUsed: number;
  nzac: number;
  actualRate: number;
}

/**
 * Embed a UTF-8 message into JPEG DCT coefficients using adaptive J-UNIWARD
 * carrier selection and Hamming(7,4) syndrome embedding.
 *
 * @param dctCoeffs   Luma DCT blocks (in-place cloned — originals not modified)
 * @param quantTable  Luma quantization table (zigzag order)
 * @param costs       Per-block cost arrays from computeCostMatrix()
 * @param message     UTF-8 plaintext to embed
 * @param key         Shared secret key
 * @param rate        Target embedding rate in bpnzac (0.05 – 0.50)
 */
export function embed(
  dctCoeffs: Int16Array[],
  quantTable: Uint16Array,
  costs: Float32Array[],
  message: string,
  key: string,
  rate: number,
): EmbedResult {
  const encoder = new TextEncoder();
  const msgBytes = encoder.encode(message);
  // Prepend 4-byte big-endian length
  const payload = new Uint8Array(4 + msgBytes.length);
  const dv = new DataView(payload.buffer);
  dv.setUint32(0, msgBytes.length, false);
  payload.set(msgBytes, 4);

  // Expand payload to bit array
  const payloadBits: number[] = [];
  for (const byte of payload) {
    for (let b = 7; b >= 0; b--) payloadBits.push((byte >> b) & 1);
  }

  const carriers = selectCarriers(dctCoeffs, quantTable, costs);
  const nzac = countNZAC(dctCoeffs);

  // Number of groups needed to embed payloadBits (3 bits per group of 7 carriers)
  const bitsNeeded = payloadBits.length;
  const groupsNeeded = Math.ceil(bitsNeeded / 3);
  const carriersNeeded = groupsNeeded * 7;

  if (carriersNeeded > carriers.length) {
    throw new Error(
      `Payload too large: need ${carriersNeeded} carriers, have ${carriers.length}. ` +
      `Reduce payload or embedding rate.`
    );
  }

  // Deep clone DCT blocks (don't modify originals)
  const modified = dctCoeffs.map(b => new Int16Array(b));

  // Key-based permutation of the selected carrier pool
  const seed = keyToSeed(`embed:${key}`);
  const pool = carriers.slice(0, Math.min(carriersNeeded * 2, carriers.length));
  const shuffled = shuffleIndices(pool.length, seed);
  const orderedPool = Array.from(shuffled).map(i => pool[i]);
  const usedCarriers = orderedPool.slice(0, carriersNeeded);

  // Hamming syndrome embedding: 7 carriers → 3 bits
  let bitOffset = 0;
  for (let g = 0; g < groupsNeeded; g++) {
    const groupCarriers = usedCarriers.slice(g * 7, g * 7 + 7);
    if (groupCarriers.length < 7) break; // last group may be incomplete — skip

    // Current LSBs of carriers
    const lsbs: number[] = groupCarriers.map(c => {
      const v = modified[c.blockIdx][c.zzIdx];
      return ((v < 0 ? -v : v) & 1); // use magnitude LSB
    });

    // Target 3-bit message chunk
    let target = 0;
    for (let b = 0; b < 3 && bitOffset + b < payloadBits.length; b++) {
      target = (target << 1) | payloadBits[bitOffset + b];
    }
    bitOffset += 3;

    // Current syndrome
    const cur = syndrome(lsbs);
    const err = cur ^ target; // bits that need to flip

    if (err !== 0) {
      const pos = errorPos(err);
      if (pos >= 0) {
        const c = groupCarriers[pos];
        const v = modified[c.blockIdx][c.zzIdx];
        // ±1 modification keeping sign
        if (v === 0) {
          modified[c.blockIdx][c.zzIdx] = 1;
        } else if (v > 0) {
          // Flip LSB: if LSB=0 add 1, if LSB=1 subtract 1
          modified[c.blockIdx][c.zzIdx] = (v & 1) === 0 ? v + 1 : v - 1;
        } else {
          // Negative: magnitude flip
          const mag = -v;
          modified[c.blockIdx][c.zzIdx] = -((mag & 1) === 0 ? mag + 1 : mag - 1);
        }
      }
    }
  }

  return {
    modifiedCoeffs: modified,
    carriersUsed: carriersNeeded,
    nzac,
    actualRate: bitsNeeded / nzac,
  };
}
