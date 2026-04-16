import jpeg from 'jpeg-js';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '..', 'public', 'samples');
mkdirSync(outDir, { recursive: true });

const W = 256, H = 256;

function clamp(v) { return v < 0 ? 0 : v > 255 ? 255 : Math.round(v); }

function encode(rgbaBuffer, quality) {
  const raw = { data: rgbaBuffer, width: W, height: H };
  return jpeg.encode(raw, quality).data;
}

function makeBuffer(pixelFn) {
  const buf = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const off = (y * W + x) * 4;
      const [r, g, b] = pixelFn(x, y);
      buf[off]     = clamp(r);
      buf[off + 1] = clamp(g);
      buf[off + 2] = clamp(b);
      buf[off + 3] = 255;
    }
  }
  return buf;
}

// Deterministic pseudo-random
function hash(x, y, seed) {
  let h = seed;
  h = ((h << 5) - h + x) | 0;
  h = ((h << 5) - h + y) | 0;
  h = ((h ^ (h >>> 16)) * 0x45d9f3b) | 0;
  return (h & 0x7fffffff) / 0x7fffffff;
}

// Smooth noise via bilinear interpolation
function smoothNoise(x, y, scale, seed) {
  const sx = x / scale, sy = y / scale;
  const ix = Math.floor(sx), iy = Math.floor(sy);
  const fx = sx - ix, fy = sy - iy;
  const a = hash(ix, iy, seed);
  const b = hash(ix + 1, iy, seed);
  const c = hash(ix, iy + 1, seed);
  const d = hash(ix + 1, iy + 1, seed);
  const ab = a + (b - a) * fx;
  const cd = c + (d - c) * fx;
  return ab + (cd - ab) * fy;
}

// Multi-octave fractal noise
function fbm(x, y, seed, octaves = 4) {
  let val = 0, amp = 1, scale = 64, total = 0;
  for (let i = 0; i < octaves; i++) {
    val += smoothNoise(x, y, scale, seed + i * 1000) * amp;
    total += amp;
    amp *= 0.5;
    scale *= 0.5;
  }
  return val / total;
}

// --- sample-grass.jpg: Naturalistic green-brown texture (high wavelet cost) ---
const grass = makeBuffer((x, y) => {
  const n1 = fbm(x, y, 42, 5);
  const n2 = fbm(x * 2, y * 2, 99, 3);
  const n3 = smoothNoise(x, y, 4, 77);
  return [
    45 + n1 * 60 + n3 * 20 - 10,
    80 + n1 * 80 + n2 * 30 + n3 * 25 - 12,
    30 + n1 * 30 + n3 * 15 - 7,
  ];
});
writeFileSync(join(outDir, 'sample-grass.jpg'), encode(grass, 82));
console.log('wrote sample-grass.jpg (256×256, textured green)');

// --- sample-smooth.jpg: Soft sunset gradient (low wavelet cost) ---
const smooth = makeBuffer((x, y) => {
  const nx = x / W, ny = y / H;
  const noise = smoothNoise(x, y, 32, 55) * 6 - 3;
  return [
    220 - ny * 120 + nx * 30 + noise,
    160 - ny * 80 + nx * 20 + noise,
    140 + ny * 80 - nx * 20 + noise,
  ];
});
writeFileSync(join(outDir, 'sample-smooth.jpg'), encode(smooth, 82));
console.log('wrote sample-smooth.jpg (256×256, smooth gradient)');

// --- sample-portrait.jpg: Geometric shapes with mixed texture ---
const portrait = makeBuffer((x, y) => {
  const cx = W / 2, cy = H / 2;
  let r = 40, g = 42, b = 52;

  // Circle with textured fill
  const dist = Math.sqrt((x - cx) ** 2 + (y - cy - 10) ** 2);
  if (dist < 80) {
    const t = fbm(x, y, 200, 3);
    r = 180 + t * 40; g = 150 + t * 30; b = 130 + t * 20;
  }

  // Eyes
  const le = Math.sqrt((x - cx + 25) ** 2 + (y - cy - 20) ** 2);
  const re = Math.sqrt((x - cx - 25) ** 2 + (y - cy - 20) ** 2);
  if (le < 10 || re < 10) { r = 40; g = 40; b = 50; }

  // Textured background with rings
  if (dist >= 80) {
    const ring = Math.sin(dist * 0.12) * 0.5 + 0.5;
    const n = fbm(x, y, 333, 4);
    r = 30 + ring * 40 + n * 30;
    g = 35 + ring * 35 + n * 25;
    b = 50 + ring * 50 + n * 35;
  }

  return [r, g, b];
});
writeFileSync(join(outDir, 'sample-portrait.jpg'), encode(portrait, 82));
console.log('wrote sample-portrait.jpg (256×256, geometric mixed)');

console.log('done');
