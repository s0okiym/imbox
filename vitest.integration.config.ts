import { config } from 'dotenv';
import { defineConfig } from 'vitest/config';

config({ path: '.env', quiet: true });

export default defineConfig({
  test: {
    include: ['packages/**/*.integration.test.ts', 'tests/integration/**/*.test.ts'],
    exclude: ['**/dist/**', '**/node_modules/**'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    restoreMocks: true,
  },
});
