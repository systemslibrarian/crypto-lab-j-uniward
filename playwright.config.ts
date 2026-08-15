import { defineConfig, devices } from '@playwright/test';

// Default port is fixed so CI stays deterministic, and must be unique across
// the crypto-lab fleet: `reuseExistingServer` will adopt whatever is already
// listening, so two labs sharing a port means one silently scans the other's
// page. 4220 collided with crypto-lab-hybrid-pqc. E2E_PORT remains as a local
// escape hatch, but it is not the fix — a committed collision is.
const PORT = Number(process.env.E2E_PORT ?? 4607);
const BASE = '/crypto-lab-j-uniward/';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${PORT}${BASE}`,
    colorScheme: 'dark',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    // Build before serving. `preview` only serves whatever is already in
    // dist/; without the build in front, a failing build leaves the previous
    // good bundle on disk and the suite passes green against code that no
    // longer compiles — silently invalidating mutation checks.
    command: `npm run build && npm run preview -- --port ${PORT} --strictPort`,
    port: PORT,
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
});
