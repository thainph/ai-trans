import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DevdyTranslateError } from '../src/features/devdy/core/translate';
import {
  checkGrammarWithDevdy,
  translateBatchWithDevdy,
  translateTextWithDevdy,
} from '../src/features/translator/background/devdy';
import { rejectReason } from '../src/features/translator/background/sender';
import { type StreamPort, serveStreamPort } from '../src/features/translator/background/stream-port';
import { packItems } from '../src/features/translator/core/devdy-pack';
import {
  CANCELLED,
  type StreamTranslateEvent,
  TRANSLATOR_STREAM_PORT,
  TRANSLATOR_TARGET,
  type TranslatorRequest,
} from '../src/features/translator/shared/messages';

// The Devdy service API runs in the service worker (chrome.*): replace its translate call.
const devdyTranslate = vi.hoisted(() =>
  vi.fn<
    (req: {
      text: string;
      targetLang: string | null;
      signal?: AbortSignal;
      onDelta?: (d: string) => void;
    }) => Promise<string>
  >(),
);
const devdyCheckGrammar = vi.hoisted(() =>
  vi.fn<
    (req: { text: string; explainLang: string | null; signal?: AbortSignal }) => Promise<{
      corrected: string;
      issues: { original: string; suggestion: string; explanation: string }[];
    }>
  >(),
);
vi.mock('../src/features/devdy/api', async () => {
  const t = await import('../src/features/devdy/core/translate');
  return {
    devdyTranslate,
    devdyCheckGrammar,
    DevdyTranslateError: t.DevdyTranslateError,
    DEVDY_TRANSLATE_MAX_CHARS: t.DEVDY_TRANSLATE_MAX_CHARS,
  };
});

beforeEach(() => {
  devdyTranslate.mockReset();
  devdyCheckGrammar.mockReset();
});

describe('checkGrammarWithDevdy', () => {
  it('checks ≤ 8000-char segments in order, keeps outer whitespace and merges the issues', async () => {
    devdyCheckGrammar.mockImplementation(async ({ text }) => ({
      corrected: ` <${text.length}> `,
      issues: [{ original: text.slice(0, 1), suggestion: '!', explanation: '' }],
    }));
    const ctrl = new AbortController();
    const text = `  ${'a'.repeat(5000)}\n${'b'.repeat(5000)}\n\n`;
    const out = await checkGrammarWithDevdy(text, 'vietnamese', ctrl.signal);
    expect(devdyCheckGrammar.mock.calls.map(([r]) => [r.text.length, r.explainLang, r.signal])).toEqual([
      [5000, 'vi', ctrl.signal],
      [5000, 'vi', ctrl.signal],
    ]);
    expect(out).toEqual({
      corrected: '<5000>\n<5000>',
      issues: [
        { original: 'a', suggestion: '!', explanation: '' },
        { original: 'b', suggestion: '!', explanation: '' },
      ],
    });
  });

  it('propagates Devdy errors', async () => {
    devdyCheckGrammar.mockRejectedValue(new DevdyTranslateError('unsupported', '', undefined, 'grammar'));
    await expect(checkGrammarWithDevdy('He go.', 'english')).rejects.toMatchObject({ code: 'unsupported' });
  });
});

describe('translateTextWithDevdy', () => {
  it('translates segments in order, keeps outer whitespace and reports each segment', async () => {
    devdyTranslate.mockImplementation(async ({ text }) => ` <${text.length}> `);
    const text = `  ${'a'.repeat(5000)}\n${'b'.repeat(5000)}\n\n`;
    const segments: string[] = [];
    const out = await translateTextWithDevdy(text, 'vietnamese', { onSegment: (s) => segments.push(s) });
    // Two requests ≤ 8000 chars, sent one after another, with the Devdy code of the language.
    expect(devdyTranslate.mock.calls.map(([r]) => [r.text.length, r.targetLang])).toEqual([
      [5000, 'vi'],
      [5000, 'vi'],
    ]);
    expect(segments).toEqual(['  <5000>\n', '<5000>\n\n']);
    expect(out).toBe('<5000>\n<5000>');
  });

  it('passes signal and onDelta to every request', async () => {
    const ctrl = new AbortController();
    const onDelta = vi.fn();
    devdyTranslate.mockImplementation(async (req) => {
      req.onDelta?.('x');
      return 'X';
    });
    expect(await translateTextWithDevdy('Hello', 'portuguese', { signal: ctrl.signal, onDelta })).toBe('X');
    expect(devdyTranslate.mock.calls[0]![0]).toMatchObject({ signal: ctrl.signal, targetLang: 'Portuguese' });
    expect(onDelta).toHaveBeenCalledWith('x');
  });
});

describe('translateBatchWithDevdy', () => {
  const echo = async ({ text }: { text: string }) => text.replace(/[a-z]+/g, (w) => w.toUpperCase());

  it('packs texts, unpacks replies, and marks unpackable texts untranslatable (false)', async () => {
    devdyTranslate.mockImplementation(echo);
    const out = await translateBatchWithDevdy(['hello', 'has ⟦ bracket', 'world'], 'english');
    expect(out).toEqual(['HELLO', false, 'WORLD']);
    expect(devdyTranslate).toHaveBeenCalledTimes(1);
    expect(devdyTranslate.mock.calls[0]![0].text).toBe(packItems(['hello', 'world']));
  });

  it('pack-local errors (engine error, timeout, busy…) leave that pack null and go on', async () => {
    const texts = ['a'.repeat(4000), 'b'.repeat(4000), 'c'];
    for (const code of ['engine_error', 'timeout', 'busy', 'interrupted'] as const) {
      devdyTranslate.mockReset();
      devdyTranslate.mockRejectedValueOnce(new DevdyTranslateError(code)).mockImplementation(echo);
      const out = await translateBatchWithDevdy(texts, 'english');
      expect(out[0]).toBeNull();
      expect(out[1]).toBe('B'.repeat(4000));
      expect(out[2]).toBe('C');
    }
  });

  it('connection, token and engine-unavailable errors fail the whole batch', async () => {
    for (const code of ['unreachable', 'unauthorized', 'no_token', 'engine_unavailable', 'stopping'] as const) {
      devdyTranslate.mockReset();
      devdyTranslate.mockRejectedValue(new DevdyTranslateError(code));
      await expect(translateBatchWithDevdy(['a'], 'english')).rejects.toMatchObject({ code });
    }
  });

  it('stops before the next pack once cancelled', async () => {
    const ctrl = new AbortController();
    devdyTranslate.mockImplementation(async (req) => {
      ctrl.abort();
      return echo(req);
    });
    await expect(translateBatchWithDevdy(['a'.repeat(4000), 'b'.repeat(4000)], 'english', ctrl.signal)).rejects.toThrow(
      CANCELLED,
    );
    expect(devdyTranslate).toHaveBeenCalledTimes(1);
    expect(devdyTranslate.mock.calls[0]![0].signal).toBe(ctrl.signal);
  });
});

describe('translate-batch: cancellable', () => {
  const CONTENT = { id: 'abc', url: 'https://example.com/' };
  const batch = (requestId?: string) =>
    ({
      target: TRANSLATOR_TARGET,
      type: 'translate-batch',
      texts: ['a'],
      sourceLang: 'english',
      targetLang: 'vietnamese',
      style: 'casual',
      requestId,
    }) as TranslatorRequest;

  it('accepts an optional, well-formed requestId', () => {
    expect(rejectReason(batch(), CONTENT, 'abc')).toBeNull();
    expect(rejectReason(batch('r1'), CONTENT, 'abc')).toBeNull();
    expect(rejectReason(batch('x'.repeat(65)), CONTENT, 'abc')).toBe('Invalid request');
  });
});

describe('stream port handler', () => {
  function fakePort(sender: chrome.runtime.MessageSender = { id: 'abc', url: 'https://example.com/' }) {
    const messageListeners: ((m: unknown) => void)[] = [];
    const disconnectListeners: (() => void)[] = [];
    const port = {
      name: TRANSLATOR_STREAM_PORT,
      sender,
      posted: [] as StreamTranslateEvent[],
      disconnected: false,
      postMessage(m: StreamTranslateEvent) {
        port.posted.push(m);
      },
      disconnect() {
        port.disconnected = true;
      },
      onMessage: { addListener: (l: (m: unknown) => void) => messageListeners.push(l) },
      onDisconnect: { addListener: (l: () => void) => disconnectListeners.push(l) },
      send: (m: unknown) => {
        for (const l of messageListeners) l(m);
      },
      /** The other side disconnects (popup closed / new selection). */
      close: () => {
        for (const l of disconnectListeners) l();
      },
    };
    return port satisfies StreamPort;
  }
  const request = { type: 'translate', text: 'Hello', sourceLang: 'english', targetLang: 'vietnamese' };
  const errorEvent = (err: unknown) => ({ type: 'error' as const, error: String((err as Error).message) });
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('ignores other ports and refuses foreign senders', () => {
    const translate = vi.fn();
    const other = { ...fakePort(), name: 'slack-thread-export' };
    expect(serveStreamPort(other, { extensionId: 'abc', translate, errorEvent })).toBe(false);
    const foreign = fakePort({ id: 'evil' });
    expect(serveStreamPort(foreign, { extensionId: 'abc', translate, errorEvent })).toBe(true);
    expect(foreign.disconnected).toBe(true);
    expect(translate).not.toHaveBeenCalled();
  });

  it('streams events then done, one request per port', async () => {
    const translate = vi.fn(async (_r, _s, post: (e: StreamTranslateEvent) => void) => {
      post({ type: 'delta', delta: 'Xin ' });
      return 'Xin chào';
    });
    const port = fakePort();
    serveStreamPort(port, { extensionId: 'abc', translate, errorEvent });
    port.send(request);
    port.send(request);
    await flush();
    expect(translate).toHaveBeenCalledTimes(1);
    expect(port.posted).toEqual([
      { type: 'delta', delta: 'Xin ' },
      { type: 'done', text: 'Xin chào' },
    ]);
  });

  it('rejects an invalid request', async () => {
    const translate = vi.fn();
    const port = fakePort();
    serveStreamPort(port, { extensionId: 'abc', translate, errorEvent });
    port.send({ type: 'translate', text: 42 });
    expect(port.posted).toEqual([{ type: 'error', error: 'Invalid request' }]);
    expect(translate).not.toHaveBeenCalled();
  });

  it('disconnect aborts the work and nothing is posted afterwards', async () => {
    let signal: AbortSignal | undefined;
    let post: ((e: StreamTranslateEvent) => void) | undefined;
    let finish: ((v: string) => void) | undefined;
    const translate = vi.fn(
      (_r: unknown, s: AbortSignal, p: (e: StreamTranslateEvent) => void) =>
        new Promise<string>((resolve) => {
          signal = s;
          post = p;
          finish = resolve;
        }),
    );
    const port = fakePort();
    serveStreamPort(port, { extensionId: 'abc', translate, errorEvent });
    port.send(request);
    post!({ type: 'delta', delta: 'a' });
    port.close();
    expect(signal!.aborted).toBe(true);
    post!({ type: 'delta', delta: 'b' });
    finish!('ab');
    await flush();
    expect(port.posted).toEqual([{ type: 'delta', delta: 'a' }]);
  });

  it('a failure after the port closed is not posted', async () => {
    const translate = vi.fn(
      (_r: unknown, s: AbortSignal) =>
        new Promise<string>((_resolve, reject) => {
          s.addEventListener('abort', () => reject(new Error(CANCELLED)));
        }),
    );
    const port = fakePort();
    serveStreamPort(port, { extensionId: 'abc', translate, errorEvent });
    port.send(request);
    port.close();
    await flush();
    expect(port.posted).toEqual([]);
  });

  it('a failure while open is posted as an error event', async () => {
    const translate = vi.fn(async () => {
      throw new Error('boom');
    });
    const port = fakePort();
    serveStreamPort(port, { extensionId: 'abc', translate, errorEvent });
    port.send(request);
    await flush();
    expect(port.posted).toEqual([{ type: 'error', error: 'boom' }]);
  });
});
