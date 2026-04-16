import jpeg from 'jpeg-js';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '..', 'public', 'samples');
mkdirSync(outDir, { recursive: true });

const W = 512, H = 512;

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

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
      buf[off]     = r;
      buf[off + 1] = g;
      buf[off + 2] = b;
      buf[off + 3] = 255;
    }
  }
  return buf;
}

// --- sample-grass.jpg: high-frequency noise ---
const grass = makeBuffer((x, y) => [
  (x * 173 + y * 251 + x * y * 7) & 255,
  (x * 197 + y * 239 + (x ^ y) * 13) & 255,
  (x * 211 + y * 233 + (x + y) * 17) & 255,
]);
writeFileSync(join(outDir, 'sample-grass.jpg'), encode(grass, 85));
console.log('wrote sample-grass.jpg');

// --- sample-smooth.jpg: radial gradient ---
const smooth = makeBuffer((x, y) => {
  const d = Math.sqrt((x - 256) ** 2 + (y - 256) ** 2);
  return [
    clamp(Math.round(200 - d * 0.5), 40, 220),
    clamp(Math.round(180 - d * 0.3), 60, 200),
    clamp(Math.round(240 - d * 0.2), 100, 255),
  ];
});
writeFileSync(join(outDir, 'sample-smooth.jpg'), encode(smooth, 85));
console.log('wrote sample-smooth.jpg');

// --- sample-portrait.jpg: geometric shapes ---
const portrait = makeBuffer((x, y) => {
  let r = 30, g = 30, b = 50;

  // concentric rectangles
  for (let i = 1; i <= 8; i++) {
    const margin = i * 28;
    const x0 = margin, y0 = margin, x1 = W - 1 - margin, y1 = H - 1 - margin;
    if ((x === x0 || x === x1) && y >= y0 && y <= y1 ||
        (y === y0 || y === y1) && x >= x0 && x <= x1) {
      const c = 60 + i * 22;
      r = c; g = c; b = c;
    }
  }

  // diagonal lines (4px band)
  if (Math.abs(x - y) < 2) { r = 220; g = 80; b = 80; }
  if (Math.abs(x - (H - 1 - y)) < 2) { r = 80; g = 80; b = 220; }

  // circles
  for (let ci = 0; ci < 5; ci++) {
    const cx = 100 + ci * 80, cy = 256;
    const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
    const radius = 30 + ci * 10;
    if (Math.abs(dist - radius) < 2) {
      r = 80; g = 200; b = 120;
    }
  }

  // filled triangles
  // Triangle 1: vertices (50,400), (150,400), (100,320)
  {
    const ax = 50, ay = 400, bx = 150, by = 400, cx2 = 100, cy2 = 320;
    const d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by);
    const d2 = (x - cx2) * (by - cy2) - (bx - cx2) * (y - cy2);
    const d3 = (x - ax) * (cy2 - ay) - (cx2 - ax) * (y - ay);
    if ((d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0)) {
      r = 200; g = 180; b = 60;
    }
  }
  // Triangle 2: vertices (350,100), (480,180), (380,50)
  {
    const ax = 350, ay = 100, bx = 480, by = 180, cx2 = 380, cy2 = 50;
    const d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by);
    const d2 = (x - cx2) * (by - cy2) - (bx - cx2) * (y - cy2);
    const d3 = (x - ax) * (cy2 - ay) - (cx2 - ax) * (y - ay);
    if ((d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0)) {
      r = 100; g = 60; b = 180;
    }
  }

  return [r, g, b];
});
writeFileSync(join(outDir, 'sample-portrait.jpg'), encode(portrait, 85));
console.log('wrote sample-portrait.jpg');

// --- Placeholder PNGs for docs/ screenshots ---
const docsDir = join(__dirname, '..', 'docs');
mkdirSync(docsDir, { recursive: true });

// Minimal 1×1 transparent PNG (67 bytes)
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAB' +
  'Nl7BcQAAAABJRU5ErkJggg==',
  'base64'
);
for (const name of ['screenshot-panel-a.png', 'screenshot-panel-b-embed.png', 'screenshot-panel-c.png']) {
  writeFileSync(join(docsDir, name), PNG_1x1);
  console.log(`wrote docs/${name}`);
}

console.log('done');
