import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    exclude: ['**/*.integration.test.ts', '**/dist/**', '**/node_modules/**'],
    testTimeout: 10_000,
    restoreMocks: true,
    clearMocks: true,
  },
});
