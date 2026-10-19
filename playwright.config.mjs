import { defineConfig, devices } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = process.env.STUDIO_E2E_PORT || '8793';
const DATA = mkdtempSync(join(tmpdir(), 'studio-e2e-'));

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  use: { baseURL: `http://127.0.0.1:${PORT}`, acceptDownloads: true },
  webServer: {
    command: `python3 build.py ${process.env.PALIMPSEST ? '--palimpsest ' + process.env.PALIMPSEST : ''} && python3 server.py`,
    url: `http://127.0.0.1:${PORT}/healthz`,
    env: { PORT, STUDIO_DATA: DATA },
    reuseExistingServer: false,
  },
  projects: [
    { name: 'iphone', use: { ...devices['iPhone 13'] } },
    { name: 'desktop', use: { ...devices['Desktop Safari'] } },
  ],
});
