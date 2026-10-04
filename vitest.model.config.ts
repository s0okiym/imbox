import { config } from 'dotenv';
import { defineConfig } from 'vitest/config';
config({ path: '.env', quiet: true });
export default defineConfig({
  test: {
    include: ['tests/model/**/*.test.ts'],
    testTimeout: 150_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
