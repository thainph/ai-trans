import { defineConfig } from 'vitest/config';

export default defineConfig({
  // public/ (manifest, icons, translator/*, web-to-md/*) is copied verbatim into dist/.
  // Translator + Web→MD are plain classic scripts, so they are not bundled.
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    // Keep output readable: the page-injected function is serialized via
    // Function.prototype.toString(), so predictable output helps debugging.
    minify: false,
    modulePreload: false,
    rollupOptions: {
      input: {
        popup: 'src/popup/index.html',
        'slack-popup': 'src/slack/popup/popup.html',
        offscreen: 'src/offscreen/offscreen.html',
        background: 'src/background/index.ts',
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Deterministic local-time formatting in tests
    env: { TZ: 'Asia/Tokyo' },
  },
});
