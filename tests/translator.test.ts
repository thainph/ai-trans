import { describe, expect, it } from 'vitest';
import {
  buildRequestBody,
  buildTranslatePrompt,
  ollamaContextSize,
  parseLLMResponse,
  splitForTranslation,
  splitOuterWhitespace,
  stripTextTags,
  wrapText,
} from '../src/features/translator/background/llm';
import { detectLanguage } from '../src/features/translator/content/detect-language';
import { DEFAULT_SETTINGS } from '../src/features/translator/shared/settings';
import { mapLimit } from '../src/shared/async';

describe('splitForTranslation', () => {
  it('returns short text unchanged', () => {
    expect(splitForTranslation('hello', 100)).toEqual(['hello']);
  });

  it('splits on line boundaries and reassembles to the exact original', () => {
    const text = Array.from({ length: 50 }, (_, i) => `Line ${i} with some words.`).join('\n') + '\n\n';
    const segs = splitForTranslation(text, 120);
    expect(segs.length).toBeGreaterThan(1);
    expect(segs.join('')).toBe(text);
    for (const s of segs) expect(s.length).toBeLessThanOrEqual(120);
    // no line is cut in the middle
    for (const s of segs.slice(0, -1)) expect(s.endsWith('\n')).toBe(true);
  });

  it('splits a very long line by sentences (incl. CJK), then hard-cuts', () => {
    const jp = 'これは長い文です。'.repeat(40);
    const segs = splitForTranslation(jp, 50);
    expect(segs.join('')).toBe(jp);
    for (const s of segs) {
      expect(s.length).toBeLessThanOrEqual(50);
      expect(s.endsWith('。')).toBe(true);
    }
    const noPunct = 'x'.repeat(250);
    const cut = splitForTranslation(noPunct, 100);
    expect(cut).toEqual(['x'.repeat(100), 'x'.repeat(100), 'x'.repeat(50)]);
  });

  it('keeps special characters intact', () => {
    const text = '・項目 <a href="x">&amp;</a> {{name}} $var '.repeat(30) + '\n🙂 ★ ※ → ① `code` [0] ---';
    expect(splitForTranslation(text, 200).join('')).toBe(text);
  });
});

describe('whitespace + tag helpers', () => {
  it('splitOuterWhitespace separates leading/trailing whitespace', () => {
    expect(splitOuterWhitespace('\n\n  hi there \n')).toEqual({ lead: '\n\n  ', core: 'hi there', trail: ' \n' });
    expect(splitOuterWhitespace('\n \n')).toEqual({ lead: '\n \n', core: '', trail: '' });
  });

  it('wrapText / stripTextTags round-trip, even when the model echoes the tags', () => {
    expect(wrapText('a')).toBe('<text>\na\n</text>');
    expect(stripTextTags('<text>\nXin chào\n</text>')).toBe('Xin chào');
    expect(stripTextTags('  Xin chào  ')).toBe('Xin chào');
  });

  it('prompt asks for the complete text and allows mixed languages', () => {
    const p = buildTranslatePrompt('Japanese', 'Vietnamese', 'Use a casual tone');
    expect(p).toContain('COMPLETE text');
    expect(p).toContain('may mix languages');
    expect(p).toContain('Preserve line breaks');
  });
});

describe('buildRequestBody', () => {
  it('sends no output-token cap for OpenAI and Gemini', () => {
    const openai = buildRequestBody('openai', 'gpt-4o-mini', 'sys', 'user');
    expect(openai).not.toHaveProperty('max_tokens');
    expect(openai.messages).toHaveLength(2);
    const gemini = buildRequestBody('gemini', 'gemini-2.5-flash', 'sys', 'user');
    expect(gemini.generationConfig).toEqual({ temperature: 0.3 });
  });

  it('sizes the Ollama context window for the input', () => {
    const body = buildRequestBody('ollama', 'llama3', 'sys', 'x'.repeat(4000));
    expect(body.options!.num_ctx).toBeGreaterThanOrEqual(4000 * 2);
    expect(body.options!.num_predict).toBe(-1);
    expect(ollamaContextSize(10)).toBe(4096);
    expect(ollamaContextSize(1_000_000)).toBe(32768);
  });

  it('asks each provider for a JSON reply only when requested', () => {
    expect(buildRequestBody('openai', 'm', 's', 'u', true).response_format).toEqual({ type: 'json_object' });
    expect(buildRequestBody('openai', 'm', 's', 'u')).not.toHaveProperty('response_format');
    expect(buildRequestBody('gemini', 'm', 's', 'u', true).generationConfig).toEqual({
      temperature: 0.3,
      responseMimeType: 'application/json',
    });
    expect(buildRequestBody('ollama', 'm', 's', 'u', true).format).toBe('json');
    expect(buildRequestBody('ollama', 'm', 's', 'u')).not.toHaveProperty('format');
  });
});

describe('parseLLMResponse', () => {
  it('joins every Gemini text part and skips thoughts', () => {
    const r = parseLLMResponse('gemini', {
      candidates: [
        {
          finishReason: 'STOP',
          content: { parts: [{ text: 'thinking…', thought: true }, { text: 'Phần 1. ' }, { text: 'Phần 2.' }] },
        },
      ],
    });
    expect(r).toEqual({ text: 'Phần 1. Phần 2.', truncated: false });
  });

  it('flags truncation for each provider', () => {
    expect(
      parseLLMResponse('gemini', { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'a' }] } }] })
        .truncated,
    ).toBe(true);
    expect(
      parseLLMResponse('openai', { choices: [{ finish_reason: 'length', message: { content: 'a' } }] }).truncated,
    ).toBe(true);
    expect(parseLLMResponse('ollama', { message: { content: 'a' }, done_reason: 'length' }).truncated).toBe(true);
    expect(parseLLMResponse('ollama', { message: { content: ' a ' }, done_reason: 'stop' })).toEqual({
      text: 'a',
      truncated: false,
    });
  });

  it('throws a readable error when there is no text', () => {
    expect(() => parseLLMResponse('gemini', { candidates: [{ finishReason: 'SAFETY' }] })).toThrow(/SAFETY/);
    expect(() => parseLLMResponse('gemini', { promptFeedback: { blockReason: 'OTHER' } })).toThrow(/OTHER/);
    expect(() => parseLLMResponse('openai', { choices: [] })).toThrow();
  });
});

describe('mapLimit', () => {
  it('keeps order and respects the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapLimit([30, 10, 20, 5], 2, async (ms: number, i: number) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, ms));
      inFlight--;
      return i;
    });
    expect(out).toEqual([0, 1, 2, 3]);
    expect(peak).toBe(2);
  });
});

describe('detectLanguage (content script)', () => {
  const detect = detectLanguage;

  it.each([
    ['Xin chào, đây là một đoạn văn bản tiếng Việt.', 'vietnamese'],
    ['・Mục 1: kiểm tra dữ liệu\n・Mục 2: cập nhật màn hình', 'vietnamese'],
    ['Price ー 100 USD ・ shipping included', 'english'],
    ['これは日本語の文章です。', 'japanese'],
    ['本日の会議は14時からです。Please join via Zoom: https://zoom.us/j/123456789', 'japanese'],
    ['设计文档已经更新', 'chinese'],
    ['안녕하세요 반갑습니다', 'korean'],
    ['Hello world, this is English text.', 'english'],
    ['Привет, как дела?', 'russian'],
  ])('%s → %s', (text, lang) => {
    expect(detect(text)).toBe(lang);
  });
});

describe('DEFAULT_SETTINGS', () => {
  it('is the single source of the translator defaults', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({
      provider: 'openai',
      openaiModel: 'gpt-4o-mini',
      geminiModel: 'gemini-2.5-flash',
      ollamaUrl: 'http://localhost:11434',
      popupWidth: 340,
      popupHeight: 0,
    });
  });
});
