/**
 * Embedder — J-UNIWARD adaptive payload embedding with Syndrome-Trellis Codes
 *
 * Implements the full STC framework from Filler, Judas & Fridrich (2011):
 *   "Minimizing Additive Distortion in Steganography Using Syndrome-Trellis Codes"
 *
 * The STC constructs a sparse parity-check matrix H (m × n) by tiling a small
 * random h × (h+1) submatrix along the diagonal.  The Viterbi algorithm
 * traverses the resulting trellis to find the minimum-cost change vector y
 * such that H · y ≡ message (mod 2).  This achieves near-optimal embedding
 * efficiency (close to the rate–distortion bound), typically ~1 bit per
 * carrier at moderate payloads.
 *
 * Constraint height h = 10 (2^h = 1024 trellis states) balances efficiency
 * and runtime for browser execution.
 *
 * The J-UNIWARD cost matrix (Daubechies-8 three-level wavelet decomposition)
 * drives the additive distortion costs.  Wet coefficients (DC, zero-valued
 * with coarse quantization) are excluded from the carrier pool.
 */

import { sha3_256 as sha3 } from 'js-sha3';

// ─── STC parameters ──────────────────────────────────────────────────────────

/** Constraint height — number of rows in the submatrix hat{H}. 2^h states. */
const STC_H = 10;

// ─── PRNG from key (SHA3-256 counter mode) ───────────────────────────────────

export function keyToSeed(key: string): Uint8Array {
  return new Uint8Array(sha3.arrayBuffer(key));
}

/** Expand seed into `count` pseudorandom bytes using SHA3-256 counter mode. */
export function expandPRNG(seedBytes: Uint8Array, count: number): Uint8Array {
  const blocks = Math.ceil(count / 32);
  const out = new Uint8Array(blocks * 32);
  for (let b = 0; b < blocks; b++) {
    const counterBuf = new Uint8Array(seedBytes.length + 4);
    counterBuf.set(seedBytes);
    counterBuf[seedBytes.length]     = (b >> 24) & 0xff;
    counterBuf[seedBytes.length + 1] = (b >> 16) & 0xff;
    counterBuf[seedBytes.length + 2] = (b >>  8) & 0xff;
    counterBuf[seedBytes.length + 3] =  b        & 0xff;
    const h = new Uint8Array(sha3.arrayBuffer(counterBuf));
    out.set(h, b * 32);
  }
  return out.subarray(0, count);
}

/** Deterministic shuffle of indices using Fisher-Yates + key-derived PRNG */
export function shuffleIndices(n: number, seedBytes: Uint8Array): Uint32Array {
  const idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  const rngBytes = expandPRNG(seedBytes, n * 4);

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

// ─── STC submatrix generation ────────────────────────────────────────────────

/**
 * Generate the h × (h+1) random binary submatrix hat{H} from a PRNG seed.
 * Each column is stored as a bitmask (h bits, packed into a uint32).
 * Returns array of (h+1) column bitmasks.
 */
function generateSubmatrix(seed: Uint8Array): Uint32Array {
  const cols = STC_H + 1;
  const subH = new Uint32Array(cols);
  const rng = expandPRNG(seed, cols * 4);

  for (let c = 0; c < cols; c++) {
    const off = c * 4;
    const r = rng[off] | (rng[off+1] << 8) | (rng[off+2] << 16) | (rng[off+3] << 24);
    // Mask to h bits, ensure column is non-zero (at least 1 bit set)
    subH[c] = (r & ((1 << STC_H) - 1)) || 1;
  }
  return subH;
}

// ─── STC Viterbi embedding ───────────────────────────────────────────────────

/**
 * STC embed: find minimum-cost change vector y such that H·y ≡ msg (mod 2).
 *
 * H is an m×n parity-check matrix built by tiling subH along the diagonal.
 * n = number of carriers, m = message bits.
 *
 * Uses the Viterbi algorithm on the trellis with 2^h states.
 *
 * @param coverLSBs  Magnitude-LSBs of the n carrier coefficients (0 or 1)
 * @param costFlip   Cost of flipping each carrier (from J-UNIWARD cost matrix)
 * @param msgBits    Message bits to embed (length m)
 * @param subH       The h × (h+1) submatrix column bitmasks
 * @returns          Array of n stego LSBs (0 or 1)
 */
function stcEmbed(
  coverLSBs: Uint8Array,
  costFlip:  Float64Array,
  msgBits:   Uint8Array,
  subH:      Uint32Array,
): Uint8Array {
  const n = coverLSBs.length;   // number of carriers
  const m = msgBits.length;     // message bits
  const h = STC_H;
  const numStates = 1 << h;
  const stateMask = numStates - 1;
  const colCount = h + 1;       // columns in submatrix

  // Trellis: process one carrier at a time.
  // State = lower h bits of partial syndrome accumulator.
  // For carrier i, the submatrix column index is (i % colCount).
  // After processing carrier i, we've consumed floor((i+1) * m / n) message bits
  // (linear mapping: carrier i covers message bits proportionally).

  // pathCost[state]: cumulative cost to reach this state
  let pathCost = new Float64Array(numStates).fill(Infinity);
  // For backtracking: store the choice (0 or 1) at each step
  const choices = new Uint8Array(n * numStates);

  // Initial state: syndrome accumulator = 0
  pathCost[0] = 0;

  // Track how many message bits have been "consumed" (shifted out of the
  // accumulator) so far.
  let bitsConsumed = 0;

  for (let i = 0; i < n; i++) {
    const colIdx = i % colCount;
    const col = subH[colIdx]; // h-bit column bitmask

    // How many message bits should be consumed after processing carrier i?
    const targetConsumed = Math.floor((i + 1) * m / n);
    const bitsToShift = targetConsumed - bitsConsumed;

    const nextPathCost = new Float64Array(numStates).fill(Infinity);
    const choiceBase = i * numStates;

    // Cost of keeping vs flipping this carrier
    const keepCost = 0;
    const flipCost = costFlip[i];

    for (let s = 0; s < numStates; s++) {
      if (pathCost[s] === Infinity) continue;

      for (let bit = 0; bit <= 1; bit++) {
        // Cost: if bit differs from cover LSB, pay the flip cost
        const cost = pathCost[s] + (bit !== coverLSBs[i] ? flipCost : keepCost);

        // New state: XOR column into accumulator if bit=1
        let newState = s;
        if (bit === 1) newState ^= col;

        // Shift out message bits from the bottom of the accumulator
        // For each bit shifted out, it must match the corresponding message bit
        for (let sh = 0; sh < bitsToShift; sh++) {
          const msgIdx = bitsConsumed + sh;
          const accBit = newState & 1;
          if (accBit !== msgBits[msgIdx]) {
            // Mismatch — this path is invalid
            newState = -1;
            break;
          }
          newState >>= 1;
        }

        if (newState < 0) continue;
        newState &= stateMask;

        if (cost < nextPathCost[newState]) {
          nextPathCost[newState] = cost;
          choices[choiceBase + newState] = bit;
        }
      }
    }

    bitsConsumed = targetConsumed;
    pathCost = nextPathCost;
  }

  // Find the best terminal state (should be 0 if all message bits consumed)
  let bestState = 0;
  let bestCost = pathCost[0];
  for (let s = 1; s < numStates; s++) {
    if (pathCost[s] < bestCost) {
      bestCost = pathCost[s];
      bestState = s;
    }
  }

  // Backtrack to recover the stego LSB sequence
  const stegoLSBs = new Uint8Array(n);
  let state = bestState;

  for (let i = n - 1; i >= 0; i--) {
    const choiceBase = i * numStates;
    const bit = choices[choiceBase + state];
    stegoLSBs[i] = bit;

    // Reverse the forward transition to find the previous state
    // Forward: nextState = (prevState ^ (bit ? col : 0)) >> bitsShifted,
    //          with message bits matched during shift
    // Reverse: reconstruct prevState

    const colIdx = i % colCount;
    const col = subH[colIdx];

    const prevConsumed = Math.floor(i * m / n);
    const curConsumed = Math.floor((i + 1) * m / n);
    const bitsShifted = curConsumed - prevConsumed;

    // Undo shift: prepend the message bits that were shifted out
    let prevState = state;
    for (let sh = bitsShifted - 1; sh >= 0; sh--) {
      const msgIdx = prevConsumed + sh;
      prevState = (prevState << 1) | msgBits[msgIdx];
    }
    prevState &= stateMask;

    // Undo XOR
    if (bit === 1) prevState ^= col;
    prevState &= stateMask;

    state = prevState;
  }

  return stegoLSBs;
}

/**
 * STC extract: compute H · y mod 2 to recover the message.
 *
 * Uses the same tiling scheme as stcEmbed.
 *
 * @param stegoLSBs  Magnitude-LSBs of the n stego carrier coefficients
 * @param m          Number of message bits to extract
 * @param subH       The h × (h+1) submatrix column bitmasks
 * @returns          Extracted message bits (length m)
 */
export function stcExtract(
  stegoLSBs: Uint8Array,
  m: number,
  subH: Uint32Array,
): Uint8Array {
  const n = stegoLSBs.length;
  const h = STC_H;
  const stateMask = (1 << h) - 1;
  const colCount = h + 1;

  const msgBits = new Uint8Array(m);
  let acc = 0;  // h-bit accumulator
  let bitsConsumed = 0;

  for (let i = 0; i < n; i++) {
    const colIdx = i % colCount;
    if (stegoLSBs[i] === 1) {
      acc ^= subH[colIdx];
    }
    acc &= stateMask;

    const targetConsumed = Math.floor((i + 1) * m / n);
    while (bitsConsumed < targetConsumed) {
      msgBits[bitsConsumed] = acc & 1;
      acc >>= 1;
      bitsConsumed++;
    }
  }

  return msgBits;
}

// ─── Coefficient candidate selection ─────────────────────────────────────────

export interface Carrier {
  blockIdx: number;
  zzIdx:    number;  // zigzag index within block (0-63)
  cost:     number;
}

/**
 * Collect all embeddable (non-DC, non-wet) DCT coefficients.
 * Returned in natural block/zigzag order (not sorted by cost — STC uses
 * the cost array directly via Viterbi).
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
}

/**
 * Embed a UTF-8 message into JPEG DCT coefficients using J-UNIWARD cost
 * assignment and Syndrome-Trellis Code (STC) optimal embedding.
 *
 * @param dctCoeffs   Luma DCT blocks (cloned — originals not modified)
 * @param quantTable  Luma quantization table (zigzag order)
 * @param costs       Per-block cost arrays from computeCostMatrix()
 * @param message     UTF-8 plaintext to embed
 * @param key         Shared secret key (drives carrier permutation + submatrix)
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
  const payloadBits = new Uint8Array(payload.length * 8);
  for (let i = 0; i < payload.length; i++) {
    for (let b = 7; b >= 0; b--) {
      payloadBits[i * 8 + (7 - b)] = (payload[i] >> b) & 1;
    }
  }

  const nzac = countNZAC(dctCoeffs);
  const allCarriers = selectCarriers(dctCoeffs, quantTable, costs);

  // Determine how many carriers we need: m message bits, rate = m/n → n = m/rate
  const m = payloadBits.length;

  // Reserve HEADER_CARRIERS (24) carriers for the sideband header that stores n.
  // The STC operates on carriers[HEADER_CARRIERS .. HEADER_CARRIERS + n).
  const HEADER_CARRIERS = 24;

  const stcCarriersAvail = allCarriers.length - HEADER_CARRIERS;
  if (stcCarriersAvail <= 0) {
    throw new Error(`Image too small: need at least ${HEADER_CARRIERS + 1} carriers.`);
  }

  const carriersNeeded = Math.min(
    Math.ceil(m / Math.min(rate, 0.99)),
    stcCarriersAvail,
  );

  if (m > carriersNeeded) {
    throw new Error(
      `Payload too large: ${m} bits needed, but only ${carriersNeeded} carriers available. ` +
      `Reduce message size or increase embedding rate.`
    );
  }

  // Key-based permutation of carriers
  const seed = keyToSeed(`embed:${key}`);
  const shuffled = shuffleIndices(allCarriers.length, seed);
  const permuted = Array.from(shuffled).map(i => allCarriers[i]);

  // Deep clone DCT blocks (don't modify originals)
  const modified = dctCoeffs.map(b => new Int16Array(b));

  // ── Phase 1: Write n into the first HEADER_CARRIERS carriers (direct LSB) ──
  for (let i = 0; i < HEADER_CARRIERS; i++) {
    const c = permuted[i];
    const bit = (carriersNeeded >> (HEADER_CARRIERS - 1 - i)) & 1;
    const v = modified[c.blockIdx][c.zzIdx];
    const curLSB = (Math.abs(v)) & 1;
    if (curLSB !== bit) {
      if (v === 0) {
        modified[c.blockIdx][c.zzIdx] = 1;
      } else if (v > 0) {
        modified[c.blockIdx][c.zzIdx] = (v & 1) === 0 ? v + 1 : v - 1;
      } else {
        const mag = -v;
        modified[c.blockIdx][c.zzIdx] = -((mag & 1) === 0 ? mag + 1 : mag - 1);
      }
    }
  }

  // ── Phase 2: STC embedding on carriers[HEADER_CARRIERS .. +n) ──────────────
  const stcCarriers = permuted.slice(HEADER_CARRIERS, HEADER_CARRIERS + carriersNeeded);

  // Build cover LSB and cost arrays for the STC carriers
  const coverLSBs = new Uint8Array(carriersNeeded);
  const costFlip = new Float64Array(carriersNeeded);
  for (let i = 0; i < carriersNeeded; i++) {
    const c = stcCarriers[i];
    const v = dctCoeffs[c.blockIdx][c.zzIdx];
    coverLSBs[i] = (Math.abs(v)) & 1;
    costFlip[i] = Math.max(c.cost, 1e-10); // floor to avoid zero-cost
  }

  // Generate STC submatrix from key
  const subSeed = keyToSeed(`stc-sub:${key}`);
  const subH = generateSubmatrix(subSeed);

  // Run STC Viterbi embedding
  const stegoLSBs = stcEmbed(coverLSBs, costFlip, payloadBits, subH);

  // Apply STC changes to DCT coefficients
  let changesCount = 0;
  let totalDistortion = 0;

  for (let i = 0; i < carriersNeeded; i++) {
    if (stegoLSBs[i] !== coverLSBs[i]) {
      const c = stcCarriers[i];
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
      totalDistortion += costFlip[i];
    }
  }

  return {
    modifiedCoeffs: modified,
    carriersUsed: carriersNeeded,
    nzac,
    actualRate: m / nzac,
    totalDistortion,
    changesCount,
  };
}
