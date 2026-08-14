/**
 * stc.ts — Binary block syndrome coding: Viterbi embed + syndrome extract
 *
 * Constraint height h=12 (4096 states). The Viterbi search is exact — it finds
 * the minimum-cost change vector — but only WITHIN each 12-bit block over its own
 * window of w carriers: `fwdCost` is re-initialised per block and the trellis
 * does not carry state across message-bit boundaries. That is the difference from
 * the published syndrome-trellis construction, which slides one small submatrix
 * along a banded parity-check matrix spanning the whole carrier stream.
 *
 * The carriers handed to these functions are already in their final embedding
 * order — the keyed permutation that spreads the payload across the whole image
 * is applied by the caller (Embedder/Extractor) over the full structural carrier
 * pool, so it is identical for embed and extract regardless of cost values.
 *
 * Filler, Judas & Fridrich (2011):
 *   "Minimizing Additive Distortion in Steganography Using Syndrome-Trellis Codes"
 */

import { buildHatMatrix } from './stc-keys.ts';

const H     = 12;
const STATE = 1 << H;  // 4096
const INF   = Number.MAX_VALUE / 2;

// ─── STC Embed ───────────────────────────────────────────────────────────────

export async function stcEmbed(
  hatKey:      Uint8Array,
  coverBits:   Uint8Array,    // LSBs of selected AC carriers (final order), length n
  rho:         Float64Array,  // J-UNIWARD costs, length n — Float64, no exceptions
  messageBits: Uint8Array,
): Promise<{ d: Uint8Array }> {
  const n = coverBits.length;
  const m = messageBits.length;

  // Rate validation
  const rate = m / n;
  if (rate <= 0 || rate >= 0.9)
    throw new RangeError(`Payload rate ${rate.toFixed(4)} outside safe range (0, 0.9)`);

  // Window width
  const w = Math.ceil(H / rate);
  if (w <= H) throw new Error(`w=${w} must be > H=${H}`);

  const hatMatrix = await buildHatMatrix(hatKey, w);
  return stcEmbedWithMatrix(hatMatrix, coverBits, rho, messageBits);
}

/**
 * The Viterbi search proper, over an already-built hat matrix. Split out so the
 * unreachable-syndrome path can be exercised in tests with a deliberately
 * rank-deficient matrix — `buildHatMatrix` rejection-samples non-zero columns,
 * but non-zero does not imply the w columns span GF(2)^12. When they do not,
 * roughly half the syndromes per deficient dimension are unreachable, and the
 * traceback would previously walk default-initialised `fwdFrom`/`fwdFlip`
 * entries and return a change vector that encodes the WRONG message: the stego
 * file would fail HMAC on extraction even with the correct key, silently.
 */
export function stcEmbedWithMatrix(
  hatMatrix:   Uint32Array,
  coverBits:   Uint8Array,
  rho:         Float64Array,
  messageBits: Uint8Array,
): { d: Uint8Array } {
  const n = coverBits.length;
  const m = messageBits.length;
  const w = hatMatrix.length;

  // Number of full blocks
  const numBlocks = Math.floor(m / H);

  // Allocate Viterbi buffers ONCE
  const fwdCost  = new Float64Array(STATE);
  const nextCost = new Float64Array(STATE);
  const fwdFrom  = new Int32Array(STATE * w);
  const fwdFlip  = new Uint8Array(STATE * w);

  // Output change vector (carrier order)
  const d = new Uint8Array(n); // defaults to 0

  for (let b = 0; b < numBlocks; b++) {
    const bStart = b * w;
    const mStart = b * H;

    // Pack target syndrome from message bits
    let target = 0;
    for (let r = 0; r < H; r++) target |= (messageBits[mStart + r] << r);

    // Cover syndrome for this block
    let coverSyn = 0;
    for (let i = 0; i < w; i++) {
      if (coverBits[bStart + i] & 1) coverSyn ^= hatMatrix[i];
    }

    const adjTarget = target ^ coverSyn;

    // Init forward pass
    fwdCost.fill(INF);
    fwdCost[0] = 0;

    for (let i = 0; i < w; i++) {
      nextCost.fill(INF);
      const colBase = i * STATE;
      const cost_i = rho[bStart + i];

      for (let s = 0; s < STATE; s++) {
        if (fwdCost[s] >= INF) continue;

        // No-flip
        if (fwdCost[s] < nextCost[s]) {
          nextCost[s] = fwdCost[s];
          fwdFrom[colBase + s] = s;
          fwdFlip[colBase + s] = 0;
        }

        // Flip
        const ns = s ^ hatMatrix[i];
        const nc = fwdCost[s] + cost_i;
        if (nc < nextCost[ns]) {
          nextCost[ns] = nc;
          fwdFrom[colBase + ns] = s;
          fwdFlip[colBase + ns] = 1;
        }
      }

      // Swap buffers
      fwdCost.set(nextCost);
    }

    // Reachability: if no flip subset of this block's columns produces the
    // target syndrome, its forward cost is still INF and the traceback below
    // would read default (zero) predecessor entries — an arbitrary, wrong
    // change vector. Fail closed instead; a fresh salt draws a fresh matrix.
    if (fwdCost[adjTarget] >= INF) {
      throw new Error(
        `STC embedding failed: block ${b}'s syndrome is unreachable under the keyed ` +
        'parity-check matrix (rank-deficient draw). Re-run the embed — a new salt selects a new matrix.',
      );
    }

    // Traceback from adjTarget
    let state = adjTarget;
    for (let i = w - 1; i >= 0; i--) {
      const colBase = i * STATE;
      const flip = fwdFlip[colBase + state];
      if (flip) d[bStart + i] = 1;
      state = fwdFrom[colBase + state];
    }

    // Postcondition: the stego bits of this block must actually encode the
    // requested 12 message bits. Cheap (O(w)), and it turns any coding bug —
    // this one or a future one — into a visible failure instead of a stego
    // file whose extraction rejects the correct key.
    let stegoSyn = 0;
    for (let i = 0; i < w; i++) {
      if ((coverBits[bStart + i] ^ d[bStart + i]) & 1) stegoSyn ^= hatMatrix[i];
    }
    if (stegoSyn !== target) {
      throw new Error(`STC embedding failed: block ${b} encodes syndrome ${stegoSyn}, expected ${target}.`);
    }
  }

  return { d };
}

// ─── STC Extract ─────────────────────────────────────────────────────────────

export async function stcExtract(
  hatKey:        Uint8Array,
  stegoBits:     Uint8Array,   // LSBs of stego carriers (same final order as embed)
  messageLength: number,
  rate:          number,
): Promise<Uint8Array> {
  const w = Math.ceil(H / rate);
  if (w <= H) throw new Error(`w=${w} must be > H=${H}`);

  const hatMatrix = await buildHatMatrix(hatKey, w);

  const numBlocks = Math.floor(messageLength / H);
  const msg = new Uint8Array(messageLength);

  for (let b = 0; b < numBlocks; b++) {
    const bStart = b * w;
    const mStart = b * H;

    let syn = 0;
    for (let i = 0; i < w; i++) {
      if (stegoBits[bStart + i] & 1) syn ^= hatMatrix[i];
    }

    for (let r = 0; r < H; r++) {
      msg[mStart + r] = (syn >>> r) & 1;
    }
  }

  return msg;
}
