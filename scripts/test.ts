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
import { embed, selectCarriers, countNZAC, capacityBytes, usableCapacityBytes } from '../src/steg/Embedder.ts';
import { extract } from '../src/steg/Extractor.ts';
import { runAnalysis } from '../src/analysis/StegAnalysis.ts';
import { stcEmbedWithMatrix } from '../src/stc.ts';

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

  // ── 3. Fast cost map IS the literal definition ──
  //
  // computeCostMatrix evaluates UNIWARD Eq. 3 in closed form; computeCostMatrixSlow
  // evaluates it by brute force (perturb pixels by q·B_kl, re-run the undecimated
  // transform, sum |ΔW|/(σ+|W_cover|)). Because the transform is undecimated it is
  // shift-invariant, and because both the filter bank and the DCT basis are outer
  // products the ripple separates per axis — so the two are equal to floating
  // point, at the image boundary as well as inside. Anything worse than ~1e-9
  // means the closed form has drifted from the definition.
  {
    console.log('\nclosed-form cost == literal definition');
    // Deterministic 12×12-block image: flat left half, broadband texture right.
    const BW = 12, BH = 12, W = BW * 8, H = BH * 8;
    const luma = new Float32Array(W * H);
    let seed = 987654321;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++)
      luma[y * W + x] = x < W / 2 ? 128 + (rnd() - 0.5) * 2 : 128 + (rnd() - 0.5) * 120;
    const quant = new Uint16Array(64).fill(8);

    const fast = await computeCostMatrix(luma, quant, BW, BH);
    const slow = await computeCostMatrixSlow(luma, quant, BW, BH);

    let maxRel = 0, worst = '';
    for (let bi = 0; bi < fast.length; bi++) for (let zi = 1; zi < 64; zi++) {
      const f = fast[bi][zi], s = slow[bi][zi];
      const rel = Math.abs(f - s) / Math.max(Math.abs(s), 1e-12);
      if (rel > maxRel) { maxRel = rel; worst = `block ${bi} zz ${zi}: ${f} vs ${s}`; }
    }
    ok('closed form matches brute force to 1e-9 (all blocks, incl. edges)',
      maxRel < 1e-9, `max relative error ${maxRel.toExponential(2)} — ${worst}`);
    ok('costs correlate perfectly with the reference', correlate(fast, slow) > 0.999999,
      correlate(fast, slow).toFixed(9));
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

    const got = await extract(res.modifiedCoeffs, key, res.salt, 0.15, msgLen);
    ok('extracted message matches original', got.message === message, `got "${got.message}"`);

    // Wrong key must fail HMAC verification.
    let rejected = false;
    try { await extract(res.modifiedCoeffs, 'wrong key', res.salt, 0.15, msgLen); }
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

    // Re-decode the stego JPEG (real extract path — no cost map needed).
    const sdec = decode(stego.buffer as ArrayBuffer);
    const got = await extract(sdec.dctCoeffs, key, res.salt, rate, msgLen);
    ok(`${sample}: round-trips through a real JPEG`, got.message === message, `got "${got.message}"`);
  }

  // ── 4c. A truncated entropy stream fails closed instead of hanging ──
  //
  // `BitReader.readBits` loops `while (nBits < n) loadByte()`, and `loadByte`
  // used to return without adding bits once the segment was exhausted — an
  // unbounded spin on a truncated scan. In the app `decode()` calls jpeg-js
  // first and jpeg-js rejects truncated files, so nothing reached it; that is a
  // guard in another library, not an invariant of this parser. This test drops
  // the jpeg-js polyfill so the parser is reached directly, which is the only
  // way to exercise it.
  //
  // NOTE: before the fix this test does not fail, it HANGS — that is the defect.
  console.log('\ntruncated entropy data fails closed');
  {
    const raw = readFileSync('public/samples/sample-grass.jpg');
    const held = (globalThis as any).window;
    (globalThis as any).window = {}; // no __jpegJs → straight into parseJpeg
    let threw = '', decoded = false;
    try {
      const cut = raw.subarray(0, raw.length - 1200);
      decode(cut.buffer.slice(cut.byteOffset, cut.byteOffset + cut.byteLength) as ArrayBuffer);
      decoded = true;
    } catch (e) { threw = (e as Error).message; }
    (globalThis as any).window = held;
    ok('a truncated scan throws rather than spinning', !decoded && /Truncated|marker|Invalid|entropy/i.test(threw),
      threw || 'decoded a truncated file without complaint');

    // …and the intact file still decodes, so the bound did not break valid input.
    const dec = loadSample('sample-grass.jpg');
    ok('the intact sample still decodes after the bound was added', dec.blockCount > 0);
  }

  // ── 4d. A rank-deficient parity-check matrix fails closed, not silently wrong ──
  //
  // buildHatMatrix rejection-samples non-zero columns, but non-zero columns can
  // still fail to span GF(2)^12. When they do, some syndromes are unreachable —
  // the block's forward cost stays INF — and the traceback used to read default
  // (zero) predecessor entries and return a change vector encoding the WRONG
  // message: extraction would then reject the correct key with no explanation.
  // stcEmbedWithMatrix now checks reachability before traceback and asserts the
  // produced stego syndrome equals the requested one. Exercise both directly.
  console.log('\nrank-deficient STC matrix fails closed');
  {
    const H = 12, w = 24;
    const cover = new Uint8Array(w);      // all-zero cover LSBs
    const rho = new Float64Array(w).fill(1);

    // Deficient: every column is the same single bit, so only syndromes 0 and 1
    // are reachable. A message whose 12-bit target sets any higher bit cannot be
    // encoded and must throw rather than fabricate a change vector.
    const deficient = new Uint32Array(w).fill(1);
    const msgUnreachable = new Uint8Array(H);
    msgUnreachable[1] = 1; // target = 0b10 = 2, unreachable from {0,1}
    let threw = false;
    try { stcEmbedWithMatrix(deficient, cover, rho, msgUnreachable); }
    catch { threw = true; }
    ok('an unreachable syndrome throws instead of returning a wrong change vector', threw);

    // Full-rank: columns cycle through all 12 basis vectors, so every syndrome is
    // reachable. The internal postcondition asserts the stego syndrome equals the
    // target, so a clean return is itself the proof of correctness.
    const fullRank = new Uint32Array(w);
    for (let i = 0; i < w; i++) fullRank[i] = 1 << (i % H);
    const msg = new Uint8Array([1, 0, 1, 1, 0, 0, 1, 0, 0, 1, 1, 0]);
    let okEmbed = false;
    try {
      const { d } = stcEmbedWithMatrix(fullRank, cover, rho, msg);
      // Recompute the stego syndrome independently and compare to the target.
      let syn = 0;
      for (let i = 0; i < w; i++) if ((cover[i] ^ d[i]) & 1) syn ^= fullRank[i];
      let target = 0;
      for (let r = 0; r < H; r++) target |= (msg[r] << r);
      okEmbed = syn === target;
    } catch { /* leaves okEmbed false */ }
    ok('a full-rank matrix encodes exactly the requested syndrome', okEmbed);
  }

  // ── 5. Steganalysis reports what it measured ──
  //
  // What this block used to assert, and why each one was worthless:
  //
  //   'F5 and J-UNIWARD never touch DC/flat'  — could not fail. `structHits`
  //     counts DC edits plus AC costs at or above 1e7; WaveletCost gives DC 1e8
  //     and every AC a finite cost whose maximum across the bundled covers is
  //     1.1e5, so for any DCT-domain method the counter is pinned at 0 by
  //     construction. The test was proving the loop bounds, not the placement.
  //
  //   'J-UNIWARD hides changes better than LSB' — true on this one cover at this
  //     one rate, false elsewhere (on sample-grass at 0.20 bpnzac and above, LSB's
  //     per-change mean is the lower of the two). It pinned a claim the page then
  //     printed unconditionally.
  //
  // The replacements below assert the invariants instead: that the counter which
  // used to carry the "flat" caption genuinely cannot see flat placement, that
  // the counter which replaced it genuinely can, and that no fixed winner exists.
  console.log('\nsteganalysis reports what it measured');
  {
    const dec = loadSample('sample-grass.jpg');
    const costs = await computeCostMatrix(dec.lumaPixels, dec.quantTable, dec.lumaBlocksWide, dec.lumaBlocksHigh);
    const payloadBytes = 60;
    const res = await embed(dec.dctCoeffs, dec.quantTable, costs, 'x'.repeat(payloadBytes - 20), 'k', 0.10);
    const a = runAnalysis(dec.lumaPixels, dec.dctCoeffs, res.modifiedCoeffs, payloadBytes, dec.quantTable, costs, dec.lumaBlocksWide, dec.lumaBlocksHigh);

    ok('LSB corrupts the DC term on this cover', a.lsb.structHits > 0, `structHits=${a.lsb.structHits}`);
    ok('per-block change map is populated', a.juniward.changedBlocks.some(v => v > 0));

    // structHits cannot report a flat-region hit, so nothing may caption it as one.
    let maxAC = -Infinity, acCount = 0, atOrOverWet = 0;
    for (const b of costs) for (let zi = 1; zi < 64; zi++) {
      const c = b[zi]; acCount++;
      if (!isFinite(c) || c >= 1e7) atOrOverWet++; else if (c > maxAC) maxAC = c;
    }
    ok('no AC coefficient reaches the wet threshold structHits tests, so it is a DC counter only',
      atOrOverWet === 0 && maxAC < 1e7,
      `${atOrOverWet} of ${acCount} ACs >= 1e7, max AC cost ${maxAC.toExponential(2)}`);

    // No fixed winner: F5 only edits non-zero ACs, which are already the cheap
    // ones, so on the default cover at the default rate its per-change mean is
    // BELOW J-UNIWARD's. Measured 12/12 keyed runs at every rate 0.10-0.50.
    ok('F5 beats J-UNIWARD on per-change exposure here — no method may be declared the winner up front',
      a.f5.bitsEmbedded === a.f5.bitsRequested && a.f5.meanExposure < a.juniward.meanExposure,
      `f5=${a.f5.meanExposure.toFixed(3)} ju=${a.juniward.meanExposure.toFixed(3)}`);
    ok('J-UNIWARD still makes far fewer changes and less total distortion at this rate',
      a.juniward.changesCount < a.f5.changesCount && a.juniward.totalDistortion < a.f5.totalDistortion,
      `ju ${a.juniward.changesCount} chg / ${a.juniward.totalDistortion.toExponential(2)}, ` +
      `f5 ${a.f5.changesCount} chg / ${a.f5.totalDistortion.toExponential(2)}`);
  }

  // ── 5b. F5 silently under-embeds on a low-NZAC cover ──
  console.log('\nunequal-payload detection');
  {
    const dec = loadSample('sample-smooth.jpg');
    const costs = await computeCostMatrix(dec.lumaPixels, dec.quantTable, dec.lumaBlocksWide, dec.lumaBlocksHigh);
    const nzac = countNZAC(dec.dctCoeffs);
    const cap = usableCapacityBytes(nzac, 0.40);
    ok('the smooth cover can hold a message at 0.40 bpnzac', cap > 0, `capacity ${cap} bytes`);
    // …and holds none at the shipped 0.10 default — the state that used to print
    // "13 bytes / Safe" in the table and "(-7 bytes at current rate)" in the banner.
    ok('the smooth cover holds nothing at the 0.10 default, and capacity never goes negative',
      usableCapacityBytes(nzac, 0.10) === 0 && capacityBytes(nzac, 0.10) - 20 < 0,
      `usable=${usableCapacityBytes(nzac, 0.10)} raw=${capacityBytes(nzac, 0.10) - 20}`);

    const res = await embed(dec.dctCoeffs, dec.quantTable, costs, 'x'.repeat(cap), 'k', 0.40);
    const a = runAnalysis(dec.lumaPixels, dec.dctCoeffs, res.modifiedCoeffs, cap + 20, dec.quantTable, costs, dec.lumaBlocksWide, dec.lumaBlocksHigh);
    ok('F5 runs out of non-zero ACs here and carries less than the requested payload',
      a.f5.bitsEmbedded < a.f5.bitsRequested,
      `f5 carried ${a.f5.bitsEmbedded} of ${a.f5.bitsRequested} bits`);
    ok('J-UNIWARD carried the whole payload it was measured on',
      a.juniward.bitsEmbedded === a.juniward.bitsRequested);
    ok('the short method is the one with the lower exposure — ranking it would be wrong',
      a.f5.meanExposure < a.juniward.meanExposure,
      `f5=${a.f5.meanExposure.toFixed(3)} (short) ju=${a.juniward.meanExposure.toFixed(3)}`);
    ok('carriers examined never exceed the AC pool they are counted against',
      res.carriersUsed <= res.carrierPool, `${res.carriersUsed} / ${res.carrierPool}`);
  }

  // ── 5c. The costliest-decile counter is live, not decorative ──
  //
  // This is the counter that replaced the unfalsifiable "flat coefficients hit"
  // claim, so it has to be shown capable of firing. It is genuinely rare — the
  // salt is fresh per embed, so the permutation and therefore the placement move
  // — measured at 6 of 12 keyed runs on sample-grass at 0.50 bpnzac and 0 of 12
  // at 0.40 and below. The loop therefore FAILS if it never fires: a silent zero
  // would mean the counter is dead again.
  console.log('\ncostliest-decile placement actually occurs');
  {
    const dec = loadSample('sample-grass.jpg');
    const costs = await computeCostMatrix(dec.lumaPixels, dec.quantTable, dec.lumaBlocksWide, dec.lumaBlocksHigh);
    const nzac = countNZAC(dec.dctCoeffs);
    const cap = usableCapacityBytes(nzac, 0.50);
    const N = 10;
    let fired = 0, totalTop = 0, maxSeen = 0;
    const means: number[] = [];
    for (let i = 0; i < N; i++) {
      const res = await embed(dec.dctCoeffs, dec.quantTable, costs, 'x'.repeat(cap), `key-${i}`, 0.50);
      const a = runAnalysis(dec.lumaPixels, dec.dctCoeffs, res.modifiedCoeffs, cap + 20, dec.quantTable, costs, dec.lumaBlocksWide, dec.lumaBlocksHigh);
      if (a.juniward.topDecileChanges > 0) fired++;
      totalTop += a.juniward.topDecileChanges;
      maxSeen = Math.max(maxSeen, a.juniward.maxExposure);
      means.push(a.juniward.meanExposure);
    }
    ok('J-UNIWARD does place changes in the costliest decile at 0.50 bpnzac',
      fired > 0 && totalTop > 0,
      `fired in ${fired}/${N} runs, ${totalTop} such changes, worst percentile ${(maxSeen * 100).toFixed(1)}%`);
    ok('"it never touches flat regions" is false at this rate', maxSeen > 0.9,
      `worst placement ${(maxSeen * 100).toFixed(1)}th percentile`);

    // Exposure must climb with the payload — the replacement for the removed
    // "recommended rate ≤ 0.3" assertion, which named a threshold nothing computed.
    const sweep: number[] = [];
    for (const r of [0.10, 0.20, 0.30, 0.40, 0.50]) {
      const c2 = usableCapacityBytes(nzac, r);
      const res = await embed(dec.dctCoeffs, dec.quantTable, costs, 'x'.repeat(c2), 'sweep', r);
      const a = runAnalysis(dec.lumaPixels, dec.dctCoeffs, res.modifiedCoeffs, c2 + 20, dec.quantTable, costs, dec.lumaBlocksWide, dec.lumaBlocksHigh);
      sweep.push(a.juniward.meanExposure);
    }
    ok('mean exposure rises monotonically with the payload rate',
      sweep.every((v, i) => i === 0 || v > sweep[i - 1]),
      sweep.map(v => (v * 100).toFixed(1) + '%').join(' → '));
    void means;
  }

  console.log(`\n${failed === 0 ? '✓ all' : '✗'} ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
