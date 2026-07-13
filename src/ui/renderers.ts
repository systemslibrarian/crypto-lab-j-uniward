/**
 * renderers.ts — Canvas drawing and visual helpers
 */

/** Draw RGBA pixel data onto a canvas. */
export function drawImageOnCanvas(
  canvas: HTMLCanvasElement,
  imageData: Uint8ClampedArray,
  w: number,
  h: number,
): void {
  canvas.width  = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const imgData = new ImageData(
    new Uint8ClampedArray(imageData), w, h,
  );
  ctx.putImageData(imgData, 0, 0);
}

/**
 * Render a DCT coefficient histogram on canvas.
 *
 * When `coverHist` is supplied it is drawn as a faint outline *behind* the solid
 * after-embedding bars, so the learner sees the BEFORE→AFTER deformation rather
 * than a bare bar chart. When `highlightShrinkage` is set (F5), the ±1 buckets
 * flanking zero — where F5's magnitude-shrinkage carves its tell-tale dip — are
 * ringed and arrowed so a newcomer knows exactly where to look.
 */
export function renderHistogram(
  canvas: HTMLCanvasElement,
  hist: Int32Array,
  opts: { coverHist?: Int32Array; highlightShrinkage?: boolean } = {},
): void {
  const W = canvas.offsetWidth || 300;
  const H = 120;
  canvas.width  = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;

  const offset = 128;
  const range  = 64;
  const barW   = W / (range * 2 + 1);

  const slice = Array.from(hist.slice(offset - range, offset + range + 1));
  const coverSlice = opts.coverHist
    ? Array.from(opts.coverHist.slice(offset - range, offset + range + 1))
    : null;
  // Shared vertical scale so before/after are directly comparable.
  const maxVal = Math.max(...slice, ...(coverSlice ?? []), 1);
  const plotH = H - 4;

  const style = getComputedStyle(document.documentElement);
  const accent = style.getPropertyValue('--text-accent').trim();
  const muted  = style.getPropertyValue('--text-secondary').trim();
  const errCol = style.getPropertyValue('--error-text').trim();

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = style.getPropertyValue('--bg-tertiary').trim();
  ctx.fillRect(0, 0, W, H);

  // Cover outline (BEFORE): faint stepped line behind the bars.
  if (coverSlice) {
    ctx.strokeStyle = muted;
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    coverSlice.forEach((v, i) => {
      const y = H - (v / maxVal) * plotH;
      const x0 = i * barW, x1 = x0 + barW;
      if (i === 0) ctx.moveTo(x0, y);
      else ctx.lineTo(x0, y);
      ctx.lineTo(x1, y);
    });
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // After-embedding bars (solid).
  ctx.fillStyle = accent;
  slice.forEach((v, i) => {
    const h = (v / maxVal) * plotH;
    ctx.fillRect(i * barW, H - h, Math.max(1, barW - 0.5), h);
  });

  // Zero line.
  ctx.strokeStyle = errCol;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(range * barW, 0);
  ctx.lineTo(range * barW, H);
  ctx.stroke();

  // F5 shrinkage callout: ring + arrow the ±1 buckets that F5 suppresses.
  if (opts.highlightShrinkage) {
    ctx.strokeStyle = errCol;
    ctx.lineWidth = 2;
    for (const val of [-1, 1]) {
      const i = val + range; // index of value `val` inside slice
      const x = i * barW + barW / 2;
      ctx.beginPath();
      ctx.arc(x, H - (slice[i] / maxVal) * plotH - 2, Math.max(4, barW * 0.9), 0, Math.PI * 2);
      ctx.stroke();
    }
    // small downward arrows above the two rings
    ctx.fillStyle = errCol;
    for (const val of [-1, 1]) {
      const x = (val + range) * barW + barW / 2;
      ctx.beginPath();
      ctx.moveTo(x - 4, 4);
      ctx.lineTo(x + 4, 4);
      ctx.lineTo(x, 12);
      ctx.closePath();
      ctx.fill();
    }
  }
}

/** Draw 10× amplified pixel difference map between two decoded images. */
export function renderDiffMap(
  canvas: HTMLCanvasElement,
  coverPixels: Uint8ClampedArray,
  stegoPixels: Uint8ClampedArray,
  w: number,
  h: number,
): { avgDiff: number } {
  canvas.width  = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const imgData = ctx.createImageData(w, h);
  const d = imgData.data;
  let totalDiff = 0;
  const pixCount = w * h;

  for (let i = 0; i < pixCount; i++) {
    const off = i * 4;
    const dr = Math.abs(coverPixels[off]     - stegoPixels[off]);
    const dg = Math.abs(coverPixels[off + 1] - stegoPixels[off + 1]);
    const db = Math.abs(coverPixels[off + 2] - stegoPixels[off + 2]);
    const amp = Math.min(255, ((dr + dg + db) / 3) * 10);
    totalDiff += (dr + dg + db) / 3;
    d[off]     = amp;
    d[off + 1] = amp;
    d[off + 2] = amp;
    d[off + 3] = 255;
  }

  ctx.putImageData(imgData, 0, 0);
  return { avgDiff: totalDiff / pixCount };
}

/** Show/hide an alert element with a message and type. */
export function showAlert(
  el: HTMLElement,
  msg: string,
  type: 'error' | 'success' | 'info' | 'warning' = 'info',
): void {
  el.className = `alert alert-${type}`;
  el.innerHTML = msg;
  el.classList.remove('hidden');
}
