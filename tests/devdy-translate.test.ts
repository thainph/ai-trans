import { describe, expect, it, vi } from 'vitest';
import {
  checkHealth,
  type DevdyInstance,
  type FetchFn,
  parseHealth,
  type ResolveResult,
  supportsTranslate,
} from '../src/features/devdy/core/client';
import {
  checkTranslateText,
  codeForStatus,
  codeForStreamError,
  DEVDY_TRANSLATE_MAX_CHARS,
  DevdyTranslateError,
  describeTranslateError,
  needsDevdySettings,
  type SseEvent,
  SseParser,
  translateJson,
  translateStream,
} from '../src/features/devdy/core/translate';
import { BUSY_RETRIES, DevdyTranslator, type DevdyTranslatorDeps } from '../src/features/devdy/core/translator';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** An SSE response whose body arrives in exactly these chunks. */
function sse(chunks: string[], status = 200): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(ctrl) {
      for (const c of chunks) ctrl.enqueue(enc.encode(c));
      ctrl.close();
    },
  });
  return new Response(body, { status, headers: { 'Content-Type': 'text/event-stream' } });
}

const feed = (chunks: string[]): SseEvent[] => {
  const p = new SseParser();
  return [...chunks.flatMap((c) => p.push(c)), ...p.end()];
};

describe('devdy discovery: features', () => {
  it('keeps typed /health fields, including features', () => {
    expect(parseHealth({ app: 'devdy', version: '0.9.0', api: 1, features: ['translate', 3] })).toEqual({
      app: 'devdy',
      version: '0.9.0',
      api: 1,
      features: ['translate'],
    });
    expect(parseHealth({ app: 'devdy', version: '0.8.0', api: 1 })).toEqual({ app: 'devdy', version: '0.8.0', api: 1 });
    expect(parseHealth({ app: 'other' })).toBeNull();
    expect(parseHealth(null)).toBeNull();
    expect(parseHealth({ app: 'devdy', features: 'translate' })).toEqual({ app: 'devdy' });
  });

  it('translate is supported only when features lists it', async () => {
    expect(supportsTranslate({ app: 'devdy', features: ['translate'] })).toBe(true);
    expect(supportsTranslate({ app: 'devdy', features: [] })).toBe(false);
    expect(supportsTranslate({ app: 'devdy' })).toBe(false); // older Devdy: no features
    expect(supportsTranslate(null)).toBe(false);
    const fetchFn = (async () => json(200, { app: 'devdy', api: 1, features: ['translate'] })) as FetchFn;
    expect(supportsTranslate(await checkHealth(47821, fetchFn))).toBe(true);
  });
});

describe('devdy translate: SSE parser', () => {
  it('parses events, ignores comments and dispatches on blank lines', () => {
    const events = feed([
      ': keep-alive\n\nevent: chunk\ndata: {"delta":"Xin "}\n\nevent: chunk\ndata: {"delta":"chào"}\n\n',
      'event: done\ndata: {"text":"Xin chào","targetLang":"vi"}\n\n',
    ]);
    expect(events).toEqual([
      { event: 'chunk', data: '{"delta":"Xin "}' },
      { event: 'chunk', data: '{"delta":"chào"}' },
      { event: 'done', data: '{"text":"Xin chào","targetLang":"vi"}' },
    ]);
  });

  it('handles events split anywhere across reads', () => {
    const text = 'event: chunk\ndata: {"delta":"a"}\n\nevent: done\ndata: {"text":"a"}\n\n';
    const whole = feed([text]);
    for (let i = 1; i < text.length; i++) expect(feed([text.slice(0, i), text.slice(i)])).toEqual(whole);
    expect(feed(text.split(''))).toEqual(whole);
  });

  it('accepts CRLF and CR line ends, also split between reads', () => {
    const expected = [{ event: 'chunk', data: 'x' }];
    expect(feed(['event: chunk\r\ndata: x\r\n\r\n'])).toEqual(expected);
    expect(feed(['event: chunk\rdata: x\r\r'])).toEqual(expected);
    expect(feed(['event: chunk\r', '\ndata: x\r', '\n\r', '\n'])).toEqual(expected);
  });

  it('joins multi-line data, defaults the event name and drops data-less events', () => {
    expect(feed(['data: line 1\ndata:line 2\ndata\n\n'])).toEqual([{ event: 'message', data: 'line 1\nline 2\n' }]);
    expect(feed(['event: chunk\n\n', 'id: 3\nretry: 10\n\n'])).toEqual([]);
    expect(feed(['data:  two spaces\n\n'])).toEqual([{ event: 'message', data: ' two spaces' }]);
  });

  it('dispatches a last event without its blank line at end of stream', () => {
    expect(feed(['event: done\ndata: {"text":"x"}'])).toEqual([{ event: 'done', data: '{"text":"x"}' }]);
  });
});

describe('devdy translate: errors', () => {
  it('maps statuses (not messages) to codes', () => {
    expect(codeForStatus(400, 'invalid JSON body')).toBe('bad_request');
    expect(codeForStatus(415, '')).toBe('bad_request');
    expect(codeForStatus(401, 'invalid or missing token')).toBe('unauthorized');
    expect(codeForStatus(413, 'text exceeds 8000 characters')).toBe('too_long');
    expect(codeForStatus(429, '')).toBe('busy');
    expect(codeForStatus(502, 'empty translation')).toBe('engine_error');
    expect(codeForStatus(503, 'translation engine unavailable: Claude sidecar not found')).toBe('engine_unavailable');
    expect(codeForStatus(503, 'server stopping')).toBe('stopping');
    expect(codeForStatus(504, 'timeout')).toBe('timeout');
    expect(codeForStatus(500, '')).toBe('engine_error');
    expect(codeForStatus(404, 'not found')).toBe('protocol');
    expect(codeForStreamError('timeout')).toBe('timeout');
    expect(codeForStreamError('server stopping')).toBe('stopping');
    expect(codeForStreamError('translation ended unexpectedly')).toBe('engine_error');
  });

  it('describes errors for the user', () => {
    expect(describeTranslateError('unreachable')).toMatch(/not running or its Inbox API is turned off/);
    expect(describeTranslateError('unauthorized')).toMatch(/AI Trans → Devdy/);
    expect(describeTranslateError('too_long')).toContain('8,000');
    expect(
      describeTranslateError('engine_unavailable', 'translation engine unavailable: Claude sidecar not found'),
    ).toBe(
      "Devdy's translation engine is unavailable (Claude sidecar not found). Check the translation settings in Devdy (Claude/Codex sign-in, Node/CLI path).",
    );
    // Engine messages may be stack traces: first line only, bounded.
    const long = describeTranslateError('engine_error', `Error: boom\n    at x (y.js:1)\n${'z'.repeat(500)}`);
    expect(long).toBe('Devdy translation failed: Error: boom');
    expect(describeTranslateError('engine_error', 'x'.repeat(500)).length).toBeLessThan(260);
    expect(new DevdyTranslateError('busy').message).toMatch(/busy/);
    expect(needsDevdySettings('unauthorized')).toBe(true);
    expect(needsDevdySettings('no_token')).toBe(true);
    expect(needsDevdySettings('choose_instance')).toBe(true);
    expect(needsDevdySettings('unreachable')).toBe(false);
  });

  it('refuses empty and over-long text locally', () => {
    expect(checkTranslateText('   ')?.code).toBe('bad_request');
    expect(checkTranslateText(`  ${'a'.repeat(DEVDY_TRANSLATE_MAX_CHARS)}  `)).toBeNull();
    expect(checkTranslateText('a'.repeat(DEVDY_TRANSLATE_MAX_CHARS + 1))?.code).toBe('too_long');
    // Counted in Unicode characters, not UTF-16 units.
    expect(checkTranslateText('😀'.repeat(DEVDY_TRANSLATE_MAX_CHARS))).toBeNull();
  });
});

describe('devdy translate: requests', () => {
  it('JSON mode: posts text + targetLang with the token', async () => {
    const fetchFn = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      json(200, { text: 'Xin chào', targetLang: 'vi' }),
    );
    const r = await translateJson(47821, 'tok', { text: 'Hello', targetLang: 'vi' }, { fetchFn: fetchFn as FetchFn });
    expect(r).toEqual({ text: 'Xin chào', targetLang: 'vi' });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(String(url)).toBe('http://127.0.0.1:47821/v1/translate');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer tok', 'Content-Type': 'application/json' });
    expect(JSON.parse(String(init?.body))).toEqual({ text: 'Hello', targetLang: 'vi' });
  });

  it('JSON mode: error statuses become coded errors', async () => {
    const cases: [number, string, string][] = [
      [401, 'invalid or missing token', 'unauthorized'],
      [429, 'too many translations in flight', 'busy'],
      [503, 'server stopping', 'stopping'],
      [504, 'timeout', 'timeout'],
    ];
    for (const [status, error, code] of cases) {
      const fetchFn = (async () => json(status, { error })) as FetchFn;
      await expect(translateJson(47821, 't', { text: 'x', targetLang: null }, { fetchFn })).rejects.toMatchObject({
        code,
        status,
        detail: error,
      });
    }
    const refused = (async () => {
      throw new TypeError('Failed to fetch');
    }) as FetchFn;
    await expect(
      translateJson(47821, 't', { text: 'x', targetLang: null }, { fetchFn: refused }),
    ).rejects.toMatchObject({ code: 'unreachable' });
  });

  it('SSE mode: reports deltas and resolves with the done text', async () => {
    const deltas: string[] = [];
    const fetchFn = vi.fn(async () =>
      sse([
        ': ping\n\nevent: chunk\ndata: {"delta":"Xin "}\n',
        '\nevent: chunk\ndata: {"delta":"chao"}\n\nevent: done\ndata: {"text":"Xin chào","targetLang":"vi"}\n\n',
      ]),
    );
    const r = await translateStream(
      47821,
      'tok',
      { text: 'Hello', targetLang: 'vi' },
      { fetchFn: fetchFn as FetchFn, onDelta: (d) => deltas.push(d) },
    );
    expect(deltas).toEqual(['Xin ', 'chao']);
    expect(r.text).toBe('Xin chào'); // authoritative, not the concatenated deltas
    const init = (fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.headers).toMatchObject({ Accept: 'text/event-stream' });
  });

  it('SSE mode: error event, pre-stream JSON error and missing terminal event', async () => {
    const opts = (res: () => Response) => ({ fetchFn: (async () => res()) as FetchFn });
    const input = { text: 'x', targetLang: 'vi' };
    await expect(
      translateStream(
        1,
        't',
        input,
        opts(() => sse(['event: error\ndata: {"error":"timeout"}\n\n'])),
      ),
    ).rejects.toMatchObject({ code: 'timeout' });
    await expect(
      translateStream(
        1,
        't',
        input,
        opts(() => sse(['event: error\ndata: {"error":"empty translation"}\n\n'])),
      ),
    ).rejects.toMatchObject({ code: 'engine_error', detail: 'empty translation' });
    await expect(
      translateStream(
        1,
        't',
        input,
        opts(() => json(503, { error: 'translation engine unavailable: x' })),
      ),
    ).rejects.toMatchObject({ code: 'engine_unavailable' });
    await expect(
      translateStream(
        1,
        't',
        input,
        opts(() => sse(['event: chunk\ndata: {"delta":"a"}\n\n'])),
      ),
    ).rejects.toMatchObject({ code: 'interrupted' });
    // A JSON 200 (Accept ignored) is accepted too.
    expect(
      await translateStream(
        1,
        't',
        input,
        opts(() => json(200, { text: 'ok' })),
      ),
    ).toEqual({ text: 'ok' });
  });

  it('SSE mode: aborting cancels the request', async () => {
    const ctrl = new AbortController();
    const fetchFn = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode('event: chunk\ndata: {"delta":"a"}\n\n'));
          init?.signal?.addEventListener('abort', () => c.error(new DOMException('Aborted', 'AbortError')));
        },
      });
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
    }) as FetchFn;
    const p = translateStream(
      1,
      't',
      { text: 'x', targetLang: null },
      { fetchFn, signal: ctrl.signal, onDelta: () => ctrl.abort() },
    );
    await expect(p).rejects.toMatchObject({ code: 'cancelled' });
  });
});

describe('devdy translate: service', () => {
  const health = (features?: string[]) => ({ app: 'devdy' as const, version: '1.0', features });
  const inst = (port: number, features: string[] | null = ['translate']): DevdyInstance => ({
    port,
    health: health(features ?? undefined),
  });

  function deps(over: Partial<DevdyTranslatorDeps> = {}): DevdyTranslatorDeps & { resolveCalls: number } {
    const d = {
      resolveCalls: 0,
      loadSettings: async () => ({ token: 'tok' }),
      resolveDevdy: async (): Promise<ResolveResult> => {
        d.resolveCalls++;
        return { kind: 'ok', instance: inst(47821) };
      },
      savePort: async () => {},
      translateJson: async () => ({ text: 'ok' }),
      translateStream: async () => ({ text: 'streamed' }),
      sleep: async () => {},
      ...over,
    };
    return d;
  }

  it('reuses the resolved instance and streams only with onDelta', async () => {
    const d = deps();
    const t = new DevdyTranslator(d);
    expect((await t.translate({ text: 'a', targetLang: 'vi' })).text).toBe('ok');
    expect((await t.translate({ text: 'a', targetLang: 'vi', onDelta: () => {} })).text).toBe('streamed');
    expect(d.resolveCalls).toBe(1);
  });

  it('probes again once after a connection error', async () => {
    let port = 47821;
    let calls = 0;
    const d = deps({
      resolveDevdy: async () => {
        d.resolveCalls++;
        return { kind: 'ok', instance: inst(port) };
      },
      translateJson: async (p) => {
        calls++;
        if (p === 47821) {
          port = 47822; // Devdy restarted on another port
          throw new DevdyTranslateError('unreachable');
        }
        return { text: `via ${p}` };
      },
    });
    const savePort = vi.fn(async () => {});
    d.savePort = savePort;
    const t = new DevdyTranslator(d);
    expect((await t.translate({ text: 'a', targetLang: null })).text).toBe('via 47822');
    expect(calls).toBe(2);
    expect(savePort).toHaveBeenLastCalledWith(47822);

    // Still unreachable after the re-probe → error.
    const down = new DevdyTranslator(
      deps({
        translateJson: async () => {
          throw new DevdyTranslateError('unreachable');
        },
      }),
    );
    await expect(down.translate({ text: 'a', targetLang: null })).rejects.toMatchObject({ code: 'unreachable' });
  });

  it('retries 429 up to BUSY_RETRIES times', async () => {
    let n = 0;
    const sleep = vi.fn(async () => {});
    const t = new DevdyTranslator(
      deps({
        sleep,
        translateJson: async () => {
          if (++n <= BUSY_RETRIES) throw new DevdyTranslateError('busy');
          return { text: 'finally' };
        },
      }),
    );
    expect((await t.translate({ text: 'a', targetLang: null })).text).toBe('finally');
    expect(sleep).toHaveBeenCalledTimes(BUSY_RETRIES);

    const always = new DevdyTranslator(
      deps({
        translateJson: async () => {
          throw new DevdyTranslateError('busy');
        },
      }),
    );
    await expect(always.translate({ text: 'a', targetLang: null })).rejects.toMatchObject({ code: 'busy' });
  });

  it('checks instance, feature and token before translating', async () => {
    const none = new DevdyTranslator(deps({ resolveDevdy: async () => ({ kind: 'none' }) }));
    await expect(none.translate({ text: 'a', targetLang: null })).rejects.toMatchObject({ code: 'unreachable' });
    const many = new DevdyTranslator(
      deps({ resolveDevdy: async () => ({ kind: 'ambiguous', instances: [inst(47821), inst(47822)] }) }),
    );
    await expect(many.translate({ text: 'a', targetLang: null })).rejects.toMatchObject({ code: 'choose_instance' });
    const old = new DevdyTranslator(deps({ resolveDevdy: async () => ({ kind: 'ok', instance: inst(47821, null) }) }));
    await expect(old.translate({ text: 'a', targetLang: null })).rejects.toMatchObject({ code: 'unsupported' });
    const noToken = new DevdyTranslator(deps({ loadSettings: async () => ({}) }));
    await expect(noToken.translate({ text: 'a', targetLang: null })).rejects.toMatchObject({ code: 'no_token' });
  });

  it('reports the status for the Translate tab', async () => {
    const ok = new DevdyTranslator(deps());
    expect(await ok.status(async () => true)).toEqual({ state: 'ready', port: 47821, version: '1.0' });
    expect((await ok.status(async () => false)).state).toBe('unauthorized');
    expect((await ok.status(async () => null)).state).toBe('ready');
    expect((await new DevdyTranslator(deps({ loadSettings: async () => ({}) })).status(async () => true)).state).toBe(
      'no_token',
    );
    const none = new DevdyTranslator(deps({ resolveDevdy: async () => ({ kind: 'none' }) }));
    expect((await none.status(async () => true)).state).toBe('not_running');
    const old = new DevdyTranslator(deps({ resolveDevdy: async () => ({ kind: 'ok', instance: inst(47821, []) }) }));
    expect((await old.status(async () => true)).state).toBe('unsupported');
  });
});
