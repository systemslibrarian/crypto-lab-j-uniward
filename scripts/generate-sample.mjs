// scripts/generate-sample.mjs
// Generates a synthetic test JPEG with varied texture content
// Used for the demo's default cover image

import jpegjs from 'jpeg-js';
import { writeFileSync, mkdirSync } from 'fs';

const W = 256;
const H = 256;
const data = new Uint8Array(W * H * 4);

for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    let r, g, b;

    const qx = x >> 6; // 0-3
    const qy = y >> 6; // 0-3

    if (qy === 0 && qx === 0) {
      // Quadrant 0: smooth gradient (low wavelet cost → high embedding cost)
      r = x;
      g = y;
      b = (x + y) >> 1;
    } else if (qy === 0 && qx === 1) {
      // Quadrant 1: horizontal stripes
      r = (y & 4) ? 200 : 40;
      g = 100;
      b = 140;
    } else if (qy === 0 && qx === 2) {
      // Quadrant 2: diagonal checkerboard
      r = ((x ^ y) & 8) ? 220 : 30;
      g = ((x ^ y) & 8) ? 30 : 220;
      b = 128;
    } else if (qy === 0 && qx === 3) {
      // Quadrant 3: fine noise (low embedding cost)
      r = ((x * 37 + y * 81) & 255);
      g = ((x * 53 + y * 113) & 255);
      b = ((x * 71 + y * 137) & 255);
    } else if (qy === 1 && qx === 0) {
      // Circular gradient
      const cx = x - 32, cy = y - 96;
      const d = Math.sqrt(cx * cx + cy * cy);
      r = Math.floor(128 + 120 * Math.cos(d / 8));
      g = Math.floor(128 + 120 * Math.sin(d / 8));
      b = Math.floor(128 + 60 * Math.cos(d / 4));
    } else if (qy === 1 && qx === 1) {
      // Medium frequency texture
      r = ((x * 3 + y * 7) & 63) + 96;
      g = ((x * 5 + y * 11) & 63) + 96;
      b = ((x * 7 + y * 13) & 63) + 96;
    } else if (qy === 1 && qx === 2) {
      // Sine wave pattern
      r = Math.floor(128 + 100 * Math.sin((x + y) * Math.PI / 16));
      g = Math.floor(128 + 80 * Math.cos(x * Math.PI / 12));
      b = Math.floor(128 + 80 * Math.sin(y * Math.PI / 12));
    } else if (qy === 1 && qx === 3) {
      // Vertical stripes
      r = (x & 4) ? 180 : 60;
      g = 120;
      b = (x & 8) ? 160 : 80;
    } else if (qy === 2 && qx === 0) {
      // Low-freq sweep
      r = Math.floor(128 + 100 * Math.sin(x * Math.PI / 30));
      g = Math.floor(128 + 100 * Math.sin(y * Math.PI / 30));
      b = 128;
    } else if (qy === 2 && qx === 1) {
      // High contrast edges
      r = ((x - 128) & 16) ? 240 : 20;
      g = ((y - 192) & 16) ? 240 : 20;
      b = 128;
    } else if (qy === 2 && qx === 2) {
      // Fractal-like pattern
      r = ((x * x + y * y) & 255);
      g = ((x * y) & 255);
      b = (((x ^ y) * 7) & 255);
    } else if (qy === 2 && qx === 3) {
      // Gradient + noise
      r = Math.min(255, x + ((x * 127 + y * 91) & 31));
      g = Math.min(255, y + ((x * 109 + y * 73) & 31));
      b = 128;
    } else if (qy === 3 && qx === 0) {
      // Smooth vertical gradient
      r = y - 192;
      g = y - 192;
      b = y - 192;
    } else if (qy === 3 && qx === 1) {
      // Fine horizontal stripes
      r = (y & 2) ? 200 : 50;
      g = (y & 2) ? 50 : 200;
      b = 128;
    } else if (qy === 3 && qx === 2) {
      // Dense noise (ideal for steganography)
      r = ((x * 173 + y * 233 + x * y) & 255);
      g = ((x * 197 + y * 251 + (x ^ y) * 13) & 255);
      b = ((x * 211 + y * 239 + (x + y) * 17) & 255);
    } else {
      // Block pattern
      r = ((x >> 3) & 1) ^ ((y >> 3) & 1) ? 210 : 40;
      g = r;
      b = 128;
    }

    data[i]     = Math.max(0, Math.min(255, r));
    data[i + 1] = Math.max(0, Math.min(255, g));
    data[i + 2] = Math.max(0, Math.min(255, b));
    data[i + 3] = 255;
  }
}

mkdirSync('public/assets', { recursive: true });
const jpeg = jpegjs.encode({ data, width: W, height: H }, 85);
writeFileSync('public/assets/sample.jpg', jpeg.data);
console.log(`Generated public/assets/sample.jpg (${jpeg.data.byteLength} bytes)`);
