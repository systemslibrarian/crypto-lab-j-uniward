import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * WCAG regression gate. Scans the full page with every collapsible / tab pane
 * revealed, in both the dark (default) and light themes. Modeled on the ascon
 * lab gate. This page has no <details>; instead it uses class-toggled tab
 * panes (.tab-pane.active) and pill tab groups — reveal them all so hidden
 * content is measured too.
 */

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function revealAll(page: Page): Promise<void> {
  // Neutralize animations/transitions/opacity so nothing is mid-fade when axe
  // measures contrast.
  await page.addStyleTag({
    content: `*, *::before, *::after {
      animation: none !important;
      transition: none !important;
      opacity: 1 !important;
    }`,
  });
  await page.evaluate(() => {
    // Open every native <details> (none today, but future-proof).
    for (const details of Array.from(document.querySelectorAll('details'))) {
      (details as HTMLDetailsElement).open = true;
    }
    // Reveal [hidden] and inline display:none content.
    for (const el of Array.from(document.querySelectorAll('[hidden]'))) {
      el.removeAttribute('hidden');
    }
    for (const el of Array.from(
      document.querySelectorAll<HTMLElement>('[style*="display: none"], [style*="display:none"]'),
    )) {
      el.style.display = '';
    }
    // Reveal every class-toggled tab pane so the hidden Extract pane is scanned.
    for (const pane of Array.from(document.querySelectorAll<HTMLElement>('.tab-pane'))) {
      pane.classList.add('active');
    }
    // Reveal utility-hidden regions (progress bars, warnings, post-embed, etc.)
    // so their text/borders are contrast-checked.
    for (const el of Array.from(document.querySelectorAll('.hidden'))) {
      el.classList.remove('hidden');
    }
  });
}

async function scan(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const summary = results.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    help: v.help,
    nodes: v.nodes.map((n) => n.target.join(' ')).slice(0, 5),
  }));
  expect(summary).toEqual([]);
}

test('no WCAG A/AA violations in dark theme', async ({ page }) => {
  await page.goto('.');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await revealAll(page);
  await scan(page);
});

test('no WCAG A/AA violations in light theme', async ({ page }) => {
  await page.goto('.');
  await page.locator('#cl-theme-toggle').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await revealAll(page);
  await scan(page);
});
