import { defineConfig } from '@playwright/test';
import base from './playwright.config.js';
const servers = base.webServer;
if (!Array.isArray(servers))
  throw new Error('Compatibility requires the standard application servers');
export default defineConfig({
  ...base,
  testDir: './tests/compatibility',
  webServer: [
    ...servers.map((server, index) =>
      index === 1 ? { ...server, command: 'node scripts/compatibility-web-server.mjs' } : server,
    ),
    {
      command: 'node scripts/start-historical-api.mjs',
      url: 'http://127.0.0.1:4111/readyz',
      timeout: 60_000,
      reuseExistingServer: false,
      env: { ...servers[0]!.env, API_PORT: '4111' },
    },
  ],
  timeout: 60_000,
  use: { ...base.use, serviceWorkers: 'block' },
});
