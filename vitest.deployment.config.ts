import { config } from 'dotenv';
import { defineConfig } from 'vitest/config';
config({ path: '.env', quiet: true });
export default defineConfig({
  test: {
    include: ['tests/deployment/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    restoreMocks: true,
  },
});
