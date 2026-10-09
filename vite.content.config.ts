import { defineConfig } from 'vite';

// Content scripts are classic scripts (no `import`), so each one is built as a
// single IIFE into dist/ after the main build. IIFE allows one entry per build:
//   vite build -c vite.content.config.ts --mode all-frames → dist/content.js (widgets style themselves in Shadow DOM)
//   vite build -c vite.content.config.ts --mode slack      → dist/slack-content.js
const ENTRIES = {
  'all-frames': { entry: 'src/content/all-frames.ts', file: 'content', name: 'ContextKitContent' },
  slack: { entry: 'src/features/slack/content/index.ts', file: 'slack-content', name: 'ContextKitSlack' },
} as const;

export default defineConfig(({ mode }) => {
  const target = ENTRIES[mode as keyof typeof ENTRIES];
  if (!target) throw new Error(`Unknown content script "${mode}" (use --mode ${Object.keys(ENTRIES).join('|')})`);
  return {
    publicDir: false,
    build: {
      outDir: 'dist',
      emptyOutDir: false,
      target: 'es2022',
      // Watch scripts pass `--minify false` for readable output.
      minify: true,
      lib: {
        entry: target.entry,
        formats: ['iife'],
        name: target.name,
        fileName: () => `${target.file}.js`,
        cssFileName: target.file,
      },
    },
  };
});
