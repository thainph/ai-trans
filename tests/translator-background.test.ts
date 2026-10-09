import { describe, expect, it } from 'vitest';
import { ollamaCorsRules, ollamaOrigin } from '../src/features/translator/background/ollama-cors';
import { isExtensionPage, rejectReason } from '../src/features/translator/background/sender';
import {
  BATCH_KEY,
  buildBatchInput,
  buildBatchPrompt,
  parseBatchResponse,
} from '../src/features/translator/core/batch-protocol';

const SRC = ['Hello', 'World', 'Good bye'];

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

  it('falls back to the source on a length mismatch, and per item on bad items', () => {
    expect(parseBatchResponse(JSON.stringify({ translations: ['a', 'b'] }), SRC)).toEqual(SRC);
    expect(parseBatchResponse(JSON.stringify({ translations: ['a', 'b', 'c', 'd'] }), SRC)).toEqual(SRC);
    expect(parseBatchResponse(JSON.stringify({ translations: ['a', 42, '  '] }), SRC)).toEqual([
      'a',
      'World',
      'Good bye',
    ]);
    expect(parseBatchResponse('{"foo": 1}', SRC)).toEqual(SRC);
  });

  it('keeps the complete leading items of a truncated reply', () => {
    expect(parseBatchResponse('{"translations": ["Xin chào", "Thế \\"giới\\"", "Tạm b', SRC)).toEqual([
      'Xin chào',
      'Thế "giới"',
      'Good bye',
    ]);
  });

  it('parses legacy numbered lines: first occurrence wins, continuation lines kept', () => {
    const raw = '[0] Xin chào\n[1] Thế\ngiới\n[1] injected\n[2] Tạm biệt\n[7] out of range';
    expect(parseBatchResponse(raw, SRC)).toEqual(['Xin chào', 'Thế\ngiới', 'Tạm biệt']);
    expect(parseBatchResponse('no structure at all', SRC)).toEqual(SRC);
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
