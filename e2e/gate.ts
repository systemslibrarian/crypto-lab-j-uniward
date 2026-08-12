import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { auditContrast, formatContrastFailures } from './contrast';
import { auditNonText, formatNonTextFailures, type NonTextFailure } from './nontext';
import { NONTEXT_BASELINE } from './nontext-baseline';

export const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/** A phone-width viewport, for the WCAG 1.4.10 reflow half of the gate. */
export const NARROW = { width: 380, height: 800 };

/**
 * Shared machinery for the WCAG gate.
 *
 * Three rules govern everything here:
 *
 *  1. NOTHING IS INJECTED INTO THE PAGE BEFORE A SCAN.
 *
 *  2. EVERY SCAN ASSERTS ITS CONTENT IS PRESENT FIRST, and there are scans well
 *     past first paint. axe over an empty container passes having checked
 *     nothing, and at first paint this lab is very nearly empty: no cover
 *     image, no capacity table, no suitability badge, no heatmap toggle, no
 *     cost-probe panel, no embedding summary, no comparison strip, and a
 *     steganalysis panel showing one grey "load an image" sentence where the
 *     three-way exposure bars, the stats grid and the DCT histogram will go.
 *     The headline claim — the same payload, placed three ways, with
 *     J-UNIWARD's changes sitting lowest on the cost terrain — is four
 *     interactions deep, and every colour that carries it (the Resistant /
 *     Moderate / Detectable inks, the badge tints, the F5 shrinkage callout)
 *     exists only in that state.
 *
 *  3. `violations` IS NOT THE WHOLE ORACLE. See `scan`.
 */

/**
 * Wait for every running animation and transition to drain.
 *
 * Transitions drain in waves, not in one batch, so a poll for "nothing running
 * right now" can exit through a gap between waves. Require quiescence to hold
 * for several consecutive frames instead.
 */
export async function settle(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const w = window as unknown as { __quietFrames?: number };
      const running = document.getAnimations().filter((a) => a.playState === 'running');
      w.__quietFrames = running.length === 0 ? (w.__quietFrames ?? 0) + 1 : 0;
      return w.__quietFrames >= 6;
    },
    undefined,
    { timeout: 20_000, polling: 'raf' }
  );
}

/**
 * Assert that reduced motion left the page visible, not merely un-animated.
 *
 * The failure mode this guards against is an element whose only route to its
 * visible state is an animation, in a stylesheet whose reduced-motion block
 * cancels that animation without restoring its end state — the element then
 * renders at `opacity: 0` for every reader with the preference set.
 */
async function expectNotBlank(page: Page, label: string): Promise<void> {
  const invisible = await page.evaluate(() => {
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      const own = Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent ?? '')
        .join('')
        .trim();
      if (!own) continue;
      // Deliberately hidden subtrees are not "blank", they are closed.
      if (!(el as HTMLElement).checkVisibility?.({ checkVisibilityCSS: true })) continue;
      let effective = 1;
      let node: Element | null = el;
      while (node) {
        effective *= parseFloat(getComputedStyle(node).opacity);
        node = node.parentElement;
      }
      if (effective === 0) {
        out.push(`${el.tagName.toLowerCase()}.${(el.getAttribute('class') ?? '').trim()}`);
      }
    }
    return Array.from(new Set(out));
  });
  expect(invisible, `no visible text may render at opacity 0 in state: ${label}`).toEqual([]);
}

/**
 * Load the page in a known theme with reduced motion actually in effect, and
 * assert the content every scan relies on is really on the page.
 *
 * `test.use({ reducedMotion })` silently does nothing on Playwright 1.61.1, so
 * the emulation is applied imperatively BEFORE the navigation and then
 * *asserted* from inside the page.
 */
export async function boot(page: Page, theme: 'dark' | 'light'): Promise<void> {
  // A click on a control that never becomes actionable otherwise burns the
  // whole test timeout and reports nothing useful. 20s turns that silent hang
  // into a named failure naming the locator.
  page.setDefaultTimeout(20_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript((t) => localStorage.setItem('theme', t), theme);
  await page.goto('.');
  expect(
    await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches),
    'reduced-motion emulation must actually be in effect'
  ).toBe(true);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);

  await expect(page.locator('#quick-demo-btn')).toBeVisible();
  await expect(page.locator('#dropzone')).toBeVisible();
  await expect(page.locator('#analysis-explainer')).toBeVisible();
  // The three panels that carry the lab's claims are genuinely empty here, so a
  // scan at this point proves nothing about them — which is the whole reason
  // `driveAllStates` exists.
  await expect(page.locator('#image-info')).toBeEmpty();
  await expect(page.locator('#capacity-table')).toBeEmpty();
  await expect(page.locator('#embed-btn')).toBeDisabled();

  await settle(page);
  await expectNotBlank(page, `${theme} first paint`);
}

/**
 * Assert the page does not require horizontal scrolling.
 *
 * WCAG 1.4.10 (Reflow, AA). axe has no rule for this at all, and this lab is a
 * plausible offender: it lays three panels on a three-column grid, prints a
 * three-column capacity table and a four-column per-subband cost table inside
 * them, draws a 400-unit-wide SVG schematic with a 360px floor, and opens
 * 300px-wide glossary bubbles from hosts anywhere across a panel. The grid
 * tracks are `minmax(0, 1fr)` and the bubbles are clamped in JS precisely so
 * this assertion holds; a bare `1fr` anywhere would put a min-content floor
 * back under a column and break it.
 */
export async function expectNoHorizontalOverflow(page: Page, label: string): Promise<void> {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    if (doc.scrollWidth <= doc.clientWidth) return null;

    // Only elements that actually push the DOCUMENT sideways are culprits. A
    // wide table inside an `overflow-x: auto` wrapper has a huge bounding rect
    // but is clipped by its scroller and contributes nothing to the document's
    // scroll width — naming it sends you off fixing the wrong element. That
    // cost a run elsewhere in this fleet (a 980px table was reported while the
    // real overflow was 15px of something else), and this lab has two such
    // decoys of its own: `#stc-svg` has a 360px floor inside an `overflow-x:
    // auto` stage, and `.hist-canvas` a 240px floor inside `.hist-wrap`.
    const clipped = (el: Element): boolean => {
      let n = el.parentElement;
      while (n && n !== doc) {
        const ox = getComputedStyle(n).overflowX;
        if (ox === 'auto' || ox === 'scroll' || ox === 'hidden' || ox === 'clip') return true;
        n = n.parentElement;
      }
      return false;
    };

    const over = Array.from(document.querySelectorAll('body *'))
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter((x) => x.r.width > 0 && x.r.right > doc.clientWidth + 1)
      .sort((a, b) => b.r.right - a.r.right);
    // Prefer an unclipped culprit; fall back to the widest clipped one rather
    // than reporting nothing, so the message always names something to look at.
    const widest = over.filter((x) => !clipped(x.el))[0] ?? over[0];
    return {
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      widest: widest
        ? `${clipped(widest.el) ? '[clipped] ' : ''}${widest.el.tagName.toLowerCase()}${widest.el.id ? '#' + widest.el.id : ''}` +
          `${widest.el.getAttribute('class') ? '.' + widest.el.getAttribute('class')!.trim().split(/\s+/).join('.') : ''}` +
          ` @${Math.round(widest.r.width)}px right=${Math.round(widest.r.right)}`
        : '(none identified)',
    };
  });
  expect(overflow, `page must not scroll horizontally in state: ${label}`).toBeNull();
}

/**
 * Assert a revealed overlay is wholly on screen and wholly unclipped.
 *
 * Neither axe nor the contrast oracle has anything to say about this, and both
 * are content to measure a box whose right-hand third is not painted. The
 * glossary bubbles were exactly that: `.panel` was `overflow: hidden` and
 * `.panel-body` `overflow-y: auto`, so 94px at desktop and 115px at phone width
 * of every gloss opened inside a panel were cut off. Both clips are gone and
 * `placeBubble` now clamps the offset, so this is the regression guard for it.
 */
export async function expectNotClipped(
  page: Page,
  selector: string,
  label: string
): Promise<void> {
  // Measure the settled frame, the same one `scan` measures — an overlay placed
  // from JS is not necessarily in its final position on the frame it appeared.
  await settle(page);
  const cut = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return `no element matched ${sel}`;
    const b = el.getBoundingClientRect();
    if (b.width <= 0 || b.height <= 0) return `${sel} has an empty box`;
    const out: string[] = [];
    if (b.left < -0.5 || b.right > window.innerWidth + 0.5) {
      out.push(`outside the viewport (${Math.round(b.left)}..${Math.round(b.right)} of ${window.innerWidth})`);
    }
    for (let n = el.parentElement; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (!/auto|scroll|hidden|clip/.test(cs.overflowX + ' ' + cs.overflowY)) continue;
      const c = n.getBoundingClientRect();
      const lost = Math.max(0, c.left - b.left) + Math.max(0, b.right - c.right) +
        Math.max(0, c.top - b.top) + Math.max(0, b.bottom - c.bottom);
      if (lost > 0.5) {
        out.push(
          `${Math.round(lost)}px clipped by ${n.tagName.toLowerCase()}` +
            `${n.id ? '#' + n.id : ''}.${(n.getAttribute('class') ?? '').trim()}`
        );
      }
    }
    return out.length ? out.join('; ') : null;
  }, selector);
  expect(cut, `${selector} must be fully painted in state: ${label}`).toBeNull();
}

/**
 * Every scrolling container must be operable from the keyboard (WCAG 2.1.1).
 * If it holds no focusable content it needs `tabindex="0"`, so it becomes a
 * focus target arrow keys can then scroll.
 */
export async function expectScrollersReachable(page: Page, label: string): Promise<void> {
  const unreachable = await page.evaluate(() => {
    const FOCUSABLE = 'a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])';
    return Array.from(document.querySelectorAll<HTMLElement>('body *'))
      .filter((el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)
      .filter((el) => {
        const cs = getComputedStyle(el);
        return (
          ['auto', 'scroll'].includes(cs.overflowX) || ['auto', 'scroll'].includes(cs.overflowY)
        );
      })
      .filter((el) => el.tabIndex < 0 && !el.querySelector(FOCUSABLE))
      .map(
        (el) =>
          `${el.tagName.toLowerCase()}.${(el.getAttribute('class') ?? '').trim()}` +
          ` (${el.scrollWidth}x${el.scrollHeight} in ${el.clientWidth}x${el.clientHeight})`
      );
  });
  expect(
    Array.from(new Set(unreachable)),
    `scrolling regions with no keyboard route in state: ${label}`
  ).toEqual([]);
}

/**
 * Scan the page as it currently stands.
 *
 * Five assertions, because axe's `violations` array alone is not a complete
 * oracle:
 *
 *  - `violations` — the usual WCAG A/AA rule failures.
 *  - `incomplete` — axe's "could not decide" bucket, which never reaches the
 *    violations array. The one rule id allowed to remain incomplete is
 *    `color-contrast`, and only because the next assertion computes those
 *    ratios arithmetically. Everything else in that bucket is a real result
 *    axe simply could not finish — including `aria-prohibited-attr`, which is
 *    where an `aria-label` on a role-less div hides, a defect that never
 *    reaches the violations array at all.
 *  - arithmetic contrast — composite-aware WCAG 1.4.3 over every text node.
 *  - keyboard reachability of scrolling regions — WCAG 2.1.1.
 *  - reflow — WCAG 1.4.10, which axe has no rule for at all.
 */
/**
 * WCAG 1.4.11 and generated content, ratcheted against a per-repo baseline.
 *
 * Neither class has ANY other oracle: axe has no rule for non-text contrast,
 * and the arithmetic text walk cannot reach a control's boundary or a
 * `::before` glyph, because a pseudo-element is not an element and owns no text
 * node. Both were being found by hand-sampling screenshot pixels, which does
 * not regress-test.
 *
 * The backlog is real, so this does not block on it — but a check that merely
 * logs is not a gate, and this sweep has spent its whole length deleting checks
 * that could not fail. So it ratchets instead: anything NOT in the baseline
 * fails, anything in the baseline that got WORSE fails, and anything in the
 * baseline that has been FIXED fails until its entry is deleted. That last rule
 * is what stops the allowlist becoming a permanent exemption.
 */
const nonTextSeen = new Set<string>();

export async function expectNoNewNonTextFailures(page: Page, label: string): Promise<void> {
  const found = await auditNonText(page);
  // Capture mode: emit every finding and assert nothing, so a baseline can be
  // generated by the SAME path that checks it. Opt-in via env, and the run is
  // deliberately left failing at the end by `expectBaselineNotStale` so a
  // capture pass can never be mistaken for a passing gate.
  if (process.env.NT_BASELINE_CAPTURE) {
    for (const f of found) {
      console.log(`NTCAP|${f.kind}|${f.selector}|${f.ratio}|${f.required}|${/POSITIONED/.test(f.detail)}`);
    }
    return;
  }
  const problems: string[] = [];
  for (const f of found) {
    const key = `${f.kind}|${f.selector}`;
    nonTextSeen.add(key);
    const base = NONTEXT_BASELINE[key];
    if (!base) {
      problems.push(`NEW ${f.ratio}:1 (needs ${f.required}:1) [${f.kind}] ${f.selector} — ${f.detail}`);
    } else if (f.ratio < base.ratio - 0.01) {
      problems.push(
        `WORSE ${f.selector}: ${f.ratio}:1, baseline recorded ${base.ratio}:1`
      );
    }
  }
  expect(problems, `new or worsened non-text contrast in state: ${label}`).toEqual([]);
}

/**
 * Fail if a baselined finding never appeared during the whole drive.
 *
 * It has either been fixed — in which case delete the entry, which is the point
 * — or the drive stopped reaching the state that shows it, which is a coverage
 * regression worth knowing about. Call once, after `driveAllStates`.
 */
export function expectBaselineNotStale(): void {
  const unseen = Object.keys(NONTEXT_BASELINE).filter((k) => !nonTextSeen.has(k));
  expect(
    unseen,
    'baselined non-text findings that no longer appear — delete them from nontext-baseline.ts (or restore the drive state that showed them)'
  ).toEqual([]);
}

export async function scan(page: Page, label: string): Promise<void> {
  await settle(page);
  await expectNotBlank(page, label);
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();

  const violations = results.violations.map((v) => ({
    state: label,
    id: v.id,
    impact: v.impact,
    help: v.help,
    nodes: v.nodes.map((n) => n.target.join(' ')).slice(0, 8),
  }));
  expect(violations, `axe violations in state: ${label}`).toEqual([]);

  const unexplainedIncomplete = results.incomplete
    .filter((v) => v.id !== 'color-contrast')
    .map((v) => ({
      state: label,
      id: v.id,
      nodes: v.nodes.map((n) => n.target.join(' ')).slice(0, 8),
    }));
  expect(unexplainedIncomplete, `axe incomplete results in state: ${label}`).toEqual([]);

  const contrast = Array.from(new Set(formatContrastFailures(await auditContrast(page))));
  expect(contrast, `measured contrast failures in state: ${label}`).toEqual([]);

  await expectNoNewNonTextFailures(page, label);
  await expectScrollersReachable(page, label);
  await expectNoHorizontalOverflow(page, label);
}

/**
 * Drive the lab through the states that render content, scanning each.
 *
 * The lab has one hard prerequisite chain and it is the chain it teaches: no
 * cost map exists until a JPEG is decoded, nothing can be embedded until the
 * cost map is ready, and no steganalysis comparison exists until something has
 * been embedded. `#embed-btn` ships disabled and only `loadImage` enables it,
 * so the "Please load a JPEG image first" branch inside the embed handler is
 * unreachable from the UI — a fact about the source, recorded here so the next
 * reader does not add a click that can only hang.
 *
 * So the drive climbs that chain, and on the way deliberately visits the states
 * that are ONLY reachable off the happy path, because each paints ink no other
 * state paints:
 *
 *   - the two Extract failure branches (`alert-error`) that exist only before
 *     anything has been embedded;
 *   - the capacity banner in both of its guises — `alert-warning` at 80% of
 *     budget and `alert-error` past it — plus the embed refusal it triggers;
 *   - the rate warning above 0.3 bpnzac;
 *   - the stale-verdict `alert-info` branch, which no successful run reaches;
 *   - a second, deliberately smooth sample, whose suitability row renders
 *     `badge-risky` where the textured one renders `badge-safe`;
 *   - each of the three steganalysis methods, because the F5 pane is the only
 *     one carrying the shrinkage callout and the three Detectability inks
 *     (`.resist` / `.moderate` / `.detect`) are separate colours;
 *   - the glossary bubble and the change-exposure tooltip, both of which are
 *     `display: none` until focused.
 *
 * Decoding a JPEG and ranking every coefficient by wavelet cost runs on the
 * main thread, so each stage is awaited on its own completion signal — the
 * "Cost map ready" line, the button leaving its disabled state, the rendered
 * summary — never on a timeout.
 */
export async function driveAllStates(page: Page, theme: string): Promise<void> {
  const scanAt = (s: string): Promise<void> => scan(page, `${theme} / ${s}`);
  // Decode + cost map + STC search are main-thread work well past the 20s
  // default that `boot` sets for ordinary clicks.
  const HEAVY = { timeout: 300_000 };

  await scanAt('first paint');

  // Both skip links park off-screen until focused, so the focused rendering is
  // the only one that paints. The shared header's is first in the tab order.
  await page.locator('a.cl-skip-link').focus();
  await scanAt('shared skip link focused');
  await page.locator('a.skip-link').focus();
  await scanAt('lab skip link focused');

  // ── The glossary bubble ───────────────────────────────────────────────────
  // `.gloss-bubble` is `display: none` until the host is hovered, focused or
  // toggled open, so it is invisible to a first-paint scan.
  const gloss = page.locator('.gloss-inline[data-term="bpnzac"]');
  await gloss.focus();
  await expect(page.locator('.gloss-inline[data-term="bpnzac"] .gloss-bubble')).toBeVisible();
  await expectNotClipped(
    page,
    '.gloss-inline[data-term="bpnzac"] .gloss-bubble',
    `${theme} / glossary bubble open`
  );
  await scanAt('glossary bubble open');
  await gloss.press('Escape');
  await page.locator('#panel-b-heading').click();

  // ── The STC / Viterbi schematic ───────────────────────────────────────────
  // Three steps, three different SVG figures. Step 2 writes its total in
  // `--error-text` and step 3 in `--success-color`, over the same cost-ramp
  // rects — colours that exist nowhere else on the page.
  for (const step of [2, 3] as const) {
    await page.locator('#stc-next').click();
    await expect(page.locator('#stc-step-counter')).toHaveText(`Step ${step} of 3`);
    await expect(page.locator('#stc-step-title')).toContainText(`${step} ·`);
    await scanAt(`STC schematic step ${step}`);
  }
  await page.locator('#stc-next').click();
  await expect(page.locator('#stc-step-counter')).toHaveText('Step 1 of 3');

  // ── Extract, before anything exists to extract ────────────────────────────
  await page.locator('#tab-extract').click();
  await expect(page.locator('#extract-pane')).toHaveClass(/\bactive\b/);
  await scanAt('extract tab, empty');

  await page.locator('#extract-btn').click();
  await expect(page.locator('#extract-output')).toContainText('Key cannot be empty');
  await expect(page.locator('#extract-output')).toHaveClass(/alert-error/);
  await scanAt('extract refused: no key');

  await page.locator('#extract-key-input').fill('gate-key');
  await page.locator('#extract-btn').click();
  await expect(page.locator('#extract-output')).toContainText('No stego JPEG loaded');
  await scanAt('extract refused: nothing embedded');

  await page.locator('#tab-embed').click();
  await expect(page.locator('#embed-pane')).toHaveClass(/\bactive\b/);

  // ── Load the textured sample and build the cost map ───────────────────────
  // Quick Demo is the lab's own front door: it loads a sample and prefills a
  // message and rate that fit inside it.
  await page.locator('#quick-demo-btn').click(HEAVY);
  await expect(page.locator('#embed-btn')).toBeEnabled(HEAVY);
  await expect(page.locator('#image-info')).toContainText('Cost map ready', HEAVY);
  await expect(page.locator('.capacity-table tbody tr')).toHaveCount(3);
  await expect(page.locator('#image-suitability .badge')).toBeVisible();
  await expect(page.locator('#mechanism-panel')).toBeVisible();
  await scanAt('textured sample loaded, cost map ready');

  await page.locator('#heatmap-checkbox').check();
  await expect(page.locator('#heatmap-canvas')).toBeVisible();
  await scanAt('cost heatmap overlaid');

  // ── The cost probe: the panel that opens the black box ────────────────────
  // Reached by keyboard here, which is also the 2.1.1 route for a canvas.
  await page.locator('#cover-canvas').focus();
  await page.locator('#cover-canvas').press('ArrowRight');
  await expect(page.locator('.mech-cost-badge')).toBeVisible();
  await expect(page.locator('.mech-table tbody tr')).toHaveCount(3);
  await scanAt('cost probe on the first block');

  // A second block, several rows down, so the verdict badge is measured on
  // more than one tint. Which of cheap/moderate/costly any given block lands
  // in depends on the image, so the drive asserts a badge rendered rather than
  // asserting a colour it cannot guarantee.
  for (let i = 0; i < 6; i++) await page.locator('#cover-canvas').press('ArrowDown');
  await expect(page.locator('.mech-block-id')).toContainText('row 6');
  await scanAt('cost probe six blocks down');

  // ── The capacity banner, in both guises, and the refusal it drives ────────
  await page.locator('#msg-input').fill('x'.repeat(4000));
  await expect(page.locator('#capacity-warn')).toHaveClass(/alert-error/);
  await expect(page.locator('#capacity-warn')).toContainText('exceeds capacity');
  await scanAt('message over capacity');

  await page.locator('#embed-btn').click();
  await expect(page.locator('#embed-status')).toContainText('Shorten the message');
  await expect(page.locator('#embed-status')).toHaveClass(/alert-error/);
  await scanAt('embed refused: over capacity');

  // ── The aggressive preset, which trips the rate warning ───────────────────
  await page.locator('.preset-btn[data-rate="0.40"]').click();
  await expect(page.locator('.preset-btn[data-rate="0.40"]')).toHaveClass(/\bactive\b/);
  await expect(page.locator('#rate-warning')).toBeVisible();
  await expect(page.locator('#rate-display')).toHaveText('0.40 bpnzac');
  await scanAt('aggressive preset, rate warning shown');

  // ── The real embed ────────────────────────────────────────────────────────
  await page.locator('#msg-input').fill('Hi.');
  await expect(page.locator('#capacity-warn')).toBeHidden();
  await page.locator('#key-input').fill('gate-key');
  await page.locator('#embed-btn').click(HEAVY);
  await expect(page.locator('#embed-btn')).toBeEnabled(HEAVY);
  await expect(page.locator('#embed-status')).toContainText('Embedded via STC', HEAVY);
  await expect(page.locator('#embed-summary')).toBeVisible();
  await expect(page.locator('#post-embed')).toBeVisible();
  await expect(page.locator('#embed-summary .summary-item')).toHaveCount(6);
  // The steganalysis panel replaces its explainer with the real comparison.
  await expect(page.locator('#analysis-explainer')).toBeHidden();
  await expect(page.locator('#stats-container .bar-row')).toHaveCount(3);
  // Detectability, coefficients changed, DC terms hit, costliest-decile changes.
  await expect(page.locator('#stats-container .stat-card')).toHaveCount(4);
  await expect(page.locator('#hist-canvas')).toBeVisible();
  await scanAt('embedded, three-way comparison rendered');

  // The change-exposure gloss only exists once the bars do, and only paints
  // while its trigger has focus.
  const exposure = page.locator('.gloss-inline[data-term="exposure"]');
  await exposure.focus();
  await expect(page.locator('.gloss-inline[data-term="exposure"] .gloss-bubble')).toBeVisible();
  await expectNotClipped(
    page,
    '.gloss-inline[data-term="exposure"] .gloss-bubble',
    `${theme} / change-exposure gloss open`
  );
  await scanAt('change-exposure gloss open');
  await exposure.press('Escape');
  await page.locator('#panel-c-heading').click();

  // ── Each method's pane ────────────────────────────────────────────────────
  // The Detectability ink differs per method (`.resist` / `.moderate` /
  // `.detect`), and only the F5 pane carries the shrinkage callout.
  for (const method of ['lsb', 'f5', 'juniward'] as const) {
    await page.locator(`.method-tab[data-method="${method}"]`).click();
    await expect(page.locator(`.method-tab[data-method="${method}"]`)).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await expect(page.locator('.hist-callout')).toBeVisible();
    await expect(page.locator('#stats-container .stat-value').first()).not.toBeEmpty();
    await scanAt(`steganalysis pane: ${method}`);
  }

  // ── The extract round-trip, and its wrong-key failure ─────────────────────
  await page.locator('#tab-extract').click();
  await page.locator('#extract-key-input').fill('gate-key');
  await page.locator('#extract-btn').click(HEAVY);
  await expect(page.locator('#extract-btn')).toBeEnabled(HEAVY);
  await expect(page.locator('#extract-output')).toHaveClass(/alert-success/);
  await expect(page.locator('.extract-msg')).toHaveText('Hi.');
  await scanAt('message recovered');

  await page.locator('#extract-key-input').fill('wrong-key');
  await page.locator('#extract-btn').click(HEAVY);
  await expect(page.locator('#extract-btn')).toBeEnabled(HEAVY);
  await expect(page.locator('#extract-output')).toHaveClass(/alert-error/);
  await scanAt('extraction failed: wrong key');

  // ── The stale-verdict retirement, which nothing on the happy path shows ───
  await page.locator('#tab-embed').click();
  await page.locator('#msg-input').fill('Hi!');
  await expect(page.locator('#embed-status')).toHaveClass(/alert-info/);
  await expect(page.locator('#embed-status')).toContainText('Inputs changed');
  await expect(page.locator('#embed-summary')).toBeHidden();
  await scanAt('previous embed retired as stale');

  // ── Reset, back to the loaded-but-unembedded state ────────────────────────
  await page.locator('#reset-btn').click();
  await expect(page.locator('#embed-status')).toBeHidden();
  await expect(page.locator('#post-embed')).toBeHidden();
  await expect(page.locator('#analysis-explainer')).toBeVisible();
  await scanAt('session reset');

  // ── The smooth sample: the only route to the "Poor carrier" badge ─────────
  await page.locator('#load-sample').click(HEAVY);
  await expect(page.locator('#embed-btn')).toBeEnabled(HEAVY);
  await expect(page.locator('#sample-label')).toHaveText('Smooth (sunset gradient)');
  await expect(page.locator('#image-suitability .badge')).toBeVisible();
  await scanAt('smooth sample loaded');

  // ── Onboarding dismissed ──────────────────────────────────────────────────
  await page.locator('#dismiss-onboarding').click();
  await expect(page.locator('#onboarding')).toBeHidden();
  await scanAt('onboarding dismissed');
}
