/**
 * StegAnalysis — Three-way adaptive-placement comparison
 *
 * Compares LSB, F5, and J-UNIWARD at the same payload by asking the question
 * that actually predicts resistance to modern steganalysis:
 *
 *   **Where do the changes land relative to image texture?**
 *
 * J-UNIWARD is designed to minimise a wavelet-domain distortion — concentrating
 * changes in textured, hard-to-model coefficients. LSB and F5 are not. We make
 * that consequence measurable and honest:
 *
 *   - LSB edits are applied in the spatial domain and re-transformed back into
 *     the quantised DCT domain (a real forward DCT), so its footprint is
 *     compared on equal terms — including the DC/flat coefficients it blindly
 *     corrupts.
 *   - Every method's changes are ranked against the J-UNIWARD cost map: the
 *     "exposure" of a change is the percentile of its coefficient's cost (0% =
 *     cheapest / most textured, 100% = costliest / smoothest).
 *
 * We deliberately do NOT report a single chi-square "p-value": first-order
 * histogram tests barely separate DCT-domain methods at low payloads, and would
 * misleadingly rank a method that makes fewer ±1 changes as "safer" regardless
 * of where they land. Placement is the honest, discriminating signal.
 *
 * **What mean exposure does not say.** It is a per-change average, so it is blind
 * to how MANY changes a method made. F5 only ever edits non-zero AC coefficients,
 * and non-zero ACs are exactly the cheap, textured ones — so F5's per-change
 * average beats J-UNIWARD's on covers where J-UNIWARD's carrier pool (every AC,
 * zeros included) forces some spend in flatter blocks, even while F5 makes 2–3×
 * as many changes and leaves a shrinkage tell J-UNIWARD does not. Measured on the
 * three bundled covers, F5's mean exposure is lower than J-UNIWARD's in 13 of 15
 * (cover, rate) states, including the shipped default 0.10 bpnzac on
 * sample-grass (J-UNIWARD 7.1%, F5 4.5%).
 *
 * That is why nothing here or in the panel asserts a winner: the ordering is
 * computed from the run and displayed alongside the change counts and the summed
 * distortion, which is the quantity J-UNIWARD actually minimises.
 */

import { forwardDCTQuantize } from '../codec/JpegCodec.ts';

// ─── LSB embedding (spatial domain) ─────────────────────────────────────────

/**
 * Embed `bitCount` bits into the spatial luma channel using naïve LSB.
 * Returns modified pixel array (copy).
 */
export function lsbEmbed(
  pixels:   Float32Array,
  payload:  Uint8Array,
  bitCount: number,
): { modified: Float32Array; bitsEmbedded: number } {
  const out = new Float32Array(pixels);
  let bi = 0;
  for (let i = 0; i < out.length && bi < bitCount; i++) {
    const byte_idx = Math.floor(bi / 8);
    const bit_pos  = 7 - (bi % 8);
    const bit = (payload[byte_idx] >> bit_pos) & 1;
    const pv = Math.round(Math.max(0, Math.min(255, out[i]))); // clamp to [0,255]
    out[i] = (pv & ~1) | bit;
    bi++;
  }
  return { modified: out, bitsEmbedded: bi };
}

// ─── F5 embedding (sequential DCT with shrinkage) ────────────────────────────

/**
 * F5-like sequential DCT embedding: embed bits into non-zero AC DCT coefficients
 * in sequential order, with ±1 modification. No cost function.
 * Coefficients that reach 0 after modification are "shrunk" (skipped).
 */
export function f5Embed(
  dctCoeffs: Int16Array[],
  payload:   Uint8Array,
  bitCount:  number,
): { modified: Int16Array[]; changesCount: number; bitsEmbedded: number } {
  const modified = dctCoeffs.map(b => new Int16Array(b));
  let bi = 0;
  let changesCount = 0;

  outer:
  for (let blk = 0; blk < modified.length; blk++) {
    const block = modified[blk];
    for (let zi = 1; zi < 64; zi++) { // skip DC
      if (block[zi] === 0) continue; // only non-zero coefficients
      if (bi >= bitCount) break outer;

      const byte_idx = Math.floor(bi / 8);
      const bit_pos  = 7 - (bi % 8);
      const bit = (payload[byte_idx] >> bit_pos) & 1;

      const v = block[zi];
      const lsb = (Math.abs(v)) & 1;
      if (lsb !== bit) {
        // F5: decrement magnitude (shrinkage)
        if (v > 0) block[zi]--;
        else       block[zi]++;
        changesCount++;
        if (block[zi] === 0) continue; // shrinkage: skip this coeff, don't advance bi
      }
      bi++;
    }
  }

  return { modified, changesCount, bitsEmbedded: bi };
}

// ─── DCT histogram analysis ───────────────────────────────────────────────────

/**
 * Compute histogram of DCT coefficient values for all non-DC coefficients.
 * Returns a map from coefficient value → count, over the range [-128..128].
 */
export function dctHistogram(dctCoeffs: Int16Array[]): Int32Array {
  const offset = 128;
  const hist = new Int32Array(257); // index 0..256 → values -128..128
  for (const block of dctCoeffs) {
    for (let zi = 1; zi < 64; zi++) {
      const v = Math.max(-128, Math.min(128, block[zi]));
      hist[v + offset]++;
    }
  }
  return hist;
}

// ─── Cost-percentile ranking ──────────────────────────────────────────────────

const WET = 1e7; // costs at or above this are "wet" (effectively non-embeddable)

/** Sorted list of finite AC costs + a percentile lookup, for ranking changes. */
function buildCostRanker(costs: Float64Array[]): (c: number) => number {
  const flat: number[] = [];
  for (const block of costs) {
    for (let zi = 1; zi < 64; zi++) {
      const c = block[zi];
      if (isFinite(c) && c < WET) flat.push(c);
    }
  }
  flat.sort((a, b) => a - b);
  const n = flat.length || 1;
  return (c: number): number => {
    // fraction of coefficients strictly cheaper than c
    let lo = 0, hi = flat.length;
    while (lo < hi) { const m = (lo + hi) >>> 1; if (flat[m] < c) lo = m + 1; else hi = m; }
    return lo / n;
  };
}

// ─── Per-method placement analysis ────────────────────────────────────────────

/**
 * Compare a method's modified coefficients against the cover and score *where*
 * its changes landed relative to the J-UNIWARD cost map.
 */
/**
 * `structHits` counts DC-term edits and edits to coefficients the cost map marked
 * wet. Only the DC term is ever actually wet here — `WaveletCost` assigns 1e8 to
 * zigzag 0 and a finite computed cost to every AC — so this counter answers
 * exactly one question: *did the method touch the flat-brightness term?* It is
 * NOT a measure of "landed in a flat region", and must not be reported as one:
 * measured across the three bundled covers, 0 of 64,512 AC coefficients per image
 * reach the 1e7 threshold, so for any DCT-domain method (F5, J-UNIWARD) it is
 * structurally pinned at 0. The question it used to be captioned with — did the
 * method put changes in smooth, costly coefficients? — is answered by
 * `topDecileChanges`, which is measured against this image's own cost
 * distribution and therefore can actually fire.
 */
function analysePlacement(
  origCoeffs: Int16Array[],
  modCoeffs:  Int16Array[],
  costs:      Float64Array[],
  rank:       (c: number) => number,
): {
  changesCount: number; structHits: number; meanExposure: number;
  topDecileChanges: number; maxExposure: number; totalDistortion: number;
  changedBlocks: Uint8Array;
} {
  let changesCount = 0; // AC, embeddable
  let structHits   = 0; // DC or wet-coefficient modifications (structurally conspicuous)
  let exposureSum  = 0;
  let topDecileChanges = 0; // AC changes landing in the costliest 10% of this image
  let maxExposure  = 0;
  let totalDistortion = 0;
  const changedBlocks = new Uint8Array(origCoeffs.length); // 0=none, 1=textured change, 2=structural

  for (let bi = 0; bi < origCoeffs.length; bi++) {
    const o = origCoeffs[bi];
    const m = modCoeffs[bi];
    for (let zi = 0; zi < 64; zi++) {
      if (o[zi] === m[zi]) continue;
      if (zi === 0) { structHits++; changedBlocks[bi] = 2; continue; } // DC term — maximally conspicuous
      const c = costs[bi][zi];
      if (!isFinite(c) || c >= WET) { structHits++; if (changedBlocks[bi] !== 2) changedBlocks[bi] = 2; continue; }
      const pct = rank(c);
      exposureSum += pct;
      if (pct >= 0.9) topDecileChanges++;
      if (pct > maxExposure) maxExposure = pct;
      totalDistortion += c;
      changesCount++;
      if (changedBlocks[bi] === 0) changedBlocks[bi] = 1;
    }
  }

  const meanExposure = changesCount > 0 ? exposureSum / changesCount : 0;
  return {
    changesCount, structHits, meanExposure,
    topDecileChanges, maxExposure, totalDistortion, changedBlocks,
  };
}

// ─── Detectability label ──────────────────────────────────────────────────────

export type DetectLabel = 'Resistant' | 'Moderate' | 'Detectable' | 'Negligible';

/**
 * Qualitative rating from placement. Lower exposure (changes hidden in textured
 * coefficients) is stealthier; modifying DC/flat coefficients is a heavy penalty.
 */
export function detectabilityLabel(
  meanExposure: number,
  structHits:   number,
  changesCount: number,
): DetectLabel {
  if (changesCount === 0 && structHits === 0) return 'Negligible';
  let score = meanExposure * 100;
  if (structHits > 0) {
    score += 15 + Math.min(25, (structHits / (changesCount + structHits)) * 100);
  }
  if (score < 12) return 'Resistant';
  if (score < 25) return 'Moderate';
  return 'Detectable';
}

// ─── Placement map: changes drawn over the cost terrain ──────────────────────

const PLACEMENT_AC = [1, 2, 3, 8, 9, 16]; // low-frequency AC zigzag indices for the texture map

/**
 * Render a method's changes on top of the J-UNIWARD cost terrain.
 * Background: blue = low cost (textured) → red = high cost (smooth/flat).
 * Markers: bright dots where the method changed coefficients —
 *   textured changes (type 1) glow cyan/white, structural DC/flat hits (type 2) glow red.
 * The story is immediate: adaptive changes sit in the blue; blind ones scatter into the red.
 */
export function renderPlacementMap(
  canvas:      HTMLCanvasElement,
  costs:       Float64Array[],
  changedBlocks: Uint8Array,
  blocksWide:  number,
  blocksHigh:  number,
): void {
  const W = blocksWide * 8;
  const H = blocksHigh * 8;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(W, H);
  const d = img.data;

  // Per-block average low-AC cost → normalized terrain value.
  const avg = new Float32Array(costs.length);
  let minC = Infinity, maxC = -Infinity;
  for (let bi = 0; bi < costs.length; bi++) {
    let sum = 0, cnt = 0;
    for (const zi of PLACEMENT_AC) {
      const c = costs[bi][zi];
      if (isFinite(c) && c < WET) { sum += c; cnt++; }
    }
    const v = cnt > 0 ? sum / cnt : NaN;
    avg[bi] = v;
    if (isFinite(v)) { if (v < minC) minC = v; if (v > maxC) maxC = v; }
  }
  const range = maxC - minC || 1;

  for (let bi = 0; bi < costs.length; bi++) {
    const bRow = Math.floor(bi / blocksWide);
    const bCol = bi % blocksWide;
    const t = isFinite(avg[bi]) ? Math.min(1, Math.max(0, (avg[bi] - minC) / range)) : 1;
    // terrain: low cost (t≈0) blue → high cost (t≈1) red
    const tr = Math.round(t * 235);
    const tg = Math.round((1 - Math.abs(2 * t - 1)) * 120);
    const tb = Math.round((1 - t) * 235);

    const flag = changedBlocks[bi];
    for (let px = 0; px < 8; px++) {
      for (let py = 0; py < 8; py++) {
        const ii = ((bRow * 8 + px) * W + bCol * 8 + py) * 4;
        if (flag) {
          // bright marker core in the center of the block, terrain elsewhere
          const center = px >= 2 && px <= 5 && py >= 2 && py <= 5;
          if (center && flag === 1) { d[ii] = 180; d[ii + 1] = 255; d[ii + 2] = 245; }
          else if (center && flag === 2) { d[ii] = 255; d[ii + 1] = 70; d[ii + 2] = 90; }
          else { d[ii] = tr; d[ii + 1] = tg; d[ii + 2] = tb; }
        } else {
          d[ii] = tr; d[ii + 1] = tg; d[ii + 2] = tb;
        }
        d[ii + 3] = 255;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

// ─── High-level comparison runner ────────────────────────────────────────────

export interface MethodStats {
  name: string;
  dctHist: Int32Array;
  /** Embeddable AC coefficients changed. */
  changesCount: number;
  /** Non-DC AC coefficients available. */
  totalCoeffs: number;
  /** DC (and wet) coefficients modified — see analysePlacement: in practice, DC only. */
  structHits: number;
  /** Mean cost-percentile of changes (0 = textured/hidden, 1 = smooth/exposed). */
  meanExposure: number;
  /** AC changes landing in the costliest decile of THIS image's cost distribution. */
  topDecileChanges: number;
  /** Highest cost-percentile any single change landed on. */
  maxExposure: number;
  /** Sum of the J-UNIWARD cost of every AC change — the objective itself. */
  totalDistortion: number;
  /** Payload bits this method was asked to carry. */
  bitsRequested: number;
  /**
   * Payload bits it actually carried. F5 runs out of non-zero AC coefficients and
   * LSB runs out of pixels; when this is below `bitsRequested` the method is NOT
   * comparable with the others and the panel must say so.
   */
  bitsEmbedded: number;
  /** Per-block change flag: 0 = none, 1 = textured AC change, 2 = DC/flat (structural) change. */
  changedBlocks: Uint8Array;
  label: DetectLabel;
}

export interface StegAnalysisResult {
  lsb:      MethodStats;
  f5:       MethodStats;
  juniward: MethodStats;
}

/**
 * Run the three-way adaptive-placement comparison.
 *
 * @param origPixels   Spatial luma pixels (for LSB, which edits the spatial domain)
 * @param origCoeffs   Original quantised DCT coefficients
 * @param juniwCoeffs  J-UNIWARD modified coefficients (already embedded)
 * @param payloadBytes Payload size — identical for all three methods
 * @param quantTable   Luma quantisation table
 * @param costs        J-UNIWARD cost map (used to rank where changes land)
 * @param blocksWide   Luma blocks per row (for re-DCT of LSB)
 * @param blocksHigh   Luma block rows
 */
export function runAnalysis(
  origPixels:   Float32Array,
  origCoeffs:   Int16Array[],
  juniwCoeffs:  Int16Array[],
  payloadBytes: number,
  quantTable:   Uint16Array,
  costs:        Float64Array[],
  blocksWide:   number,
  blocksHigh:   number,
): StegAnalysisResult {
  const bitCount = payloadBytes * 8;
  const payload = new Uint8Array(payloadBytes).fill(0xa7); // representative payload
  const rank = buildCostRanker(costs);
  const totalCoeffs = origCoeffs.length * 63; // non-DC ACs

  // ---- LSB: edit spatial pixels, then honestly re-transform to the DCT domain
  const { modified: lsbPixels, bitsEmbedded: lsbBits } = lsbEmbed(origPixels, payload, bitCount);
  const lsbCoeffs = forwardDCTQuantize(lsbPixels, quantTable, blocksWide, blocksHigh);
  const lsbP = analysePlacement(origCoeffs, lsbCoeffs, costs, rank);

  // ---- F5: sequential non-zero AC embedding with shrinkage
  const { modified: f5Coeffs, bitsEmbedded: f5Bits } = f5Embed(origCoeffs, payload, bitCount);
  const f5P = analysePlacement(origCoeffs, f5Coeffs, costs, rank);

  // ---- J-UNIWARD: adaptive STC placement (already embedded)
  const juwP = analysePlacement(origCoeffs, juniwCoeffs, costs, rank);

  return {
    lsb: {
      name: 'LSB (spatial)',
      dctHist: dctHistogram(lsbCoeffs),
      totalCoeffs,
      bitsRequested: bitCount,
      bitsEmbedded: lsbBits,
      ...lsbP,
      label: detectabilityLabel(lsbP.meanExposure, lsbP.structHits, lsbP.changesCount),
    },
    f5: {
      name: 'F5 (DCT sequential)',
      dctHist: dctHistogram(f5Coeffs),
      totalCoeffs,
      bitsRequested: bitCount,
      bitsEmbedded: f5Bits,
      ...f5P,
      label: detectabilityLabel(f5P.meanExposure, f5P.structHits, f5P.changesCount),
    },
    juniward: {
      name: 'J-UNIWARD (adaptive)',
      dctHist: dctHistogram(juniwCoeffs),
      totalCoeffs,
      // The caller only reaches this function after `embed()` returned, and
      // `embed()` refuses rather than truncating — so J-UNIWARD always carried
      // the whole payload. It is the baseline the other two are measured against.
      bitsRequested: bitCount,
      bitsEmbedded: bitCount,
      ...juwP,
      label: detectabilityLabel(juwP.meanExposure, juwP.structHits, juwP.changesCount),
    },
  };
}
