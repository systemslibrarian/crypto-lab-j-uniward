/**
 * WaveletCost — Daubechies-8 three-level wavelet decomposition for J-UNIWARD
 *
 * Implements the cost function from:
 *   Holub & Fridrich, "Designing Steganographic Distortion Using Directional
 *   Filters," IEEE WIFS 2012 (IEEE, 2013).
 *
 * The cost ρ(i,j) for modifying DCT coefficient (i,j) by ±1 is:
 *
 *   ρ(i,j) = Σ_k Σ_{r,c}  |W_k(perturbed)[r,c] - W_k(cover)[r,c]|
 *                          ─────────────────────────────────────────
 *                            |W_k(cover)[r,c]| + σ
 *
 * where k indexes the 9 detail subbands (LH1, HL1, HH1, LH2, HL2, HH2,
 * LH3, HL3, HH3) and σ = 2^{-6}.
 */

// ─── D8 filter coefficients (Daubechies 1988, exact) ─────────────────────────

const H_LOW = new Float64Array([
   0.23037781330885523,
   0.71484657055254151,
   0.63088076792959036,
  -0.02798376941698385,
  -0.18703481171888114,
   0.030841381835986965,
   0.032883011666982945,
  -0.010597401784997278,
]);

// High-pass QMF: g[n] = (-1)^n * h[N-1-n]
const H_HIGH = new Float64Array(8);
for (let n = 0; n < 8; n++) {
  H_HIGH[n] = (n % 2 === 0 ? 1 : -1) * H_LOW[7 - n];
}

// ─── 1D convolution with symmetric (mirror) boundary extension ───────────────

function conv1D(signal: Float64Array, filter: Float64Array): Float64Array {
  const N = signal.length;
  const M = filter.length;          // M = 8 for D8
  const half = (M - 1) >> 1;        // 3 for M=8
  const out = new Float64Array(N);

  for (let i = 0; i < N; i++) {
    let sum = 0;
    for (let k = 0; k < M; k++) {
      let idx = i - half + k;
      // Symmetric boundary extension (mirror)
      if (idx < 0)     idx = -idx - 1;
      if (idx >= N)    idx = 2 * N - idx - 1;
      if (idx < 0)     idx = 0;
      if (idx >= N)    idx = N - 1;
      sum += filter[M - 1 - k] * signal[idx];  // correlation = convolution with reversed filter
    }
    out[i] = sum;
  }
  return out;
}

/** Downsample by 2 (keep even indices) */
function downsample(x: Float64Array): Float64Array {
  const out = new Float64Array(Math.ceil(x.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = x[i * 2];
  return out;
}

// ─── 2D separable single-level decomposition ─────────────────────────────────

interface Level {
  LL: Float64Array; width: number; height: number;
  LH: Float64Array;   // horizontal detail (rows=low, cols=high)
  HL: Float64Array;   // vertical detail   (rows=high, cols=low)
  HH: Float64Array;   // diagonal detail   (rows=high, cols=high)
  sw: number;         // subband width
  sh: number;         // subband height
}

function decompose2D(img: Float64Array, rows: number, cols: number): Level {
  // Step 1: filter and downsample rows
  const LL_rows = new Float64Array(rows * Math.ceil(cols / 2));
  const LH_rows = new Float64Array(rows * Math.ceil(cols / 2));

  for (let r = 0; r < rows; r++) {
    const row = img.subarray(r * cols, r * cols + cols);
    const rowF64 = row instanceof Float64Array ? row : new Float64Array(row);
    const lo = conv1D(rowF64, H_LOW);
    const hi = conv1D(rowF64, H_HIGH);
    const lod = downsample(lo);
    const hid = downsample(hi);
    LL_rows.set(lod, r * lod.length);
    LH_rows.set(hid, r * hid.length);
  }

  const sw = Math.ceil(cols / 2);
  const sh = Math.ceil(rows / 2);

  // Step 2: filter and downsample columns on the row-filtered outputs
  function filterCols(rowFiltered: Float64Array, filtLo: Float64Array, filtHi: Float64Array) {
    const outLo = new Float64Array(sh * sw);
    const outHi = new Float64Array(sh * sw);
    for (let c = 0; c < sw; c++) {
      const col = new Float64Array(rows);
      for (let r = 0; r < rows; r++) col[r] = rowFiltered[r * sw + c];
      const lo2 = downsample(conv1D(col, filtLo));
      const hi2 = downsample(conv1D(col, filtHi));
      for (let r = 0; r < sh; r++) {
        outLo[r * sw + c] = lo2[r];
        outHi[r * sw + c] = hi2[r];
      }
    }
    return [outLo, outHi];
  }

  const [LL, HL] = filterCols(LL_rows, H_LOW, H_HIGH);
  const [LH, HH] = filterCols(LH_rows, H_LOW, H_HIGH);

  return { LL, LH, HL, HH, width: cols, height: rows, sw, sh };
}

// ─── 3-level decomposition → 9 detail subbands ───────────────────────────────

interface WaveletSubbands {
  // Level 1
  LH1: Float64Array; HL1: Float64Array; HH1: Float64Array;
  sw1: number; sh1: number;
  // Level 2
  LH2: Float64Array; HL2: Float64Array; HH2: Float64Array;
  sw2: number; sh2: number;
  // Level 3
  LH3: Float64Array; HL3: Float64Array; HH3: Float64Array; LL3: Float64Array;
  sw3: number; sh3: number;
}

function wavelet3Level(img: Float64Array, rows: number, cols: number): WaveletSubbands {
  const l1 = decompose2D(img, rows, cols);
  const l2 = decompose2D(l1.LL, l1.sh, l1.sw);
  const l3 = decompose2D(l2.LL, l2.sh, l2.sw);

  return {
    LH1: l1.LH, HL1: l1.HL, HH1: l1.HH, sw1: l1.sw, sh1: l1.sh,
    LH2: l2.LH, HL2: l2.HL, HH2: l2.HH, sw2: l2.sw, sh2: l2.sh,
    LH3: l3.LH, HL3: l3.HL, HH3: l3.HH, LL3: l3.LL, sw3: l3.sw, sh3: l3.sh,
  };
}

// ─── DCT basis functions (for per-coefficient perturbation) ──────────────────
// B_kl[x,y] = C(k)*C(l)/4 * cos((2x+1)kπ/16) * cos((2y+1)lπ/16)

function dctBasis(k: number, l: number): Float64Array {
  const b = new Float64Array(64);
  const ck = k === 0 ? Math.SQRT1_2 : 1.0;
  const cl = l === 0 ? Math.SQRT1_2 : 1.0;
  for (let x = 0; x < 8; x++) {
    for (let y = 0; y < 8; y++) {
      b[x * 8 + y] = 0.25 * ck * cl *
        Math.cos((2 * x + 1) * k * Math.PI / 16) *
        Math.cos((2 * y + 1) * l * Math.PI / 16);
    }
  }
  return b;
}

// Precompute all 64 DCT basis functions (indexed zigzag→natural inside each 8×8)
// Actually we index by straight natural order (row=k, col=l), k*8+l
const BASIS_CACHE: Float64Array[] = [];
for (let k = 0; k < 8; k++)
  for (let l = 0; l < 8; l++)
    BASIS_CACHE.push(dctBasis(k, l));

// ─── J-UNIWARD cost matrix ────────────────────────────────────────────────────

const SIGMA = Math.pow(2, -6); // 0.015625 — wet cost floor

/**
 * Compute J-UNIWARD distortion cost ρ for every DCT coefficient.
 *
 * @param lumaPixels  Spatial luma values (Float32Array, width×height)
 * @param quantTable  Luma quantization table (Uint16Array, 64 values, zigzag)
 * @param blocksWide  Number of 8×8 blocks per row
 * @param blocksHigh  Number of 8×8 block rows
 * @returns           Array of length blockCount, each a Float32Array(64) of costs
 *                    in zigzag order.  Wet cost = 1e8 (effectively infinity).
 */
export function computeCostMatrix(
  lumaPixels: Float32Array,
  quantTable: Uint16Array,
  blocksWide: number,
  blocksHigh: number,
): Float32Array[] {
  const blockCount = blocksWide * blocksHigh;
  const rows = blocksHigh * 8;
  const cols = blocksWide * 8;

  // Convert to Float64 for wavelet computation
  const img = new Float64Array(lumaPixels.length);
  for (let i = 0; i < img.length; i++) img[i] = lumaPixels[i];

  // Cover wavelet subbands
  const coverSub = wavelet3Level(img, rows, cols);

  // Precompute 1/( |W_k(cover)| + σ ) for each subband in flat arrays
  const subbands = [
    { w: coverSub.LH1, sw: coverSub.sw1, sh: coverSub.sh1 },
    { w: coverSub.HL1, sw: coverSub.sw1, sh: coverSub.sh1 },
    { w: coverSub.HH1, sw: coverSub.sw1, sh: coverSub.sh1 },
    { w: coverSub.LH2, sw: coverSub.sw2, sh: coverSub.sh2 },
    { w: coverSub.HL2, sw: coverSub.sw2, sh: coverSub.sh2 },
    { w: coverSub.HH2, sw: coverSub.sw2, sh: coverSub.sh2 },
    { w: coverSub.LH3, sw: coverSub.sw3, sh: coverSub.sh3 },
    { w: coverSub.HL3, sw: coverSub.sw3, sh: coverSub.sh3 },
    { w: coverSub.HH3, sw: coverSub.sw3, sh: coverSub.sh3 },
  ];
  const invDenom = subbands.map(sb => {
    const arr = new Float64Array(sb.w.length);
    for (let i = 0; i < arr.length; i++) arr[i] = 1.0 / (Math.abs(sb.w[i]) + SIGMA);
    return arr;
  });

  // Output cost arrays
  const costs: Float32Array[] = Array.from({ length: blockCount }, () => new Float32Array(64));

  // For each block and each DCT coefficient compute cost
  // We use the linearity of the wavelet transform:
  //   ΔI = q_{kl} * B_{kl} added to the 8×8 block
  //   Δcost = Σ_n Σ_{r,c} |ΔW_n(r,c)| * invDenom_n(r,c)
  // We perturb the image for each (block, kl) and recompute affected subbands.
  // For efficiency we only recompute the affected region using the compact D8 support.

  // D8 filter support: length 8.  After L levels of decimation the support
  // of the synthesis filter in the signal domain is (2^L - 1)*(M-1)+1 pixels
  // on each side.  We pad the block patch by PAD pixels for safe recomputation.
  const PAD = 32; // generous padding for 3-level D8; exact = (2^3)*(8-1) = 56/2 = 28

  for (let bRow = 0; bRow < blocksHigh; bRow++) {
    for (let bCol = 0; bCol < blocksWide; bCol++) {
      const bi = bRow * blocksWide + bCol;

      // Block top-left pixel in image
      const pRow = bRow * 8;
      const pCol = bCol * 8;

      // Patch bounds (clamped to image)
      const pr0 = Math.max(0, pRow - PAD);
      const pc0 = Math.max(0, pCol - PAD);
      const pr1 = Math.min(rows, pRow + 8 + PAD);
      const pc1 = Math.min(cols, pCol + 8 + PAD);
      const ph  = pr1 - pr0;
      const pw  = pc1 - pc0;

      // Extract cover patch
      const patch = new Float64Array(ph * pw);
      for (let r = 0; r < ph; r++) {
        for (let c = 0; c < pw; c++) {
          patch[r * pw + c] = img[(pr0 + r) * cols + (pc0 + c)];
        }
      }
      const coverPatchSub = wavelet3Level(patch, ph, pw);

      // For each DCT coefficient (zigzag index zi)
      for (let zi = 0; zi < 64; zi++) {
        // Map zigzag → natural (k=row, l=col within 8×8)
        const nat = ZZ_TO_NAT_LOCAL[zi];
        const k = nat >> 3;
        const l = nat & 7;
        const q = quantTable[zi];

        // Wet cost: if DC coefficient (k=l=0) skip (don't embed in DC)
        if (k === 0 && l === 0) {
          costs[bi][zi] = 1e8;
          continue;
        }

        // Wet cost: if quantization step > 1, skip zero-only coefficient
        // (approximation: skip if q > 1 — standard J-UNIWARD practice)
        // We still compute cost for these; caller may mark as wet.

        // Compute perturbation (q * B_kl) on the 8×8 block within the patch
        const basis = BASIS_CACHE[k * 8 + l];
        const perturbed = new Float64Array(patch);
        const patchBlockR = pRow - pr0;
        const patchBlockC = pCol - pc0;
        for (let px = 0; px < 8; px++) {
          for (let py = 0; py < 8; py++) {
            perturbed[(patchBlockR + px) * pw + (patchBlockC + py)] += q * basis[px * 8 + py];
          }
        }

        const pertSub = wavelet3Level(perturbed, ph, pw);
        const pertSubbands = [
          pertSub.LH1, pertSub.HL1, pertSub.HH1,
          pertSub.LH2, pertSub.HL2, pertSub.HH2,
          pertSub.LH3, pertSub.HL3, pertSub.HH3,
        ];
        const coverPatchSubbands = [
          coverPatchSub.LH1, coverPatchSub.HL1, coverPatchSub.HH1,
          coverPatchSub.LH2, coverPatchSub.HL2, coverPatchSub.HH2,
          coverPatchSub.LH3, coverPatchSub.HL3, coverPatchSub.HH3,
        ];

        // Compute cost: Σ_n Σ_{r,c in patch} |ΔW_n| / (|W_n_cover| + σ)
        // We use the PATCH-local subband values.
        // The denominator uses the full-image subband values (invDenom) mapped
        // from patch coordinates to full-image subband coordinates.
        let cost = 0;
        for (let sn = 0; sn < 9; sn++) {
          const csb = coverPatchSubbands[sn];
          const psb = pertSubbands[sn];
          for (let idx = 0; idx < csb.length; idx++) {
            const delta = Math.abs(psb[idx] - csb[idx]);
            cost += delta / (Math.abs(csb[idx]) + SIGMA);
          }
        }

        costs[bi][zi] = cost;
      }
    }
  }

  return costs;
}

// Local copy of ZZ_TO_NAT for this module (avoid cross-module dep on codec internals)
const ZZ_TO_NAT_LOCAL = new Uint8Array([
   0,  1,  8, 16,  9,  2,  3, 10,
  17, 24, 32, 25, 18, 11,  4,  5,
  12, 19, 26, 33, 40, 48, 41, 34,
  27, 20, 13,  6,  7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36,
  29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46,
  53, 60, 61, 54, 47, 55, 62, 63,
]);

/**
 * Render cost heatmap onto a canvas for Phase 2 validation.
 * Low cost → cool blue (textured): good for embedding.
 * High cost → warm red (smooth):  bad for embedding.
 */
export function renderCostHeatmap(
  canvas: HTMLCanvasElement,
  costs: Float32Array[],
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
    avgCosts[bi] = cnt > 0 ? sum / cnt : 1e8;
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
