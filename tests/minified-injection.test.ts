// @vitest-environment happy-dom
// Functions run in pages through chrome.scripting.executeScript are serialized
// with Function.prototype.toString(). Production builds are minified, so check
// that the MINIFIED functions still work standalone (no leaked helpers such as
// keepNames' __name()).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build, type Rolldown } from 'vite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { pageSlackApi as PageSlackApiFn } from '../src/features/slack/core/slack-client';
import type { extractInPage as ExtractFn } from '../src/features/web-to-md/core/extract';

let dir: string;
let minified: { pageSlackApi: typeof PageSlackApiFn; extractInPage: typeof ExtractFn };

const revive = <T>(fn: T): T => new Function(`return (${String(fn)});`)() as T;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'context-kit-min-'));
  const entry = join(dir, 'entry.ts');
  writeFileSync(
    entry,
    `export { pageSlackApi } from ${JSON.stringify(resolve('src/features/slack/core/slack-client.ts'))};
     export { extractInPage } from ${JSON.stringify(resolve('src/features/web-to-md/core/extract.ts'))};`,
  );
  const out = (await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: true,
      target: 'es2022',
      lib: { entry, formats: ['iife'], name: 'Bundle', fileName: 'bundle' },
    },
  })) as Rolldown.RolldownOutput[];
  minified = new Function(`${out[0]!.output[0].code}; return Bundle;`)();
}, 30_000);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe('minified page-injected functions', () => {
  it('pageSlackApi works after serialization', async () => {
    const store: Record<string, string> = {
      localConfig_v2: JSON.stringify({
        teams: { T01: { id: 'T01', name: 'P', domain: 'papay', url: 'https://papay.slack.com/', token: 'xoxc-1' } },
      }),
    };
    vi.stubGlobal('window', { localStorage: { getItem: (k: string) => store[k] ?? null } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })));
    const res = await revive(minified.pageSlackApi)({ domain: 'papay', method: 'auth.test', params: {} });
    expect(res.ok && res.result.ok).toBe(true);
    vi.unstubAllGlobals();
  });

  it('extractInPage works after serialization', () => {
    document.head.innerHTML = '<title>Doc</title>';
    document.body.innerHTML = '<nav>menu</nav><main><h1>Docs</h1><p>Body text</p></main>';
    const r = revive(minified.extractInPage)('article');
    expect(r.html).toContain('Body text');
    expect(r.html).not.toContain('menu');
    const score = revive(minified.extractInPage)('article', 'score');
    expect(score.html).toBe('');
    expect(score.textLen).toBe(r.textLen);
  });
});
