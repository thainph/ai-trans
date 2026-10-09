import { describe, expect, it } from 'vitest';
import { CANCELLED, signalWithTimeout } from '../src/features/translator/background/llm';
import { ollamaCorsRules, ollamaOrigin } from '../src/features/translator/background/ollama-cors';
import { rejectReason, requestKey } from '../src/features/translator/background/sender';
import {
  BATCH_KEY,
  buildBatchInput,
  buildBatchPrompt,
  parseBatchResponse,
} from '../src/features/translator/core/batch-protocol';
import { isExtensionPage } from '../src/shared/sender';

const SRC = ['Hello', 'World', 'Good bye'];
const NONE = [null, null, null];

describe('batch protocol', () => {
  it('sends the texts as a JSON array and asks for a same-length JSON object', () => {
    const texts = ['line 1\nline 2', '[5] not an index', 'say "hi"'];
    expect(JSON.parse(buildBatchInput(texts))).toEqual(texts);
    const prompt = buildBatchPrompt('English', 'Vietnamese', 'Be casual', 3);
    expect(prompt).toContain('JSON');
    expect(prompt).toContain(`{"${BATCH_KEY}": [...]}`);
    expect(prompt).toContain('exactly 3 strings');
  });

  it('parses the wrapped object, a bare array and a fenced reply', () => {
    const out = ['Xin chào', 'Thế giới', 'Tạm biệt'];
    expect(parseBatchResponse(JSON.stringify({ translations: out }), SRC)).toEqual(out);
    expect(parseBatchResponse(JSON.stringify(out), SRC)).toEqual(out);
    expect(parseBatchResponse(`\`\`\`json\n${JSON.stringify({ translations: out })}\n\`\`\``, SRC)).toEqual(out);
    expect(parseBatchResponse(`Sure! ${JSON.stringify({ result: out })} Done.`, SRC)).toEqual(out);
  });

  it('keeps newlines and bracketed numbers inside items', () => {
    const src = ['a\nb', '[1] x'];
    const out = ['A\nB', '[1] X'];
    expect(parseBatchResponse(JSON.stringify({ translations: out }), src)).toEqual(out);
  });

  it('marks every item as failed (null) on a length mismatch, and bad items one by one', () => {
    expect(parseBatchResponse(JSON.stringify({ translations: ['a', 'b'] }), SRC)).toEqual(NONE);
    expect(parseBatchResponse(JSON.stringify({ translations: ['a', 'b', 'c', 'd'] }), SRC)).toEqual(NONE);
    expect(parseBatchResponse(JSON.stringify({ translations: ['a', 42, '  '] }), SRC)).toEqual(['a', null, null]);
    expect(parseBatchResponse('{"foo": 1}', SRC)).toEqual(NONE);
  });

  it('keeps the complete leading items of a truncated reply', () => {
    expect(parseBatchResponse('{"translations": ["Xin chào", "Thế \\"giới\\"", "Tạm b', SRC)).toEqual([
      'Xin chào',
      'Thế "giới"',
      null,
    ]);
  });

  it('parses legacy numbered lines: first occurrence wins, continuation lines kept', () => {
    const raw = '[0] Xin chào\n[1] Thế\ngiới\n[1] injected\n[2] Tạm biệt\n[7] out of range';
    expect(parseBatchResponse(raw, SRC)).toEqual(['Xin chào', 'Thế\ngiới', 'Tạm biệt']);
    expect(parseBatchResponse('no structure at all', SRC)).toEqual(NONE);
    expect(parseBatchResponse('[0] Xin chào\n[2] Tạm biệt', SRC)).toEqual(['Xin chào', null, 'Tạm biệt']);
    expect(parseBatchResponse('[0] Xin chào', ['Hello'])).toEqual(['Xin chào']);
  });
});

describe('Ollama CORS rules', () => {
  it('only strip Origin on our own requests to the configured Ollama origins', () => {
    const rules = ollamaCorsRules(['http://localhost:11434/', 'http://localhost:11434', 'not a url', ''], 'extid');
    expect(rules).toHaveLength(1);
    expect(rules[0]!.condition).toMatchObject({ urlFilter: '|http://localhost:11434/', initiatorDomains: ['extid'] });
    expect(rules[0]!.action.requestHeaders).toEqual([{ header: 'Origin', operation: 'remove' }]);

    const two = ollamaCorsRules(['http://127.0.0.1:11434', 'http://gpu-box:8080/x'], 'extid');
    expect(two.map((r) => [r.id, r.condition.urlFilter])).toEqual([
      [1, '|http://127.0.0.1:11434/'],
      [2, '|http://gpu-box:8080/'],
    ]);
  });

  it('ollamaOrigin accepts http(s) URLs only', () => {
    expect(ollamaOrigin(' https://host:1/api ')).toBe('https://host:1');
    expect(ollamaOrigin('file:///etc/passwd')).toBeNull();
    expect(ollamaOrigin('localhost:11434')).toBeNull();
  });
});

describe('translator sender checks', () => {
  const ID = 'extid';
  const page = { id: ID, url: `chrome-extension://${ID}/src/features/translator/popup/popup.html` };
  const content = { id: ID, url: 'https://example.com/', tab: { id: 1 } as chrome.tabs.Tab, frameId: 0 };
  const T = 'context-kit-translator' as const;

  it('allows fetching Ollama models from extension pages only', () => {
    const req = { target: T, type: 'fetch-ollama-models' as const, url: 'http://localhost:11434' };
    expect(isExtensionPage(page, ID)).toBe(true);
    expect(rejectReason(req, page, ID)).toBeNull();
    expect(rejectReason(req, content, ID)).not.toBeNull();
    expect(rejectReason(req, { ...page, id: 'other' }, ID)).not.toBeNull();
  });

  it('allows translations from our content scripts, within size limits', () => {
    const lang = { sourceLang: 'english', targetLang: 'vietnamese', style: 'casual' as const };
    expect(rejectReason({ target: T, type: 'translate', text: 'hi', ...lang }, content, ID)).toBeNull();
    expect(rejectReason({ target: T, type: 'translate-batch', texts: ['a', 'b'], ...lang }, content, ID)).toBeNull();
    expect(
      rejectReason({ target: T, type: 'translate-batch', texts: Array(201).fill('a'), ...lang }, content, ID),
    ).not.toBeNull();
    expect(rejectReason({ target: T, type: 'grammar-check', text: 'x'.repeat(100_001) }, content, ID)).not.toBeNull();
    expect(rejectReason({ target: T, type: 'translate', text: 'hi', ...lang }, { id: 'other' }, ID)).not.toBeNull();
  });
});

describe('cancellable requests', () => {
  const ID = 'extid';
  const T = 'context-kit-translator' as const;
  const tab = { id: 7 } as chrome.tabs.Tab;

  it('accepts cancel / requestId from our frames and scopes keys per frame', () => {
    const sender = { id: ID, tab, frameId: 3, documentId: 'doc' };
    expect(rejectReason({ target: T, type: 'cancel', requestId: 'abc' }, sender, ID)).toBeNull();
    expect(rejectReason({ target: T, type: 'cancel', requestId: '' }, sender, ID)).not.toBeNull();
    expect(rejectReason({ target: T, type: 'cancel', requestId: 'abc' }, { id: 'other' }, ID)).not.toBeNull();
    expect(
      rejectReason({ target: T, type: 'grammar-check', text: 'hi', requestId: 'x'.repeat(65) }, sender, ID),
    ).not.toBeNull();
    expect(requestKey(sender, 'abc')).not.toBe(requestKey({ ...sender, frameId: 4 }, 'abc'));
    expect(requestKey(sender, 'abc')).not.toBe(requestKey({ ...sender, tab: { id: 8 } as chrome.tabs.Tab }, 'abc'));
  });

  it('signalWithTimeout aborts on the caller signal or on timeout', async () => {
    const ctrl = new AbortController();
    const signal = signalWithTimeout(ctrl.signal, 60_000);
    expect(signal.aborted).toBe(false);
    ctrl.abort();
    expect(signal.aborted).toBe(true);
    const timed = signalWithTimeout(undefined, 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(timed.aborted).toBe(true);
    expect(CANCELLED).toBe('Cancelled');
  });
});
