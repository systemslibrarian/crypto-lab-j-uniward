/**
 * WaveletCost — the J-UNIWARD distortion function.
 *
 * Implements the cost function of:
 *   Holub, Fridrich & Denemark, "Universal distortion function for steganography
 *   in an arbitrary domain," EURASIP Journal on Information Security 2014:1
 *   (conference version: Holub & Fridrich, ACM IH&MMSec 2013).
 *   (The WIFS 2012 paper "Designing Steganographic Distortion Using Directional
 *   Filters" is WOW, a different — reciprocal-Hölder — cost function.)
 *
 * ── What the paper specifies (Section 3.1–3.2) ───────────────────────────────
 *
 * A *directional filter bank* is three linear shift-invariant kernels
 *
 *     B = { K⁽¹⁾, K⁽²⁾, K⁽³⁾ },   K⁽¹⁾ = h·gᵀ,  K⁽²⁾ = g·hᵀ,  K⁽³⁾ = g·gᵀ
 *
 * built as outer products of the 1-D wavelet low-pass h and high-pass g decom-
 * position filters. The *directional residuals* are W⁽ᵏ⁾ = K⁽ᵏ⁾ ⋆ X, a
 * MIRROR-PADDED convolution, "so that W⁽ᵏ⁾ has again n₁ × n₂ elements" — i.e.
 * the transform is UNDECIMATED (stationary), and the residuals "coincide with
 * the FIRST-LEVEL undecimated wavelet LH, HL and HH directional decomposition."
 * There is no second or third level, and nothing is downsampled.
 *
 * The distortion is the sum of relative changes of every wavelet coefficient:
 *
 *                3    n₁   n₂   | W⁽ᵏ⁾ᵤᵥ(X) − W⁽ᵏ⁾ᵤᵥ(Y) |
 *     D(X, Y) =  Σ    Σ    Σ    ─────────────────────────      (Eq. 3)
 *               k=1  u=1  v=1     σ + | W⁽ᵏ⁾ᵤᵥ(X) |
 *
 * σ is a stabilizing constant. Section 5.1: "the optimal [σ] for J-UNIWARD is
 * 2⁻⁶, which we selected for all experiments with J-UNIWARD and SI-UNIWARD in
 * this paper." (S-UNIWARD, the spatial-domain variant, uses σ = 1.)
 *
 * J-UNIWARD is the additive approximation of (3) in the JPEG domain: the cost
 * ρ(b, k, l) of changing DCT coefficient (k,l) of block b by one quantization
 * step is D(X, Y) where Y is the cover with q_kl·B_kl added to that one block.
 *
 * ── Wavelet basis ────────────────────────────────────────────────────────────
 *
 * The paper's Table 1 compares nine bases and names them exactly as PyWavelets
 * does — Haar, Daubechies 2/4/8/20, Symlet 8, Coiflet 1, Biorthogonal 4.4/6.8 —
 * citing wavelets.pybytes.com/wavelet/db8/. So "Daubechies 8" means PyWavelets
 * `db8`: 8 vanishing moments, SIXTEEN taps (not an 8-tap filter; the paper's
 * prose calls it "8-tap", but its own Table 1 lists Haar and "Daubechies 2" as
 * distinct rows with very different results, which is only possible under the
 * PyWavelets naming, and "Daubechies 4" is the 8-tap filter).
 *
 * The paper confirms the tap count independently: it notes that a change to one
 * DCT coefficient "affects a block of 8×8 pixels and, consequently, 23×23
 * wavelet coefficients". 23 = 8 + 16 − 1 — the support of an 8-wide change
 * convolved with a 16-tap filter. That arithmetic only works for db8.
 *
 * The coefficients below were derived from the Daubechies construction
 * (spectral factorization of the degree-7 Bezout polynomial, minimum-phase
 * root selection) and verified numerically: Σh = √2, Σh² = 1, ⟨h, h(·+2k)⟩ = 0
 * for k ≠ 0 (max residual 3.1e-16), and 8 vanishing moments (max residual
 * 3.2e-8 absolute, ~1e-16 relative). They match the filter used by the
 * reference J-UNIWARD implementation.
 *
 * ── Deviations from the reference, stated plainly ────────────────────────────
 *
 *  • The DC coefficient is given a wet (infinite) cost so the demo never embeds
 *    there. The reference lets the cost decide.
 *  • The demo embeds with a ternary ±1 operation on quantized coefficients and
 *    does not implement the side-informed (SI-UNIWARD) variant.
 *
 * Everything else is the published definition. {@link computeCostMatrix} is a
 * closed-form evaluation of Eq. 3, not an approximation of it: the test suite
 * checks it against {@link computeCostMatrixSlow}, which perturbs actual pixels
 * and re-runs the transform, and the two agree to ~1e-12 relative — at the
 * image boundary as well as in the interior.
 */

// ─── Daubechies-8 (PyWavelets `db8`) decomposition filters, 16 taps ──────────

const H_LOW = new Float64Array([
   0.05441584224310401,
   0.31287159091429995,
   0.67563073629728980,
   0.58535468365420730,
  -0.01582910525635004,
  -0.28401554296154685,
   0.00047248457391370,
   0.12874742662047797,
  -0.01736930100180724,
  -0.04408825393079483,
   0.01398102791739828,
   0.00874609404740578,
  -0.00487035299345158,
  -0.00039174037337695,
   0.00067544940645057,
  -0.00011747678412477,
]);

const TAPS = H_LOW.length;            // 16
const ANCHOR = (TAPS - 1) >> 1;       // 7 — centring offset for the convolution

// High-pass QMF: g[n] = (−1)ⁿ · h[N−1−n]
const H_HIGH = new Float64Array(TAPS);
for (let n = 0; n < TAPS; n++) {
  H_HIGH[n] = (n % 2 === 0 ? 1 : -1) * H_LOW[TAPS - 1 - n];
}

/**
 * Stabilizing constant σ. The UNIWARD paper, Section 5.1: the optimal value for
 * J-UNIWARD is 2⁻⁶, used for every J-UNIWARD and SI-UNIWARD experiment in the
 * paper. (S-UNIWARD, the spatial variant, uses σ = 1.)
 */
const SIGMA = Math.pow(2, -6);        // 0.015625

/** Wet cost — effectively infinite; the embedder never selects these. */
const WET = 1e8;

// ─── Mirror boundary extension ───────────────────────────────────────────────

/** Reflect an out-of-range index back into [0, n) (whole-sample symmetry). */
function mirror(i: number, n: number): number {
  if (n === 1) return 0;
  const period = 2 * n;
  let m = ((i % period) + period) % period;
  if (m >= n) m = period - 1 - m;
  return m;
}

// ─── First-level UNDECIMATED directional residuals ───────────────────────────

/**
 * The three directional residuals W⁽¹⁾, W⁽²⁾, W⁽³⁾ of the paper, each the same
 * size as the image (undecimated / stationary transform, mirror-padded).
 *
 * K⁽¹⁾ = h·gᵀ (LH), K⁽²⁾ = g·hᵀ (HL), K⁽³⁾ = g·gᵀ (HH), where the LEFT factor
 * runs down the row axis and the RIGHT factor across the column axis:
 *
 *     W[u,v] = Σₐ Σ_b  A[a]·B[b] · X[u+a−ANCHOR, v+b−ANCHOR]
 *
 * which separates into a column pass with B followed by a row pass with A.
 */
export interface DirectionalResiduals {
  LH: Float64Array;   // K⁽¹⁾ = h·gᵀ — low down rows, high across columns
  HL: Float64Array;   // K⁽²⁾ = g·hᵀ
  HH: Float64Array;   // K⁽³⁾ = g·gᵀ
  rows: number;
  cols: number;
}

/** Row/column filter pair for each of the three subbands. */
const BANK: [Float64Array, Float64Array, string][] = [
  [H_LOW,  H_HIGH, 'LH'],
  [H_HIGH, H_LOW,  'HL'],
  [H_HIGH, H_HIGH, 'HH'],
];

/** One separable undecimated 2-D filtering: columns with B, then rows with A. */
function residual(
  img: Float64Array, rows: number, cols: number,
  A: Float64Array, B: Float64Array,
): Float64Array {
  // Pass 1 — along the column axis (v) with B.
  const tmp = new Float64Array(rows * cols);
  for (let u = 0; u < rows; u++) {
    const base = u * cols;
    for (let v = 0; v < cols; v++) {
      let s = 0;
      for (let b = 0; b < TAPS; b++) {
        s += B[b] * img[base + mirror(v + b - ANCHOR, cols)];
      }
      tmp[base + v] = s;
    }
  }
  // Pass 2 — along the row axis (u) with A.
  const out = new Float64Array(rows * cols);
  for (let u = 0; u < rows; u++) {
    for (let v = 0; v < cols; v++) {
      let s = 0;
      for (let a = 0; a < TAPS; a++) {
        s += A[a] * tmp[mirror(u + a - ANCHOR, rows) * cols + v];
      }
      out[u * cols + v] = s;
    }
  }
  return out;
}

/** Compute all three first-level undecimated directional residuals. */
export function directionalResiduals(
  img: Float64Array, rows: number, cols: number,
): DirectionalResiduals {
  return {
    LH: residual(img, rows, cols, BANK[0][0], BANK[0][1]),
    HL: residual(img, rows, cols, BANK[1][0], BANK[1][1]),
    HH: residual(img, rows, cols, BANK[2][0], BANK[2][1]),
    rows, cols,
  };
}

// ─── DCT basis, separably ────────────────────────────────────────────────────
//
// B_kl[x,y] = ¼·C(k)·C(l)·cos((2x+1)kπ/16)·cos((2y+1)lπ/16)
//           = v_k[x] · v_l[y]    with   v_k[x] = ½·C(k)·cos((2x+1)kπ/16)

/** The eight 1-D DCT basis vectors, v_k[0..7]. */
const V: Float64Array[] = [];
for (let k = 0; k < 8; k++) {
  const v = new Float64Array(8);
  const ck = k === 0 ? Math.SQRT1_2 : 1.0;
  for (let x = 0; x < 8; x++) {
    v[x] = 0.5 * ck * Math.cos((2 * x + 1) * k * Math.PI / 16);
  }
  V.push(v);
}

/** Full 8×8 basis pattern B_kl in natural (row-major) order — used by the
 *  literal reference path, which perturbs actual pixels. */
function dctBasis(k: number, l: number): Float64Array {
  const b = new Float64Array(64);
  for (let x = 0; x < 8; x++) {
    for (let y = 0; y < 8; y++) b[x * 8 + y] = V[k][x] * V[l][y];
  }
  return b;
}

const BASIS_CACHE: Float64Array[] = [];
for (let k = 0; k < 8; k++) for (let l = 0; l < 8; l++) BASIS_CACHE.push(dctBasis(k, l));

// ─── 1-D ripple profiles ─────────────────────────────────────────────────────
//
// Because the transform is UNDECIMATED it is shift-invariant, so a unit change
// in DCT mode (k,l) of one block makes the same ripple wherever the block sits.
// And because the kernel K⁽ᵐ⁾ = A·Bᵀ and the basis B_kl = v_k·v_lᵀ are BOTH
// outer products — and the mirror padding acts on each axis independently —
// the whole 23×23 ripple factorises along the two axes, at the image boundary
// as well as in the interior:
//
//     ΔW⁽ᵐ⁾[u,v] = q · gA⁽ᵐ⁾_k[u] · gB⁽ᵐ⁾_l[v]
//
//     g_k[u] = Σₐ F[a] · v_k[ mirror(u + a − ANCHOR) − b₀ ]
//
// (v_k[·] is zero outside [0,8); b₀ is the block's first pixel on that axis.)
// So |ΔW| = |gA_k[u]|·|gB_l[v]| and the cost separates into a column pass and a
// row pass. Away from the edges g is just the translated 23-tap footprint; at
// an edge the reflected copy of the ripple folds back onto it and g accounts
// for that exactly. This makes the fast path an EXACT evaluation of Eq. 3
// everywhere, not an approximation of it.

/** Nonzero entries of one axis's |g| profile. */
interface Profile { idx: Int32Array; val: Float64Array; }

/** Profiles indexed [blockIndexOnThisAxis][filter 0=h,1=g][basis mode 0..7]. */
function axisProfiles(nBlocks: number, n: number): Profile[][][] {
  const out: Profile[][][] = [];
  for (let b = 0; b < nBlocks; b++) {
    const b0 = b * 8;
    // g can only be nonzero where some tap reaches the block; the reflected
    // copy stays within the same neighbourhood, so this window is ample.
    const lo = Math.max(0, b0 - 2 * TAPS - 8);
    const hi = Math.min(n, b0 + 2 * TAPS + 16);
    const perFilter: Profile[][] = [];
    for (let fi = 0; fi < 2; fi++) {
      const F = fi === 0 ? H_LOW : H_HIGH;
      const perMode: Profile[] = [];
      for (let k = 0; k < 8; k++) {
        const idx: number[] = [], val: number[] = [];
        for (let u = lo; u < hi; u++) {
          let s = 0;
          for (let a = 0; a < TAPS; a++) {
            const x = mirror(u + a - ANCHOR, n) - b0;
            if (x >= 0 && x < 8) s += F[a] * V[k][x];
          }
          if (s !== 0) { idx.push(u); val.push(Math.abs(s)); }
        }
        perMode.push({ idx: Int32Array.from(idx), val: Float64Array.from(val) });
      }
      perFilter.push(perMode);
    }
    out.push(perFilter);
  }
  return out;
}

/** Which 1-D filter runs down the rows / across the columns, per subband. */
const ROW_FILT = [0, 1, 1] as const;   // h, g, g
const COL_FILT = [1, 0, 1] as const;   // g, h, g

// ─── J-UNIWARD cost matrix ───────────────────────────────────────────────────

/**
 * Compute the J-UNIWARD cost ρ for every (block, DCT coefficient).
 *
 * This is Eq. 3 of the paper evaluated exactly, exploiting the shift-invariance
 * of the undecimated transform and the separability of both the filter bank and
 * the DCT basis. {@link computeCostMatrixSlow} evaluates the same quantity by
 * brute force (perturb pixels, re-transform) and the test suite checks the two
 * agree to floating-point tolerance on interior blocks.
 *
 * @param lumaPixels  Spatial luma values (Float32Array, width×height)
 * @param quantTable  Luma quantization table (Uint16Array, 64 values, zigzag)
 * @param blocksWide  Number of 8×8 blocks per row
 * @param blocksHigh  Number of 8×8 block rows
 * @returns           One Float64Array(64) of zigzag-ordered costs per block.
 *                    DC is wet (1e8).
 */
export async function computeCostMatrix(
  lumaPixels: Float32Array,
  quantTable: Uint16Array,
  blocksWide: number,
  blocksHigh: number,
  onProgress?: (fraction: number) => void,
): Promise<Float64Array[]> {
  const blockCount = blocksWide * blocksHigh;
  const rows = blocksHigh * 8;
  const cols = blocksWide * 8;

  const img = new Float64Array(lumaPixels.length);
  for (let i = 0; i < img.length; i++) img[i] = lumaPixels[i];

  // Cover residuals → reciprocal denominators 1 / (σ + |W⁽ᵐ⁾|).
  const cover = directionalResiduals(img, rows, cols);
  const recip: Float64Array[] = [cover.LH, cover.HL, cover.HH].map(w => {
    const o = new Float64Array(w.length);
    for (let i = 0; i < w.length; i++) o[i] = 1 / (SIGMA + Math.abs(w[i]));
    return o;
  });

  const costs: Float64Array[] = Array.from({ length: blockCount }, () => new Float64Array(64));

  const rowProf = axisProfiles(blocksHigh, rows);
  const colProf = axisProfiles(blocksWide, cols);

  // Accumulate subband by subband, and within a subband column-mode by
  // column-mode, so only one Float64Array(rows × blocksWide) is live at a time.
  const T = new Float64Array(rows * blocksWide);
  const steps = 3 * 8;
  let step = 0;

  for (let m = 0; m < 3; m++) {
    const R = recip[m];
    const rf = ROW_FILT[m];
    const cf = COL_FILT[m];

    for (let l = 0; l < 8; l++) {
      // T[u, bCol] = Σ_v |gB_l[v]| · recip[u, v]
      for (let u = 0; u < rows; u++) {
        const rBase = u * cols;
        const tBase = u * blocksWide;
        for (let bCol = 0; bCol < blocksWide; bCol++) {
          const p = colProf[bCol][cf][l];
          const pi = p.idx, pv = p.val;
          let s = 0;
          for (let i = 0; i < pi.length; i++) s += pv[i] * R[rBase + pi[i]];
          T[tBase + bCol] = s;
        }
      }

      // ρ += Σ_u |gA_k[u]| · T[u, bCol]
      for (let bRow = 0; bRow < blocksHigh; bRow++) {
        for (let bCol = 0; bCol < blocksWide; bCol++) {
          const blockCosts = costs[bRow * blocksWide + bCol];
          for (let k = 0; k < 8; k++) {
            const p = rowProf[bRow][rf][k];
            const pi = p.idx, pv = p.val;
            let s = 0;
            for (let i = 0; i < pi.length; i++) s += pv[i] * T[pi[i] * blocksWide + bCol];
            blockCosts[NAT_TO_ZZ[k * 8 + l]] += s;
          }
        }
      }

      step++;
      onProgress?.(step / steps);
      // Yield so the UI stays responsive.
      await new Promise(r => setTimeout(r, 0));
    }
  }

  // Scale by the quantization step and mark DC wet.
  for (let bi = 0; bi < blockCount; bi++) {
    const c = costs[bi];
    for (let zi = 0; zi < 64; zi++) c[zi] *= quantTable[zi];
    c[0] = WET;
  }

  onProgress?.(1);
  return costs;
}

/**
 * Reference cost implementation — the literal definition, by brute force.
 *
 * For every (block, coefficient) it adds q·B_kl to the cover pixels, recomputes
 * the three first-level undecimated directional residuals on a padded patch,
 * and sums |ΔW| / (σ + |W_cover|) over all three subbands. Correct but orders
 * of magnitude slower than {@link computeCostMatrix}, which computes the same
 * quantity in closed form. Kept as the oracle the test suite validates the fast
 * path against; the app never calls it.
 */
export async function computeCostMatrixSlow(
  lumaPixels: Float32Array,
  quantTable: Uint16Array,
  blocksWide: number,
  blocksHigh: number,
): Promise<Float64Array[]> {
  const blockCount = blocksWide * blocksHigh;
  const rows = blocksHigh * 8;
  const cols = blocksWide * 8;

  const img = new Float64Array(lumaPixels.length);
  for (let i = 0; i < img.length; i++) img[i] = lumaPixels[i];

  const costs: Float64Array[] = Array.from({ length: blockCount }, () => new Float64Array(64));

  // The ripple reaches ANCHOR+7 = 14 px past the block and needs another TAPS−1
  // pixels of context to evaluate; 32 is comfortably more than enough.
  const PAD = 32;

  for (let bRow = 0; bRow < blocksHigh; bRow++) {
    await new Promise(r => setTimeout(r, 0));
    for (let bCol = 0; bCol < blocksWide; bCol++) {
      const bi = bRow * blocksWide + bCol;
      const pRow = bRow * 8, pCol = bCol * 8;

      const pr0 = Math.max(0, pRow - PAD);
      const pc0 = Math.max(0, pCol - PAD);
      const pr1 = Math.min(rows, pRow + 8 + PAD);
      const pc1 = Math.min(cols, pCol + 8 + PAD);
      const ph = pr1 - pr0, pw = pc1 - pc0;

      const patch = new Float64Array(ph * pw);
      for (let r = 0; r < ph; r++)
        for (let c = 0; c < pw; c++)
          patch[r * pw + c] = img[(pr0 + r) * cols + (pc0 + c)];

      const cov = directionalResiduals(patch, ph, pw);
      const covBands = [cov.LH, cov.HL, cov.HH];

      for (let zi = 0; zi < 64; zi++) {
        const nat = ZZ_TO_NAT[zi];
        if (nat === 0) { costs[bi][zi] = WET; continue; }

        const k = nat >> 3, l = nat & 7;
        const q = quantTable[zi];
        const basis = BASIS_CACHE[k * 8 + l];

        const perturbed = new Float64Array(patch);
        const br = pRow - pr0, bc = pCol - pc0;
        for (let px = 0; px < 8; px++)
          for (let py = 0; py < 8; py++)
            perturbed[(br + px) * pw + (bc + py)] += q * basis[px * 8 + py];

        const per = directionalResiduals(perturbed, ph, pw);
        const perBands = [per.LH, per.HL, per.HH];

        let cost = 0;
        for (let m = 0; m < 3; m++) {
          const cb = covBands[m], pb = perBands[m];
          for (let i = 0; i < cb.length; i++) {
            cost += Math.abs(pb[i] - cb[i]) / (SIGMA + Math.abs(cb[i]));
          }
        }
        costs[bi][zi] = cost;
      }
    }
  }

  return costs;
}

/**
 * probeBlock — single-block "why is this cost cheap/expensive?" explainer.
 *
 * Perturbs ONE 8×8 block by a +1 quantization step in a chosen DCT mode, then
 * measures, subband by subband, how much that ripple disturbs the three
 * first-level undecimated directional residuals *relative to the cover
 * magnitude already there*. This is the literal J-UNIWARD definition (Eq. 3),
 * evaluated for a single block so it runs instantly on hover/click.
 *
 * The teaching payoff: a change dropped into busy texture (large |W_cover|) is
 * divided by a large denominator → small normalized disturbance → LOW cost. The
 * same change in a flat region (tiny |W_cover|) is divided by ~σ → huge cost.
 * The learner SEES the denominator, not just the verdict.
 */
export interface SubbandProbe {
  name: string;         // 'LH' | 'HL' | 'HH'
  deltaSum: number;     // Σ |ΔW| in this subband (the raw ripple energy)
  coverMag: number;     // Σ |W_cover| in this subband (the denominator magnitude)
  contribution: number; // Σ |ΔW| / (σ + |W_cover|) — this subband's share of the cost
}

export interface BlockProbe {
  subbands: SubbandProbe[];
  totalCost: number;   // Σ over subbands — the J-UNIWARD ρ for this (block, mode)
  q: number;           // quantization step applied (the size of the ±1 change)
  coeffNat: number;    // natural DCT index perturbed (row*8+col)
}

export function probeBlock(
  lumaPixels: Float32Array,
  quantTable: Uint16Array,
  blocksWide: number,
  blocksHigh: number,
  bRow: number,
  bCol: number,
  zigzagIndex: number = 1, // which DCT mode to perturb (default: first AC)
): BlockProbe {
  const rows = blocksHigh * 8;
  const cols = blocksWide * 8;
  const img = new Float64Array(lumaPixels.length);
  for (let i = 0; i < img.length; i++) img[i] = lumaPixels[i];

  const PAD = 32;
  const pRow = bRow * 8, pCol = bCol * 8;
  const pr0 = Math.max(0, pRow - PAD);
  const pc0 = Math.max(0, pCol - PAD);
  const pr1 = Math.min(rows, pRow + 8 + PAD);
  const pc1 = Math.min(cols, pCol + 8 + PAD);
  const ph = pr1 - pr0, pw = pc1 - pc0;

  const patch = new Float64Array(ph * pw);
  for (let r = 0; r < ph; r++)
    for (let c = 0; c < pw; c++)
      patch[r * pw + c] = img[(pr0 + r) * cols + (pc0 + c)];

  const nat = ZZ_TO_NAT[zigzagIndex];
  const k = nat >> 3, l = nat & 7;
  const q = quantTable[zigzagIndex] || 1;
  const basis = BASIS_CACHE[k * 8 + l];

  const perturbed = new Float64Array(patch);
  const br = pRow - pr0, bc = pCol - pc0;
  for (let px = 0; px < 8; px++)
    for (let py = 0; py < 8; py++)
      perturbed[(br + px) * pw + (bc + py)] += q * basis[px * 8 + py];

  const cov = directionalResiduals(patch, ph, pw);
  const per = directionalResiduals(perturbed, ph, pw);
  const covBands = [cov.LH, cov.HL, cov.HH];
  const perBands = [per.LH, per.HL, per.HH];

  const subbands: SubbandProbe[] = [];
  let totalCost = 0;
  for (let m = 0; m < 3; m++) {
    const cb = covBands[m], pb = perBands[m];
    let deltaSum = 0, coverMag = 0, contribution = 0;
    for (let i = 0; i < cb.length; i++) {
      const d = Math.abs(pb[i] - cb[i]);
      deltaSum += d;
      coverMag += Math.abs(cb[i]);
      contribution += d / (SIGMA + Math.abs(cb[i]));
    }
    subbands.push({ name: BANK[m][2], deltaSum, coverMag, contribution });
    totalCost += contribution;
  }

  return { subbands, totalCost, q, coeffNat: nat };
}

// Local zigzag ↔ natural maps (avoid a cross-module dep on codec internals)
const ZZ_TO_NAT = new Uint8Array([
   0,  1,  8, 16,  9,  2,  3, 10,
  17, 24, 32, 25, 18, 11,  4,  5,
  12, 19, 26, 33, 40, 48, 41, 34,
  27, 20, 13,  6,  7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36,
  29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46,
  53, 60, 61, 54, 47, 55, 62, 63,
]);

const NAT_TO_ZZ = new Uint8Array(64);
for (let zi = 0; zi < 64; zi++) NAT_TO_ZZ[ZZ_TO_NAT[zi]] = zi;

/**
 * Render cost heatmap onto a canvas for Phase 2 validation.
 * Low cost → cool blue (textured): good for embedding.
 * High cost → warm red (smooth):  bad for embedding.
 */
export function renderCostHeatmap(
  canvas: HTMLCanvasElement,
  costs: Float64Array[],
  quantTable: Uint16Array,
  blocksWide: number,
  blocksHigh: number,
  coeffIndex: number = 1, // which zigzag index to visualize; 0=DC (skip), 1=first AC
): void {
  const imgW = blocksWide * 8;
  const imgH = blocksHigh * 8;
  canvas.width  = imgW;
  canvas.height = imgH;
  const ctx = canvas.getContext('2d')!;
  const imageData = ctx.createImageData(imgW, imgH);
  const d = imageData.data;

  // Collect finite costs for this coefficient index across all blocks
  // Use average of a few low-frequency AC coefficients for a meaningful map
  const avgCosts = new Float32Array(costs.length);
  const AC_COEFFS = [1, 2, 3, 8, 9, 16]; // zigzag indices; skip DC=0
  for (let bi = 0; bi < costs.length; bi++) {
    let sum = 0, cnt = 0;
    for (const zi of AC_COEFFS) {
      const c = costs[bi][zi];
      if (isFinite(c) && c < 1e7) { sum += c; cnt++; }
    }
    avgCosts[bi] = cnt > 0 ? sum / cnt : WET;
  }

  const fin = avgCosts.filter(v => isFinite(v) && v < 1e7);
  if (fin.length === 0) return;
  const minC = Math.min(...fin);
  const maxC = Math.max(...fin);
  const range = maxC - minC || 1;

  for (let bi = 0; bi < costs.length; bi++) {
    const bRow = Math.floor(bi / blocksWide);
    const bCol = bi % blocksWide;
    const t = Math.min(1, Math.max(0, (avgCosts[bi] - minC) / range));

    // Heatmap: low cost (t=0) = blue (#0077ff), high cost (t=1) = red (#ff3300)
    const r = Math.round(t * 255);
    const g = Math.round((1 - Math.abs(2 * t - 1)) * 180);
    const b = Math.round((1 - t) * 255);

    for (let px = 0; px < 8; px++) {
      for (let py = 0; py < 8; py++) {
        const imgIdx = ((bRow * 8 + px) * imgW + bCol * 8 + py) * 4;
        d[imgIdx]     = r;
        d[imgIdx + 1] = g;
        d[imgIdx + 2] = b;
        d[imgIdx + 3] = 180; // semi-transparent overlay
      }
    }
  }

  ctx.putImageData(imageData, 0, 0);
}
