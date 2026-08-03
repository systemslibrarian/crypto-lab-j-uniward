import { readFileSync } from 'node:fs';

import { expect, test, type Page } from '@playwright/test';

/**
 * Functional claims gate.
 *
 * The a11y spec proves the page is readable; this one proves it is *true*. Every
 * assertion below is anchored to a number the page itself computed — the NZAC
 * count it printed, the change count in its own status line, the byte budget in
 * its own capacity table — so the suite cannot be satisfied by a hardcoded
 * string, and it fails when the pipeline underneath changes answer.
 *
 * Covers, from the README's own promises:
 *   - Quick Demo → cost map ready → embed → "✓ Embedded via STC" verdict.
 *   - Embedding summary parts summing to the whole (msg + 4 hdr + 16 MAC).
 *   - Three-way steganalysis agreeing with the embed it describes.
 *   - Full embed → download → upload → extract round-trip with integrity check.
 *   - Every failure path: empty inputs, over-capacity, wrong key, tampered
 *     sideband, stripped COM marker, non-JPEG cover.
 *   - Verdicts retiring when the inputs they described change.
 */

const KEY = 'claims-spec-key';

// ─── uncaught page exceptions fail the test ──────────────────────────────────

const pageErrors = new WeakMap<Page, string[]>();

test.beforeEach(({ page }) => {
  const errs: string[] = [];
  pageErrors.set(page, errs);
  page.on('pageerror', (err) => errs.push(err.message));
});

test.afterEach(({ page }) => {
  expect(pageErrors.get(page) ?? [], 'uncaught page exceptions').toEqual([]);
});

// ─── helpers ─────────────────────────────────────────────────────────────────

const num = (s: string): number => Number(s.replace(/,/g, ''));

async function text(page: Page, sel: string): Promise<string> {
  return ((await page.textContent(sel)) ?? '').replace(/\s+/g, ' ').trim();
}

/** Load the bundled sample via Quick Demo and wait for the cost map. */
async function quickDemo(page: Page): Promise<void> {
  await page.goto('.');
  await page.click('#quick-demo-btn');
  await expect(page.locator('#embed-btn')).toBeEnabled({ timeout: 120_000 });
  await expect(page.locator('#image-info')).toContainText('Cost map ready');
}

async function clickEmbed(page: Page): Promise<void> {
  await page.click('#embed-btn');
  await expect(page.locator('#embed-status')).not.toHaveClass(/hidden/, { timeout: 180_000 });
  await expect(page.locator('#embed-btn')).toBeEnabled({ timeout: 180_000 });
}

async function clickExtract(page: Page): Promise<void> {
  await page.click('#extract-btn');
  await expect(page.locator('#extract-btn')).toBeEnabled({ timeout: 180_000 });
  await expect(page.locator('#extract-output')).not.toHaveClass(/hidden/);
}

/** Non-zero AC count the page printed for the loaded cover. */
async function reportedNzac(page: Page): Promise<number> {
  const info = await text(page, '#image-info');
  const m = info.match(/([\d,]+) non-zero ACs/);
  expect(m, `image info should report NZAC: ${info}`).not.toBeNull();
  return num(m![1]);
}

/** Luma block count the page printed for the loaded cover. */
async function reportedBlocks(page: Page): Promise<number> {
  const info = await text(page, '#image-info');
  const m = info.match(/([\d,]+) luma blocks/);
  expect(m, `image info should report luma blocks: ${info}`).not.toBeNull();
  return num(m![1]);
}

/** The Embedding Summary card as a label → value map. */
async function summary(page: Page): Promise<Record<string, string>> {
  return page.$$eval('#embed-summary .summary-item', (items) => {
    const out: Record<string, string> = {};
    for (const item of items) {
      const label = item.querySelector('.summary-label')?.textContent?.trim() ?? '';
      const value = (item.querySelector('.summary-value')?.textContent ?? '').replace(/\s+/g, ' ').trim();
      out[label] = value;
    }
    return out;
  });
}

/**
 * Embed a message end to end and hand back what the page said about it.
 *
 * The bundled samples are small, so the default 0.10 bpnzac budget is only a
 * couple of dozen bytes; raise the rate — using the page's own NZAC figure —
 * until the message fits, exactly as a user would.
 */
async function embedMessage(
  page: Page,
  message: string,
  key = KEY,
): Promise<{ changes: number; status: string }> {
  await page.fill('#msg-input', message);

  const nzac = await reportedNzac(page);
  const needed = Math.ceil(((Buffer.byteLength(message, 'utf8') + 20) * 8 * 100) / nzac) / 100;
  expect(needed, 'test message must fit inside the 0.50 bpnzac ceiling').toBeLessThanOrEqual(0.5);
  if (needed > Number(await page.inputValue('#rate-slider'))) {
    await page.evaluate((r) => {
      const slider = document.getElementById('rate-slider') as HTMLInputElement;
      slider.value = String(r);
      slider.dispatchEvent(new Event('input'));
    }, needed);
  }

  await page.fill('#key-input', key);
  await clickEmbed(page);
  const status = await text(page, '#embed-status');
  const m = status.match(/all ([\d,]+) changes preserved/);
  expect(m, `embed status should report a change count: ${status}`).not.toBeNull();
  return { changes: num(m![1]), status };
}

/** Embed, then download the stego JPEG the page produced. */
async function embedAndDownload(page: Page, message: string, key = KEY): Promise<Buffer> {
  await embedMessage(page, message, key);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#download-btn'),
  ]);
  const path = await download.path();
  expect(path, 'stego download should land on disk').not.toBeNull();
  expect(download.suggestedFilename()).toMatch(/_stego\.jpg$/);
  return readFileSync(path!);
}

async function uploadStego(page: Page, bytes: Buffer, name = 'stego.jpg'): Promise<void> {
  await page.setInputFiles('#extract-file-input', {
    name,
    mimeType: 'image/jpeg',
    buffer: bytes,
  });
}

// ─── 1. Loading: the capacity table is arithmetic on the page's own NZAC ──────

test('the capacity table is consistent with the NZAC count the page reported', async ({ page }) => {
  await quickDemo(page);

  const nzac = await reportedNzac(page);
  expect(nzac).toBeGreaterThan(0);

  const rows = await page.$$eval('#capacity-table tbody tr', (trs) =>
    trs.map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => td.textContent?.trim() ?? '')),
  );
  expect(rows).toHaveLength(3);

  for (const [rateCell, capCell, riskCell] of rows) {
    const rate = Number(rateCell.replace(' bpnzac', ''));
    const cap = num(capCell.replace(' bytes', ''));
    // bpnzac is bits per non-zero AC: capacity = floor(nzac * rate / 8).
    expect(cap, `capacity at ${rate} bpnzac`).toBe(Math.floor((nzac * rate) / 8));
    expect(riskCell).toMatch(/Safe|Moderate|Risky/);
  }

  // Capacity must rise monotonically with the rate.
  const caps = rows.map((r) => num(r[1].replace(' bytes', '')));
  expect(caps[0]).toBeLessThan(caps[1]);
  expect(caps[1]).toBeLessThan(caps[2]);

  // Quick Demo must prefill something the image can actually hold.
  const message = await page.inputValue('#msg-input');
  const rate = Number(await page.inputValue('#rate-slider'));
  const msgBytes = Buffer.byteLength(message, 'utf8');
  expect(msgBytes).toBeGreaterThan(0);
  expect(msgBytes).toBeLessThanOrEqual(Math.floor((nzac * rate) / 8) - 20);
  expect(await text(page, '#byte-count')).toBe(`${msgBytes} bytes`);
  expect(await text(page, '#char-count')).toBe(`${message.length} chars`);
  expect(await page.inputValue('#key-input')).not.toBe('');

  // Suitability is one of the three states the README documents.
  expect(await text(page, '#image-suitability')).toMatch(/Poor carrier|Moderate carrier|Good carrier/);
});

// ─── 2. The embed verdict, summary and analysis describe ONE run ──────────────

test('embed verdict, summary and steganalysis all describe the same run', async ({ page }) => {
  test.setTimeout(240_000);
  await quickDemo(page);

  const nzac = await reportedNzac(page);
  const blocks = await reportedBlocks(page);

  const message = 'Meet at dawn.';
  const { changes, status } = await embedMessage(page, message);

  // Headline verdict — checked against the count the page computed, not a literal.
  expect(status).toContain('✓ Embedded via STC (Viterbi-optimal, h=12)');
  expect(status).toContain('Round-trip OK');
  expect(status).not.toContain('unexpected differences');
  expect(changes).toBeGreaterThan(0);
  await expect(page.locator('#embed-status')).toHaveClass(/alert-success/);

  const s = await summary(page);

  // Payload parts sum to the whole: msg + 4-byte header + 16-byte MAC.
  const msgBytes = Buffer.byteLength(message, 'utf8');
  const payload = s['Payload'].match(/^([\d,]+) bytes \(([\d,]+) msg \+ (\d+) hdr \+ (\d+) MAC\)$/);
  expect(payload, `payload cell shape: ${s['Payload']}`).not.toBeNull();
  const [total, msgPart, hdrPart, macPart] = payload!.slice(1).map(num);
  expect(msgPart).toBe(msgBytes);
  expect(hdrPart).toBe(4);
  expect(macPart).toBe(16);
  expect(total).toBe(msgPart + hdrPart + macPart);

  // Carriers used / NZAC: the NZAC figure must match the one printed on load,
  // and a subset relationship must hold both ways.
  const carriers = s['Carriers used'].match(/^([\d,]+) \/ ([\d,]+) NZAC$/);
  expect(carriers, `carriers cell shape: ${s['Carriers used']}`).not.toBeNull();
  const carriersUsed = num(carriers![1]);
  expect(num(carriers![2])).toBe(nzac);
  expect(carriersUsed).toBeGreaterThan(0);

  // Changes are a subset of the carriers that were read, and the status line and
  // the summary card must not disagree about how many there were.
  const summaryChanges = num(s['Coefficients changed']);
  expect(summaryChanges).toBe(changes);
  expect(summaryChanges).toBeLessThanOrEqual(carriersUsed);

  // Actual rate is payload bits per non-zero AC — recompute it from the two
  // other numbers the page printed.
  const actualRate = Number(s['Actual rate'].replace(' bpnzac', ''));
  expect(actualRate).toBeCloseTo((total * 8) / nzac, 3);
  expect(actualRate).toBeLessThanOrEqual(Number(await page.inputValue('#rate-slider')) + 1e-9);

  expect(s['Total distortion']).toMatch(/^\d+(\.\d+)?$/);
  expect(s['Metadata']).toContain('COM marker');

  // Visual comparison is present and the diff label reflects the low rate.
  await expect(page.locator('#post-embed')).not.toHaveClass(/hidden/);
  await expect(page.locator('#download-btn')).toBeVisible();
  expect(await text(page, '#diff-label')).toContain('10× amplified');

  // ── Steganalysis panel describes the same run ──
  const stats = await text(page, '#stats-container');
  await expect(page.locator('#analysis-explainer')).toHaveClass(/hidden/);

  const rows = await page.$$eval('.analysis-bars .bar-row', (els) =>
    els.map((el) => ({
      label: el.querySelector('.bar-label')?.textContent?.trim() ?? '',
      value: el.querySelector('.bar-value')?.textContent?.trim() ?? '',
      badge: el.querySelector('.bar-badge')?.textContent?.trim() ?? '',
      width: (el.querySelector('.bar-fill') as HTMLElement | null)?.style.width ?? '',
    })),
  );
  expect(rows.map((r) => r.label)).toEqual(['LSB', 'F5', 'J-UNIWARD']);
  for (const row of rows) {
    expect(row.badge, `${row.label} label`).toMatch(/Resistant|Moderate|Detectable|Negligible/);
    if (row.badge !== 'Negligible') {
      const pct = Number(row.value.replace('%', ''));
      expect(pct, `${row.label} exposure`).toBeGreaterThanOrEqual(0);
      expect(pct, `${row.label} exposure`).toBeLessThanOrEqual(100);
      // The rendered bar width must match the number printed beside it.
      expect(Math.round(parseFloat(row.width)), `${row.label} bar width`)
        .toBe(Math.round(Math.max(2, Math.min(100, pct))));
    }
  }

  // README: "It never touches DC or flat regions" for J-UNIWARD, and LSB is the
  // one a first-order detector flags.
  expect(stats).toContain('0 — structure preserved');
  expect(rows[2].badge).not.toBe('Detectable');
  expect(rows[0].badge).toBe('Detectable');

  // The active method's counter agrees with the embed, and the denominator is
  // the full AC pool: 63 AC coefficients per luma block.
  const changed = stats.match(/Coefficients changed ([\d,]+) \/ ([\d,]+)/);
  expect(changed, `stats should print a change ratio: ${stats}`).not.toBeNull();
  expect(num(changed![1])).toBe(changes);
  expect(num(changed![2])).toBe(blocks * 63);

  expect(await text(page, '#changes-legend')).toContain('J-UNIWARD changes');

  // Switching method repaints the panel for that method rather than leaving the
  // previous method's copy behind.
  await page.click('.method-tab[data-method="lsb"]');
  await expect(page.locator('#stats-container')).toContainText('LSB (spatial)');
  expect(await text(page, '#changes-legend')).toContain('LSB changes');
  const lsbStats = await text(page, '#stats-container');
  const lsbChanged = lsbStats.match(/Coefficients changed ([\d,]+) \/ ([\d,]+)/);
  expect(num(lsbChanged![2])).toBe(blocks * 63);
  expect(num(lsbChanged![1])).toBeGreaterThan(0);
});

// ─── 3. Round-trip: extract recovers exactly what was embedded ────────────────

test('extract recovers exactly the message that was embedded', async ({ page }) => {
  test.setTimeout(240_000);
  await quickDemo(page);

  const message = 'Recover me exactly.';
  await embedMessage(page, message);

  await page.click('#tab-extract');
  await page.fill('#extract-key-input', KEY);
  await clickExtract(page);

  await expect(page.locator('#extract-output')).toHaveClass(/alert-success/);
  expect(await page.textContent('#extract-output .extract-msg')).toBe(message);
  expect(await text(page, '#extract-output')).toContain(
    `✓ Recovered (${Buffer.byteLength(message, 'utf8')} bytes)`,
  );
});

// ─── 4. README's headline claim: embed → download → upload → extract ──────────

test('a downloaded stego JPEG round-trips back through upload and extraction', async ({ page }) => {
  test.setTimeout(300_000);
  await quickDemo(page);

  const message = 'Sideband survives.';
  const stego = await embedAndDownload(page, message);
  expect(stego.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  // COM marker (FFFE) carrying salt + rate + length sits right after SOI.
  expect(stego.subarray(2, 4)).toEqual(Buffer.from([0xff, 0xfe]));

  // Fresh page — nothing in memory, so this exercises the sideband alone.
  await page.goto('.');
  await page.click('#tab-extract');
  await page.fill('#extract-key-input', KEY);
  await uploadStego(page, stego);
  await clickExtract(page);

  await expect(page.locator('#extract-output')).toHaveClass(/alert-success/);
  expect(await page.textContent('#extract-output .extract-msg')).toBe(message);
});

// ─── 5. Failure paths — each must reach failure AND name the cause ────────────

test('empty message and empty key are refused by name', async ({ page }) => {
  await quickDemo(page);

  await page.fill('#msg-input', '');
  await page.click('#embed-btn');
  await expect(page.locator('#embed-status')).toHaveClass(/alert-error/);
  expect(await text(page, '#embed-status')).toBe('Message cannot be empty.');
  await expect(page.locator('#embed-summary')).toHaveClass(/hidden/);

  await page.fill('#msg-input', 'has a message now');
  await page.fill('#key-input', '');
  await page.click('#embed-btn');
  await expect(page.locator('#embed-status')).toHaveClass(/alert-error/);
  expect(await text(page, '#embed-status')).toBe('Key cannot be empty.');
  await expect(page.locator('#embed-summary')).toHaveClass(/hidden/);

  // The control is still alive after both refusals.
  await expect(page.locator('#embed-btn')).toBeEnabled();

  await page.click('#tab-extract');
  await page.fill('#extract-key-input', '  ');
  await page.click('#extract-btn');
  expect(await text(page, '#extract-output')).toBe('Key cannot be empty.');
  await expect(page.locator('#extract-btn')).toBeEnabled();
});

/**
 * Regression: the capacity banner is an *error*, but Embed used to run anyway —
 * the STC pool is every AC coefficient, not just the non-zero ones, so an
 * over-capacity message embedded fine and simply blew past the requested
 * bpnzac. Two surfaces, one run, opposite answers.
 */
test('an over-capacity message is refused, and the refusal quotes the same budget as the banner', async ({ page }) => {
  await quickDemo(page);

  const nzac = await reportedNzac(page);
  const rate = Number(await page.inputValue('#rate-slider'));
  const capacity = Math.floor((nzac * rate) / 8) - 20;
  expect(capacity).toBeGreaterThan(0);

  const tooBig = 'x'.repeat(capacity + 50);
  await page.fill('#msg-input', tooBig);
  await page.fill('#key-input', KEY);

  const banner = await text(page, '#capacity-warn');
  expect(banner).toContain(`${capacity} bytes`);
  await expect(page.locator('#capacity-warn')).toHaveClass(/alert-error/);

  await page.click('#embed-btn');
  await expect(page.locator('#embed-btn')).toBeEnabled();
  await expect(page.locator('#embed-status')).toHaveClass(/alert-error/);

  const status = await text(page, '#embed-status');
  expect(status).toContain(`${tooBig.length} bytes`);
  expect(status).toContain(`capacity at ${rate.toFixed(2)} bpnzac is ${capacity} bytes`);

  // Nothing was produced, so nothing may be shown.
  await expect(page.locator('#embed-summary')).toHaveClass(/hidden/);
  await expect(page.locator('#post-embed')).toHaveClass(/hidden/);

  // Raising the rate until the message fits makes the very same message embed.
  const neededRate = Math.ceil(((tooBig.length + 20) * 8 * 100) / nzac) / 100;
  expect(neededRate).toBeLessThanOrEqual(0.5);
  await page.evaluate((r) => {
    const slider = document.getElementById('rate-slider') as HTMLInputElement;
    slider.value = String(r);
    slider.dispatchEvent(new Event('input'));
  }, neededRate);
  await clickEmbed(page);
  expect(await text(page, '#embed-status')).toContain('✓ Embedded via STC');
});

test('the wrong key fails extraction and says why', async ({ page }) => {
  test.setTimeout(240_000);
  await quickDemo(page);
  await embedMessage(page, 'Only for the key holder.');

  await page.click('#tab-extract');
  await page.fill('#extract-key-input', 'not-the-key');
  await clickExtract(page);

  const out = await text(page, '#extract-output');
  await expect(page.locator('#extract-output')).toHaveClass(/alert-error/);
  expect(out).toMatch(/^Extraction failed: /);
  // The cause is named, and named once — the banner used to stutter the prefix.
  expect(out.match(/Extraction failed:/g)).toHaveLength(1);
  expect(out).toMatch(/HMAC|header|corrupt/i);
  expect(out).not.toContain('Only for the key holder');

  // Retrying with the right key still works — the control is not left dead.
  await page.fill('#extract-key-input', KEY);
  await clickExtract(page);
  expect(await page.textContent('#extract-output .extract-msg')).toBe('Only for the key holder.');
});

test('a tampered stego JPEG fails the integrity check and says why', async ({ page }) => {
  test.setTimeout(300_000);
  await quickDemo(page);
  const stego = await embedAndDownload(page, 'Integrity matters.');

  // Flip a bit inside the 16-byte salt carried in the COM marker (offset 6).
  const tampered = Buffer.from(stego);
  tampered[8] ^= 0x5a;

  await page.goto('.');
  await page.click('#tab-extract');
  await page.fill('#extract-key-input', KEY);
  await uploadStego(page, tampered, 'tampered.jpg');
  await clickExtract(page);

  const out = await text(page, '#extract-output');
  await expect(page.locator('#extract-output')).toHaveClass(/alert-error/);
  expect(out).toMatch(/^Extraction failed: /);
  expect(out).toMatch(/HMAC|header|corrupt|invalid/i);
  expect(out).not.toContain('Integrity matters');

  // The untampered original still extracts on the same page — proving the
  // failure was the tamper and not the upload path.
  await uploadStego(page, stego);
  await clickExtract(page);
  expect(await page.textContent('#extract-output .extract-msg')).toBe('Integrity matters.');
});

test('a stego JPEG stripped of its COM sideband reports the missing parameters', async ({ page }) => {
  test.setTimeout(300_000);
  await quickDemo(page);
  const stego = await embedAndDownload(page, 'Sideband stripped.');

  // Drop the 28-byte COM segment that sits immediately after SOI.
  const stripped = Buffer.concat([stego.subarray(0, 2), stego.subarray(30)]);
  expect(stripped.subarray(2, 4)).not.toEqual(Buffer.from([0xff, 0xfe]));

  await page.goto('.');
  await page.click('#tab-extract');
  await page.fill('#extract-key-input', KEY);
  await uploadStego(page, stripped, 'no-com.jpg');
  await clickExtract(page);

  await expect(page.locator('#extract-output')).toHaveClass(/alert-error/);
  expect(await text(page, '#extract-output')).toBe(
    'Could not read embedding parameters. Ensure this is a valid stego file.',
  );
});

test('extracting with nothing loaded, and uploading a non-JPEG, both name the cause', async ({ page }) => {
  await page.goto('.');

  await page.click('#tab-extract');
  await page.fill('#extract-key-input', KEY);
  await clickExtract(page);
  expect(await text(page, '#extract-output')).toBe(
    'No stego JPEG loaded. Embed first or upload a stego JPEG.',
  );

  // A file that is not a JPEG at all is rejected at the extract input by name…
  await page.setInputFiles('#extract-file-input', {
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('this is not a jpeg'),
  });
  await clickExtract(page);
  const out = await text(page, '#extract-output');
  await expect(page.locator('#extract-output')).toHaveClass(/alert-error/);
  expect(out).toMatch(/could not be decoded as a JPEG|Failed to load stego JPEG/);

  // …and so is a non-JPEG cover on the dropzone.
  await page.click('#tab-embed');
  await page.setInputFiles('#file-input', {
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('this is not a jpeg'),
  });
  await expect(page.locator('#image-info')).toContainText('Please upload a JPEG');
  await expect(page.locator('#embed-btn')).toBeDisabled();
});

// ─── 6. Verdicts must not outlive the inputs they described ───────────────────

/**
 * Regression: the "✓ Embedded" banner, the summary card, the cover/stego
 * comparison and the whole steganalysis panel used to survive an edit to the
 * message, key or rate — and because Extract preferred the in-memory stego, it
 * kept recovering the *old* message while the textarea showed a new one.
 */
for (const [name, mutate] of [
  ['the message is edited', async (page: Page) => page.fill('#msg-input', 'a different secret entirely')],
  ['the key is edited', async (page: Page) => page.fill('#key-input', 'a-different-key')],
  ['the rate slider moves', async (page: Page) =>
    page.evaluate(() => {
      const slider = document.getElementById('rate-slider') as HTMLInputElement;
      slider.value = '0.40';
      slider.dispatchEvent(new Event('input'));
    })],
  ['the analysis payload slider moves', async (page: Page) =>
    page.evaluate(() => {
      const slider = document.getElementById('analysis-payload-slider') as HTMLInputElement;
      slider.value = '0.30';
      slider.dispatchEvent(new Event('input'));
    })],
] as const) {
  test(`the embed verdict retires when ${name}`, async ({ page }) => {
    test.setTimeout(240_000);
    await quickDemo(page);
    const secret = 'Original secret.';
    await embedMessage(page, secret);
    expect(await text(page, '#embed-status')).toContain('✓ Embedded via STC');

    await mutate(page);

    const status = await text(page, '#embed-status');
    expect(status).not.toContain('✓ Embedded via STC');
    expect(status).not.toContain('changes preserved');
    expect(status).toContain('Inputs changed since the last embed');
    await expect(page.locator('#embed-status')).not.toHaveClass(/alert-success/);

    // Every panel derived from that run is gone with it.
    await expect(page.locator('#embed-summary')).toHaveClass(/hidden/);
    await expect(page.locator('#post-embed')).toHaveClass(/hidden/);
    await expect(page.locator('#analysis-explainer')).not.toHaveClass(/hidden/);
    expect(await text(page, '#stats-container')).toContain('Load an image and embed a message');

    // And the retired stego can no longer be extracted as if it were current.
    await page.click('#tab-extract');
    await page.fill('#extract-key-input', KEY);
    await clickExtract(page);
    const out = await text(page, '#extract-output');
    expect(out).not.toContain(secret);
    expect(out).toContain('No stego JPEG loaded');

    // Re-embedding after the edit works — nothing was left dead.
    await page.click('#tab-embed');
    await embedMessage(page, 'Second run.');
    expect(await text(page, '#embed-status')).toContain('✓ Embedded via STC');
  });
}

test('loading a different cover retires the previous embed', async ({ page }) => {
  test.setTimeout(300_000);
  await quickDemo(page);
  await embedMessage(page, 'First cover.');
  await expect(page.locator('#post-embed')).not.toHaveClass(/hidden/);

  // Quick Demo cycles to the next bundled sample.
  await page.click('#quick-demo-btn');
  await expect(page.locator('#embed-btn')).toBeEnabled({ timeout: 120_000 });
  await expect(page.locator('#image-info')).toContainText('Cost map ready');

  await expect(page.locator('#post-embed')).toHaveClass(/hidden/);
  await expect(page.locator('#embed-summary')).toHaveClass(/hidden/);
  expect(await text(page, '#embed-status')).not.toContain('✓ Embedded via STC');
  await expect(page.locator('#analysis-explainer')).not.toHaveClass(/hidden/);
});

/**
 * Regression: an explicitly chosen file used to lose to whatever was still in
 * memory, so uploading stego B after embedding A extracted A.
 */
test('an uploaded stego file wins over the embed still held in memory', async ({ page }) => {
  test.setTimeout(300_000);
  await quickDemo(page);
  const first = await embedAndDownload(page, 'The uploaded one.');

  await page.goto('.');
  await page.click('#quick-demo-btn');
  await expect(page.locator('#embed-btn')).toBeEnabled({ timeout: 120_000 });
  await embedMessage(page, 'The in-memory one.');

  await page.click('#tab-extract');
  await page.fill('#extract-key-input', KEY);
  await uploadStego(page, first);
  await clickExtract(page);

  expect(await page.textContent('#extract-output .extract-msg')).toBe('The uploaded one.');
});

// ─── 7. Controls stay alive ──────────────────────────────────────────────────

test('reset clears the session and the page still works afterwards', async ({ page }) => {
  test.setTimeout(300_000);
  await quickDemo(page);
  await embedMessage(page, 'Before reset.');

  await page.click('#reset-btn');
  await expect(page.locator('#embed-status')).toHaveClass(/hidden/);
  await expect(page.locator('#embed-summary')).toHaveClass(/hidden/);
  await expect(page.locator('#post-embed')).toHaveClass(/hidden/);
  expect(await page.inputValue('#msg-input')).toBe('');
  expect(await page.inputValue('#key-input')).toBe('');
  expect(await page.inputValue('#rate-slider')).toBe('0.1');
  expect(await text(page, '#rate-display')).toBe('0.10 bpnzac');

  // The cover survives a reset, so embedding again needs no reload.
  await expect(page.locator('#embed-btn')).toBeEnabled();
  await embedMessage(page, 'After reset.');
  await page.click('#tab-extract');
  await page.fill('#extract-key-input', KEY);
  await clickExtract(page);
  expect(await page.textContent('#extract-output .extract-msg')).toBe('After reset.');
});

test('the embed button keeps its shipped label across runs', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('.');
  const label = (await text(page, '#embed-btn'));
  expect(label).toContain('J-UNIWARD');

  await page.click('#quick-demo-btn');
  await expect(page.locator('#embed-btn')).toBeEnabled({ timeout: 120_000 });
  await embedMessage(page, 'Label check.');
  expect(await text(page, '#embed-btn')).toBe(label);
  expect(await text(page, '#extract-btn')).toContain('Extract');
});
