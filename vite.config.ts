import { defineConfig } from 'vitest/config';

export default defineConfig({
  // public/ (manifest, icons) is copied verbatim into dist/. Content scripts
  // are built separately as IIFEs by vite.content.config.ts.
  publicDir: 'public',
  build: {
    outDir: 'dist',
    // Watch mode rebuilds next to the content-script watchers: don't wipe their output.
    emptyOutDir: !process.argv.includes('--watch'),
    target: 'es2022',
    // Page-injected functions (pageSlackApi, extractInPage) are serialized via
    // Function.prototype.toString(); tests/minified-injection.test.ts checks the
    // minified versions still run standalone. Watch scripts pass `--minify false`.
    minify: true,
    modulePreload: false,
    rollupOptions: {
      input: {
        popup: 'src/popup/index.html',
        'translator-popup': 'src/features/translator/popup/popup.html',
        'web-to-md-popup': 'src/features/web-to-md/popup/popup.html',
        'slack-popup': 'src/features/slack/popup/popup.html',
        offscreen: 'src/offscreen/offscreen.html',
        'devdy-popup': 'src/features/devdy/popup/popup.html',
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
