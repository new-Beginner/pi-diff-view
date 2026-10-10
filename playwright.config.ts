import { defineConfig } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
const scratch = process.env.PI_SCRATCH_DIR || path.join(os.tmpdir(), 'pi-diff-view-e2e');
export default defineConfig({
  testDir: './tests/e2e', testMatch: '**/*.spec.ts', fullyParallel: false, workers: 1,
  timeout: 30000, expect: { timeout: 8000 }, reporter: 'list',
  outputDir: path.join(scratch, 'playwright-results'),
  use: { baseURL: 'http://127.0.0.1:8787', viewport: { width: 1280, height: 800 }, trace: 'retain-on-failure', screenshot: 'only-on-failure', browserName: 'chromium', launchOptions: process.env.E2E_BROWSER ? { executablePath: process.env.E2E_BROWSER } : {} },
  webServer: { command: 'node scripts/serve-e2e.mjs', url: 'http://127.0.0.1:8787', reuseExistingServer: !process.env.CI, timeout: 10000 }
});
