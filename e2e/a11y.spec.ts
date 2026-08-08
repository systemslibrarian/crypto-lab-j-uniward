import { test } from '@playwright/test';
import { boot, driveAllStates, NARROW } from './gate';

/**
 * WCAG A/AA regression gate.
 *
 * The lab is driven along the chain it teaches: both skip links focused, the
 * glossary bubble opened, all three STC schematic steps drawn, Extract refused
 * twice before anything exists to extract, a textured sample decoded and its
 * cost map built, the heatmap overlaid, two blocks probed by keyboard, the
 * capacity banner tripped into its warning and error forms, the embed refused
 * for being over budget, the aggressive preset's rate warning shown, a real
 * message embedded and the three-way steganalysis comparison rendered, each of
 * the three method panes opened, the message recovered and then failed against
 * a wrong key, the previous verdict retired as stale, the session reset, a
 * deliberately smooth second sample loaded for its "Poor carrier" badge, and
 * the onboarding card dismissed. Every one of those states is scanned, in both
 * themes, at desktop and phone width.
 *
 * See `gate.ts` for why nothing is injected into the page, why each scan
 * asserts its content first, and why `violations` is not the whole oracle.
 */

for (const theme of ['dark', 'light'] as const) {
  test(`no WCAG A/AA violations in ${theme} theme`, async ({ page }) => {
    test.setTimeout(900_000);
    await boot(page, theme);
    await driveAllStates(page, theme);
  });

  test(`no WCAG A/AA violations in ${theme} theme at 380px`, async ({ page }) => {
    test.setTimeout(900_000);
    await page.setViewportSize(NARROW);
    await boot(page, theme);
    await driveAllStates(page, `${theme} @380px`);
  });
}
