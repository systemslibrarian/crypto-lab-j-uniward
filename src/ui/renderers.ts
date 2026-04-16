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

/** Render a DCT coefficient histogram on canvas. */
export function renderHistogram(canvas: HTMLCanvasElement, hist: Int32Array): void {
  const W = canvas.offsetWidth || 300;
  const H = 100;
  canvas.width  = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;

  const offset = 128;
  const range  = 64;
  const barW   = W / (range * 2 + 1);

  const slice  = Array.from(hist.slice(offset - range, offset + range + 1));
  const maxVal = Math.max(...slice, 1);

  const style = getComputedStyle(document.documentElement);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = style.getPropertyValue('--bg-tertiary').trim();
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = style.getPropertyValue('--text-accent').trim();
  slice.forEach((v, i) => {
    const h = (v / maxVal) * (H - 4);
    ctx.fillRect(i * barW, H - h, Math.max(1, barW - 0.5), h);
  });

  // Zero line
  ctx.strokeStyle = style.getPropertyValue('--error-text').trim();
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(range * barW, 0);
  ctx.lineTo(range * barW, H);
  ctx.stroke();
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
