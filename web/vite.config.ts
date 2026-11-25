/// <reference types="vitest" />
import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the same build works at https://<user>.github.io/<repo>/ and locally.
  base: './',
  build: { target: 'es2019', sourcemap: false },
  test: { environment: 'node' },
});
