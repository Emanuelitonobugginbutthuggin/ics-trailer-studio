import { defineConfig } from 'vitest/config';

// Relative base so the same build works on GitHub Pages
// (https://<user>.github.io/ics-trailer-studio/) and from any local server.
export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  test: { include: ['tests/unit/**/*.test.ts'] },
});
