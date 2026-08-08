import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4700',
    headless: true,
  },
  webServer: {
    command: 'npm.cmd run dev -- --port 4700 --strictPort',
    url: 'http://localhost:4700',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
