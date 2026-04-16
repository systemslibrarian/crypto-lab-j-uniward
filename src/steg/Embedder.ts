/**
 * Embedder — J-UNIWARD adaptive payload embedding with full STC (h=12, 4096 states)
 *
 * Replaces the former approximation entirely.
 * Uses PBKDF2-SHA-256 (600k) + HKDF key schedule + AES-CTR hat matrix.
 *
 * Filler, Judas & Fridrich (2011):
 *   "Minimizing Additive Distortion in Steganography Using Syndrome-Trellis Codes"
 */

import { deriveSTCKeys } from '../kdf.ts';
import { stcEmbed } from '../stc.ts';

// ─── Coefficient candidate selection ─────────────────────────────────────────

export interface Carrier {
  blockIdx: number;
  zzIdx:    number;  // zigzag index within block (0-63)
  cost:     number;
}

/**
 * Collect all embeddable (non-DC, non-wet) DCT coefficients.
 * DC (zigzag index 0) is NEVER included — assert this.
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
      const q = quantTable[zi];
      if (block[zi] === 0 && q > 4) continue;       // wet: zero + coarse quant
      carriers.push({ blockIdx: bi, zzIdx: zi, cost });
    }
  }

  // Assert: no DC coefficients
  if (carriers.some(c => c.zzIdx === 0)) {
    throw new Error('BUG: DC coefficient (zigzag index 0) in carrier pool');
  }

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
  totalDistortion: number;
  changesCount: number;
  /** 16-byte salt for the KDF — must be stored in stego JPEG for extraction */
  salt: Uint8Array;
}

/**
 * Embed a UTF-8 message into JPEG DCT coefficients using J-UNIWARD cost
 * assignment and full Syndrome-Trellis Code (h=12, 4096 states).
 *
 * @param dctCoeffs   Luma DCT blocks (cloned — originals not modified)
 * @param quantTable  Luma quantization table (zigzag order)
 * @param costs       Per-block cost arrays from computeCostMatrix()
 * @param message     UTF-8 plaintext to embed
 * @param passphrase  Shared secret (enters KDF exactly once)
 * @param rate        Target embedding rate in bpnzac (0.05 – 0.50)
 */
export async function embed(
  dctCoeffs: Int16Array[],
  quantTable: Uint16Array,
  costs: Float32Array[],
  message: string,
  passphrase: string,
  rate: number,
): Promise<EmbedResult> {
  // Rate assertion at call site
  if (rate >= 0.9) throw new RangeError(`Rate ${rate} >= 0.9 is not allowed`);

  const encoder = new TextEncoder();
  const msgBytes = encoder.encode(message);
  // Prepend 4-byte big-endian length
  const payload = new Uint8Array(4 + msgBytes.length);
  const dv = new DataView(payload.buffer);
  dv.setUint32(0, msgBytes.length, false);
  payload.set(msgBytes, 4);

  // Expand payload to bit array
  const payloadBits = new Uint8Array(payload.length * 8);
  for (let i = 0; i < payload.length; i++) {
    for (let b = 7; b >= 0; b--) {
      payloadBits[i * 8 + (7 - b)] = (payload[i] >> b) & 1;
    }
  }

  const nzac = countNZAC(dctCoeffs);
  const allCarriers = selectCarriers(dctCoeffs, quantTable, costs);

  const m = payloadBits.length;
  const STC_H = 12;

  // Pad message bits to next multiple of H for block-based STC
  const mPadded = Math.ceil(m / STC_H) * STC_H;
  const paddedBits = new Uint8Array(mPadded);
  paddedBits.set(payloadBits);

  // Carriers needed: w = ceil(H / rate), blocks = mPadded/H, total = blocks * w
  const w = Math.ceil(STC_H / rate);
  const numBlocks = mPadded / STC_H;
  const carriersNeeded = numBlocks * w;

  if (carriersNeeded > allCarriers.length) {
    throw new Error(
      `Payload too large: need ${carriersNeeded} carriers but only ${allCarriers.length} available. ` +
      `Reduce message size or increase embedding rate.`
    );
  }

  // Derive keys from passphrase
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const { hatKey, permKey } = await deriveSTCKeys(passphrase, salt);

  // Build cover LSBs and cost arrays for selected carriers
  const n = carriersNeeded;
  const coverBits = new Uint8Array(n);
  const rho = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const c = allCarriers[i];
    const v = dctCoeffs[c.blockIdx][c.zzIdx];
    coverBits[i] = (Math.abs(v)) & 1;
    rho[i] = Math.max(c.cost, 1e-10); // floor to avoid zero-cost
  }

  // Run STC Viterbi embedding
  const { d } = await stcEmbed(hatKey, permKey, coverBits, rho, paddedBits);

  // Deep clone DCT blocks and apply changes
  const modified = dctCoeffs.map(b => new Int16Array(b));
  let changesCount = 0;
  let totalDistortion = 0;

  for (let i = 0; i < n; i++) {
    if (d[i]) {
      const c = allCarriers[i];
      const v = modified[c.blockIdx][c.zzIdx];
      // ±1 modification: flip magnitude LSB
      if (v === 0) {
        modified[c.blockIdx][c.zzIdx] = 1;
      } else if (v > 0) {
        modified[c.blockIdx][c.zzIdx] = (v & 1) === 0 ? v + 1 : v - 1;
      } else {
        const mag = -v;
        modified[c.blockIdx][c.zzIdx] = -((mag & 1) === 0 ? mag + 1 : mag - 1);
      }
      changesCount++;
      totalDistortion += rho[i];
    }
  }

  return {
    modifiedCoeffs: modified,
    carriersUsed: n,
    nzac,
    actualRate: m / nzac,
    totalDistortion,
    changesCount,
    salt,
  };
}
