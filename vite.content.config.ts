import { defineConfig } from 'vite';

// Content scripts are classic scripts (no `import`), so the Slack content
// script is built separately as a single IIFE into dist/ (after the main build).
export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'es2022',
    minify: false,
    lib: {
      entry: 'src/slack/content/index.ts',
      formats: ['iife'],
      name: 'ContextKitSlack',
      fileName: () => 'slack-content.js',
    },
  },
});
