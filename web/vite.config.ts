/// <reference types="vitest" />
import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  // Relative base so the same build works at https://<user>.github.io/<repo>/ and locally.
  base: './',
  // Stored with each response as client_app_version.
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  build: { target: 'es2019', sourcemap: false },
  test: { environment: 'node' },
});
