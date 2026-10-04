import { config } from 'dotenv';
import { defineConfig, devices } from '@playwright/test';
config({ path: '.env', quiet: true });
const appUrl = process.env['TEST_APP_DATABASE_URL'];
const identityUrl = process.env['TEST_IDENTITY_DATABASE_URL'];
if (!appUrl || !identityUrl) throw new Error('E2E requires dedicated test database URLs');
const principalIds = [
  '30000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000002',
  '30000000-0000-4000-8000-000000000003',
].join(',');
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command:
        'pnpm db:setup:test && pnpm db:seed:test && pnpm --filter @imbox/api exec node dist/main.js',
      url: 'http://127.0.0.1:4110/readyz',
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        APP_ENV: 'test',
        POLICY_LEDGER_DIRECTORY: `${process.cwd()}/.artifacts/e2e-policy-ledger`,
        POLICY_LEDGER_SIGNING_KEY: 'playwright-independent-policy-signing-key-fixture',
        DATABASE_URL: appUrl,
        IDENTITY_DATABASE_URL: identityUrl,
        PUBLIC_ORIGIN: 'http://127.0.0.1:4173',
        API_HOST: '127.0.0.1',
        API_PORT: '4110',
        ENABLE_DEV_AUTH: 'true',
        DEV_AUTH_PRINCIPAL_IDS: principalIds,
        SESSION_SECRET: 'playwright-explicit-test-session-secret-not-for-production',
      },
    },
    {
      command: 'pnpm --filter @imbox/web dev --host 127.0.0.1 --port 4173',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: false,
      timeout: 60_000,
      env: { VITE_ENABLE_DEV_LOGIN: 'true', IMBOX_API_PROXY_TARGET: 'http://127.0.0.1:4110' },
    },
    {
      command: 'pnpm --filter @imbox/worker exec node dist/main.js',
      wait: { stdout: /"event":"worker_ready"/ },
      timeout: 30_000,
      env: { APP_ENV: 'test', POLICY_LEDGER_DIRECTORY: `${process.cwd()}/.artifacts/e2e-policy-ledger`, POLICY_LEDGER_SIGNING_KEY: 'playwright-independent-policy-signing-key-fixture', DATABASE_URL: appUrl, WORKER_TENANT_IDS: '10000000-0000-4000-8000-000000000001', WORKER_POLL_INTERVAL_MS: '25' },
    },
  ],
});
