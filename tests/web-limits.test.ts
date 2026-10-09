import { describe, expect, it } from 'vitest';
import { checkMarkdown, MAX_MARKDOWN_CHARS } from '../src/features/web-to-md/background/limits';
import { inlineBlobImages } from '../src/features/web-to-md/content/send-selection';

describe('markdown cap (web-capture)', () => {
  it('accepts normal markdown, rejects missing or oversized', () => {
    expect(checkMarkdown('# hi')).toBeNull();
    expect(checkMarkdown(undefined)).toMatch(/Invalid/);
    expect(checkMarkdown({})).toMatch(/Invalid/);
    expect(checkMarkdown('x'.repeat(MAX_MARKDOWN_CHARS + 1))).toMatch(/too large/);
  });
});

describe('inlineBlobImages (send-selection)', () => {
  /** Fake blob: responses; `declared` sets Content-Length, `streamed` counts bytes read. */
  function fakeFetch(files: Record<string, { size: number; type?: string; declared?: boolean }>) {
    const read: Record<string, number> = {};
    const fetchFn = (async (url: string) => {
      const f = files[url]!;
      read[url] = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(ctrl) {
          const left = f.size - read[url]!;
          if (left <= 0) return ctrl.close();
          const n = Math.min(1024, left);
          read[url]! += n;
          ctrl.enqueue(new Uint8Array(n));
        },
      });
      const headers: Record<string, string> = { 'Content-Type': f.type ?? 'image/png' };
      if (f.declared) headers['Content-Length'] = String(f.size);
      return new Response(body, { headers });
    }) as unknown as typeof fetch;
    return { fetchFn, read };
  }
  const toDataUrl = async (b: Blob) => `data:${b.type};len=${b.size}`;
  const html = (...urls: string[]) => urls.map((u) => `<img src="${u}">`).join('');

  it('skips an image whose declared size is too big without reading it', async () => {
    const { fetchFn, read } = fakeFetch({ 'blob:a': { size: 5000, declared: true } });
    const out = await inlineBlobImages(html('blob:a'), { fetchFn, toDataUrl, maxEach: 1000 });
    expect(out).toContain('src="blob:a"');
    expect(read['blob:a']).toBeLessThanOrEqual(1024); // at most the stream's first prefetched chunk
  });

  it('stops reading an undeclared body as soon as it exceeds the cap', async () => {
    const { fetchFn, read } = fakeFetch({ 'blob:a': { size: 100_000 } });
    const out = await inlineBlobImages(html('blob:a'), { fetchFn, toDataUrl, maxEach: 2000 });
    expect(out).toContain('src="blob:a"');
    expect(read['blob:a']).toBeLessThan(10_000);
  });

  it('enforces a total budget across images and skips non-images', async () => {
    const { fetchFn } = fakeFetch({
      'blob:a': { size: 600 },
      'blob:b': { size: 600 },
      'blob:c': { size: 300 },
      'blob:t': { size: 10, type: 'text/html' },
    });
    const out = await inlineBlobImages(html('blob:a', 'blob:b', 'blob:c', 'blob:t'), {
      fetchFn,
      toDataUrl,
      maxEach: 1000,
      maxTotal: 1000,
    });
    expect(out).toContain('src="data:image/png;len=600"'); // a
    expect(out).toContain('src="blob:b"'); // would exceed the total
    expect(out).toContain('src="data:image/png;len=300"'); // c still fits
    expect(out).toContain('src="blob:t"');
  });
});
