import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { ByteBudget, isPrecompressedPath } from '../src/features/slack/core/attachments';
import { fetchImage } from '../src/offscreen/image-fetch';
import { isPrivateHost, isPublicHttpUrl, isSameOrigin } from '../src/offscreen/url-safety';
import { ZipWriter } from '../src/offscreen/zip-stream';

describe('image URL safety', () => {
  it.each([
    'http://127.0.0.1/a.png',
    'http://127.1.2.3/a.png',
    'http://0x7f.1/a.png', // normalized to 127.0.0.1 by the URL parser
    'http://2130706433/a.png', // decimal 127.0.0.1
    'http://10.0.0.5/a.png',
    'http://172.16.0.1/a.png',
    'http://172.31.255.255/a.png',
    'http://192.168.1.1/a.png',
    'http://169.254.169.254/latest/meta-data',
    'http://0.0.0.0/a.png',
    'http://[::1]/a.png',
    'http://[::]/a.png',
    'http://[fc00::1]/a.png',
    'http://[fd12:3456::1]/a.png',
    'http://[fe80::1]/a.png',
    'http://[::ffff:127.0.0.1]/a.png',
    'http://[::ffff:192.168.0.1]/a.png',
    'http://localhost/a.png',
    'http://LOCALHOST./a.png',
    'http://foo.localhost/a.png',
    'http://printer.local/a.png',
    'http://intranet/a.png',
    'https://user:pass@example.com/a.png',
    'ftp://example.com/a.png',
    'file:///etc/passwd',
    'not a url',
  ])('rejects %s', (url) => {
    expect(isPublicHttpUrl(url)).toBe(false);
  });

  it.each([
    'https://example.com/a.png',
    'http://8.8.8.8/a.png',
    'http://172.32.0.1/a.png',
    'http://192.169.0.1/a.png',
    'http://[2001:db8::1]/a.png',
    'https://cdn.example.co.jp/x.jpg',
  ])('accepts %s', (url) => {
    expect(isPublicHttpUrl(url)).toBe(true);
  });

  it('host checks', () => {
    expect(isPrivateHost('[fe80::abcd]')).toBe(true);
    expect(isPrivateHost('example.com')).toBe(false);
  });

  it('sends cookies only to the exact origin of the page', () => {
    expect(isSameOrigin('https://www.example.com/a.png', 'https://www.example.com/post')).toBe(true);
    // Subdomains / shared hosting suffixes never share cookies here.
    expect(isSameOrigin('https://img.example.com/a.png', 'https://www.example.com/post')).toBe(false);
    expect(isSameOrigin('https://alice.github.io/a.png', 'https://bob.github.io/post')).toBe(false);
    expect(isSameOrigin('http://www.example.com/a.png', 'https://www.example.com/post')).toBe(false);
    expect(isSameOrigin('https://www.example.com:8443/a.png', 'https://www.example.com/post')).toBe(false);
    expect(isSameOrigin('https://www.example.com/a.png', undefined)).toBe(false);
  });
});

describe('ByteBudget', () => {
  it('reserves before fetching so parallel downloads cannot overshoot', async () => {
    const budget = new ByteBudget(100);
    const a = await budget.reserve(60, true);
    expect(a).toBe(60);
    // Second known-size file: does not fit while the first is in flight → waits for it.
    const pending = budget.reserve(60, true);
    let b: number | null | undefined;
    void pending.then((v) => {
      b = v;
    });
    await Promise.resolve();
    expect(b).toBeUndefined();
    budget.settle(60, 30); // first one turned out smaller
    expect(await pending).toBe(60);
    expect(budget.remaining).toBe(10);
  });

  it('unknown sizes get what is left; nothing left → null', async () => {
    const budget = new ByteBudget(100);
    const a = await budget.reserve(70, false);
    budget.settle(a!, 70);
    expect(await budget.reserve(50, false)).toBe(30);
    budget.settle(30, 30);
    expect(await budget.reserve(50, false)).toBeNull();
    expect(await budget.reserve(1, true)).toBeNull();
  });

  it('concurrent reservations never exceed the total', async () => {
    const budget = new ByteBudget(100);
    let inFlight = 0;
    let peak = 0;
    // Each "download" uses its whole grant: in-flight bytes must stay ≤ 100.
    const grants = await Promise.all(
      [1, 2, 3, 4].map(async () => {
        const g = await budget.reserve(40, false);
        if (g === null) return 0;
        inFlight += g;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight -= g;
        budget.settle(g, g);
        return g;
      }),
    );
    expect(peak).toBeLessThanOrEqual(100);
    expect(grants.reduce((s, g) => s + g, 0)).toBe(100); // 40 + 40 + 20, then nothing left
  });
});

describe('streaming zip', () => {
  it('adds files as they arrive, stores precompressed ones, deflates the rest', async () => {
    expect(isPrecompressedPath('attachments/01-a.PNG')).toBe(true);
    expect(isPrecompressedPath('attachments/02-b.pdf')).toBe(true);
    expect(isPrecompressedPath('attachments/03-log.txt')).toBe(false);

    const text = 'hello '.repeat(1000);
    const zip = new ZipWriter();
    zip.add('attachments/02-log.txt', new TextEncoder().encode(text)); // arrival order
    zip.add('attachments/01-a.png', new Uint8Array([1, 2, 3, 4]));
    expect(zip.count).toBe(2);
    expect(() => zip.add('attachments/01-a.png', new Uint8Array([0]))).toThrow(/duplicate/);
    const blob = zip.finish([{ path: 'thread.md', text: '# Thread' }]);
    expect(blob.type).toBe('application/zip');
    const out = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    expect(Object.keys(out)).toEqual(['attachments/02-log.txt', 'attachments/01-a.png', 'thread.md']);
    expect(new TextDecoder().decode(out['thread.md'])).toBe('# Thread');
    expect([...out['attachments/01-a.png']!]).toEqual([1, 2, 3, 4]);
    expect(new TextDecoder().decode(out['attachments/02-log.txt'])).toBe(text);
    expect(blob.size).toBeLessThan(text.length); // the text file was deflated
    expect(() => zip.add('late.txt', new Uint8Array([1]))).toThrow(/finished/);
  });
});

describe('image fetch policy (redirects / cookies)', () => {
  type Call = { url: string; init?: RequestInit };
  const png = (url: string) => {
    const res = new Response(new Uint8Array([1]), { headers: { 'Content-Type': 'image/png' } });
    Object.defineProperty(res, 'url', { value: url });
    return res;
  };

  it('fetches cross-origin images without cookies, following redirects', async () => {
    const calls: Call[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return png('https://cdn.example.net/final.png');
    }) as typeof fetch;
    const r = await fetchImage('https://cdn.example.net/a.png', {
      pageUrl: 'https://blog.example.com/',
      timeoutMs: 1000,
      fetchFn,
    });
    expect(r).toMatchObject({ ok: true, credentials: 'omit' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init).toMatchObject({ credentials: 'omit', redirect: 'follow' });
  });

  it('same-origin images get cookies but never follow a redirect with them', async () => {
    const calls: Call[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (init?.redirect === 'error') throw new TypeError('Failed to fetch'); // the server redirected
      return png('https://other.example.org/img.png');
    }) as typeof fetch;
    const r = await fetchImage('https://www.example.com/a.png', {
      pageUrl: 'https://www.example.com/post',
      timeoutMs: 1000,
      fetchFn,
    });
    expect(calls.map((c) => [c.init?.credentials, c.init?.redirect])).toEqual([
      ['include', 'error'],
      ['omit', 'follow'],
    ]);
    expect(r).toMatchObject({ ok: true, credentials: 'omit' });
  });

  it('same-origin image without redirect keeps its cookies (single request)', async () => {
    let n = 0;
    const fetchFn = (async () => {
      n++;
      return png('https://www.example.com/a.png');
    }) as typeof fetch;
    const r = await fetchImage('https://www.example.com/a.png', {
      pageUrl: 'https://www.example.com/',
      timeoutMs: 1000,
      fetchFn,
    });
    expect(r).toMatchObject({ ok: true, credentials: 'include' });
    expect(n).toBe(1);
  });

  it('refuses private hosts up front and discards a redirect that ended on one', async () => {
    let n = 0;
    const toPrivate = (async () => {
      n++;
      return png('http://192.168.0.1/admin.png');
    }) as typeof fetch;
    expect(await fetchImage('http://127.0.0.1/a.png', { timeoutMs: 1000, fetchFn: toPrivate })).toEqual({
      ok: false,
      error: 'URL not allowed',
    });
    expect(n).toBe(0);
    expect(await fetchImage('https://evil.example/a.png', { timeoutMs: 1000, fetchFn: toPrivate })).toEqual({
      ok: false,
      error: 'URL not allowed',
    });
  });

  it('data: images are read locally', async () => {
    const r = await fetchImage('data:image/png;base64,AQ==', { timeoutMs: 1000 });
    expect(r).toMatchObject({ ok: true });
  });
});
