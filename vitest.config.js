import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./src/tests/setup.js'],
    testTimeout: 30_000,     // allow time for MongoMemoryServer + bcrypt
    hookTimeout: 60_000,     // allow time for MongoMemoryServer startup
    coverage: {
      provider: 'v8',
      // Only enforce 100% coverage on the pure pricing engine
      include: ['src/lib/pricing.js'],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
});
