/**
 * test.ts — zero-dependency correctness suite for the J-UNIWARD core.
 *
 * Bundled with esbuild and run in Node (see `npm test`). Polyfills `window`
 * with jpeg-js so the codec's display-decode path works headless. Exercises the
 * real pipeline: decode → cost map → embed → extract, plus the steganalysis.
 */
import jpegjs from 'jpeg-js';
(globalThis as any).window = { __jpegJs: jpegjs };

import { readFileSync } from 'fs';
import { decode, encode, forwardDCTQuantize } from '../src/codec/JpegCodec.ts';
import { computeCostMatrix, computeCostMatrixSlow } from '../src/steg/WaveletCost.ts';
import { embed, selectCarriers } from '../src/steg/Embedder.ts';
import { extract } from '../src/steg/Extractor.ts';
import { runAnalysis } from '../src/analysis/StegAnalysis.ts';

let passed = 0, failed = 0;
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? `  — ${detail}` : ''}`); }
}

function loadSample(name: string) {
  const buf = readFileSync(`public/samples/${name}`);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  return decode(ab);
}

function correlate(a: Float64Array[], b: Float64Array[]): number {
  const xs: number[] = [], ys: number[] = [];
  for (let bi = 0; bi < a.length; bi++) for (let zi = 1; zi < 64; zi++) {
    const x = a[bi][zi], y = b[bi][zi];
    if (!isFinite(x) || !isFinite(y) || x >= 1e7 || y >= 1e7) continue;
    xs.push(x); ys.push(y);
  }
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n, my = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const p = xs[i] - mx, q = ys[i] - my; num += p * q; dx += p * p; dy += q * q; }
  return num / Math.sqrt(dx * dy);
}

async function main() {
  // ── 1. Forward DCT is the exact inverse of the codec's IDCT ──
  console.log('\nforward DCT / IDCT roundtrip');
  {
    const dec = loadSample('sample-grass.jpg');
    const re = forwardDCTQuantize(dec.lumaPixels, dec.quantTable, dec.lumaBlocksWide, dec.lumaBlocksHigh);
    let diffs = 0;
    for (let bi = 0; bi < re.length; bi++) for (let zi = 0; zi < 64; zi++) if (re[bi][zi] !== dec.dctCoeffs[bi][zi]) diffs++;
    ok('re-encoding decoded luma reproduces coefficients exactly', diffs === 0, `${diffs} differing coeffs`);
  }

  // ── 2. Cost map semantics: smooth regions cost more than textured ones ──
  console.log('\ncost map semantics (synthetic image)');
  {
    const BW = 6, BH = 6, W = BW * 8, H = BH * 8;
    const luma = new Float32Array(W * H);
    // Left half: flat (constant, no texture to hide in). Right half: broadband
    // deterministic noise (rich texture). J-UNIWARD cost should be far lower on the right.
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      luma[y * W + x] = x < W / 2 ? 128 : 128 + (rnd() - 0.5) * 100;
    }
    const quant = new Uint16Array(64).fill(8);
    const costs = await computeCostMatrix(luma, quant, BW, BH);
    // Median block cost, capping wet at a large finite value so flat blocks count.
    const medBlock = (bi: number) => {
      const v: number[] = [];
      for (let zi = 1; zi < 64; zi++) { const c = costs[bi][zi]; v.push(isFinite(c) && c < 1e7 ? c : 1e8); }
      v.sort((a, b) => a - b); return v[v.length >> 1];
    };
    let flat = 0, tex = 0, fn = 0, tn = 0;
    for (let br = 1; br < BH - 1; br++) for (let bc = 0; bc < BW; bc++) { // skip top/bottom edge rows
      const med = medBlock(br * BW + bc);
      if (bc < BW / 2 - 1) { flat += med; fn++; } else if (bc > BW / 2) { tex += med; tn++; }
    }
    flat /= fn; tex /= tn;
    ok('flat blocks cost far more than textured blocks', flat > tex * 5, `flatMed=${flat.toExponential(1)} texMed=${tex.toExponential(1)}`);
  }

  // ── 3. Fast cost map matches the reference implementation (opt-in: SLOW=1) ──
  if (process.env['SLOW']) {
    console.log('\nfast vs reference cost correlation');
    const dec = loadSample('sample-grass.jpg');
    const fast = await computeCostMatrix(dec.lumaPixels, dec.quantTable, dec.lumaBlocksWide, dec.lumaBlocksHigh);
    const slow = await computeCostMatrixSlow(dec.lumaPixels, dec.quantTable, dec.lumaBlocksWide, dec.lumaBlocksHigh);
    ok('correlation > 0.95', correlate(fast, slow) > 0.95, correlate(fast, slow).toFixed(4));
  }

  // ── 4. Embed → extract roundtrip (STC + KDF + HMAC) ──
  console.log('\nembed / extract roundtrip');
  {
    const dec = loadSample('sample-grass.jpg');
    const costs = await computeCostMatrix(dec.lumaPixels, dec.quantTable, dec.lumaBlocksWide, dec.lumaBlocksHigh);
    const message = 'attack at dawn 🌅';
    const key = 'correct horse battery staple';
    const msgLen = new TextEncoder().encode(message).length;
    const res = await embed(dec.dctCoeffs, dec.quantTable, costs, message, key, 0.15);
    ok('embed reports changes and salt', res.changesCount > 0 && res.salt.length === 16);

    const got = await extract(res.modifiedCoeffs, dec.quantTable, costs, key, res.salt, 0.15, msgLen);
    ok('extracted message matches original', got.message === message, `got "${got.message}"`);

    // Wrong key must fail HMAC verification.
    let rejected = false;
    try { await extract(res.modifiedCoeffs, dec.quantTable, costs, 'wrong key', res.salt, 0.15, msgLen); }
    catch { rejected = true; }
    ok('wrong key is rejected by HMAC', rejected);

    // Carrier pool is DC-free.
    ok('carriers never include the DC term', selectCarriers(costs).every(c => c.zzIdx !== 0));
  }

  // ── 4b. FULL JPEG round-trip: the real app path (encode → COM → decode → extract) ──
  console.log('\nfull JPEG round-trip (encode + COM sideband + re-decode)');
  for (const sample of ['sample-grass.jpg', 'sample-portrait.jpg']) {
    const dec = loadSample(sample);
    const buf = readFileSync(`public/samples/${sample}`);
    const origBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    const costs = await computeCostMatrix(dec.lumaPixels, dec.quantTable, dec.lumaBlocksWide, dec.lumaBlocksHigh);
    const message = 'meet at the library, 3pm';
    const key = 'shared-secret-42';
    const rate = 0.12;
    const msgLen = new TextEncoder().encode(message).length;
    const res = await embed(dec.dctCoeffs, dec.quantTable, costs, message, key, rate);

    // Encode stego JPEG + inject COM sideband exactly as the embed panel does.
    const rawStego = new Uint8Array(encode(dec, res.modifiedCoeffs, origBuffer));
    const comPayload = new Uint8Array(24);
    comPayload.set(res.salt, 0);
    const dv = new DataView(comPayload.buffer);
    dv.setFloat32(16, rate, false);
    dv.setUint32(20, msgLen, false);
    const com = new Uint8Array([0xFF, 0xFE, 0x00, 0x1A, ...comPayload]);
    const stego = new Uint8Array(2 + com.length + rawStego.length - 2);
    stego.set(rawStego.subarray(0, 2), 0);
    stego.set(com, 2);
    stego.set(rawStego.subarray(2), 2 + com.length);

    // Re-decode the stego JPEG and recompute costs from the STEGO image (real extract path).
    const sdec = decode(stego.buffer as ArrayBuffer);
    const scosts = await computeCostMatrix(sdec.lumaPixels, sdec.quantTable, sdec.lumaBlocksWide, sdec.lumaBlocksHigh);
    const got = await extract(sdec.dctCoeffs, sdec.quantTable, scosts, key, res.salt, rate, msgLen);
    ok(`${sample}: round-trips through a real JPEG`, got.message === message, `got "${got.message}"`);
  }

  // ── 5. Steganalysis is honest and discriminating ──
  console.log('\nsteganalysis discrimination');
  {
    const dec = loadSample('sample-grass.jpg');
    const costs = await computeCostMatrix(dec.lumaPixels, dec.quantTable, dec.lumaBlocksWide, dec.lumaBlocksHigh);
    const payloadBytes = 60;
    const res = await embed(dec.dctCoeffs, dec.quantTable, costs, 'x'.repeat(payloadBytes - 20), 'k', 0.10);
    const a = runAnalysis(dec.lumaPixels, dec.dctCoeffs, res.modifiedCoeffs, payloadBytes, dec.quantTable, costs, dec.lumaBlocksWide, dec.lumaBlocksHigh);

    ok('LSB corrupts DC/flat coefficients', a.lsb.structHits > 0, `structHits=${a.lsb.structHits}`);
    ok('F5 and J-UNIWARD never touch DC/flat', a.f5.structHits === 0 && a.juniward.structHits === 0);
    ok('J-UNIWARD hides changes better than LSB', a.juniward.meanExposure < a.lsb.meanExposure,
      `ju=${a.juniward.meanExposure.toFixed(3)} lsb=${a.lsb.meanExposure.toFixed(3)}`);
    ok('LSB is labelled Detectable, J-UNIWARD is not', a.lsb.label === 'Detectable' && a.juniward.label !== 'Detectable',
      `lsb=${a.lsb.label} ju=${a.juniward.label}`);
    ok('per-block change map is populated', a.juniward.changedBlocks.some(v => v > 0));
  }

  console.log(`\n${failed === 0 ? '✓ all' : '✗'} ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
