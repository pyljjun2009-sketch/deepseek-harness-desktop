import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['tests/**/*.test.ts'], exclude: ['.inspect-*/**', 'node_modules/**', 'release/**'] }
});
