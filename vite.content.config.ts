import { defineConfig } from 'vite';

// Content scripts are classic scripts (no `import`), so each one is built as a
// single IIFE into dist/ after the main build. IIFE allows one entry per build:
//   vite build -c vite.content.config.ts --mode slack   → dist/slack-content.js
//   vite build -c vite.content.config.ts --mode page    → dist/page-content.js
//   vite build -c vite.content.config.ts --mode translator → dist/translator-content.js
const ENTRIES = {
  slack: { entry: 'src/features/slack/content/index.ts', file: 'slack-content.js', name: 'ContextKitSlack' },
  translator: { entry: 'src/features/translator/content/index.ts', file: 'translator-content.js', name: 'ContextKitTranslator' },
  page: { entry: 'src/features/web-to-md/content/send-selection.ts', file: 'page-content.js', name: 'ContextKitPage' },
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
      minify: false,
      lib: { entry: target.entry, formats: ['iife'], name: target.name, fileName: () => target.file },
    },
  };
});
