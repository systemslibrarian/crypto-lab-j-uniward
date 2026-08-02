import { defineConfig, devices } from '@playwright/test';

// Default port is fixed so CI stays deterministic; E2E_PORT lets a local run
// step around a port another lab's preview server already holds.
const PORT = Number(process.env.E2E_PORT ?? 4220);
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
    command: `npm run preview -- --port ${PORT} --strictPort`,
    port: PORT,
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
});
