import { describe, expect, it } from 'vitest';
import { isStreamRequest, rejectReason, streamPortRejectReason } from '../src/features/translator/background/sender';
import {
  DEVDY_PACK_CHARS,
  DEVDY_PACK_MAX_CHARS,
  isPackable,
  packItems,
  planPacks,
  unpackItems,
} from '../src/features/translator/core/devdy-pack';
import { devdyStatusLine } from '../src/features/translator/core/devdy-status';
import { devdyTargetLang } from '../src/features/translator/shared/languages';
import {
  MAX_TEXT_CHARS,
  TRANSLATOR_STREAM_PORT,
  TRANSLATOR_TARGET,
  type TranslatorRequest,
} from '../src/features/translator/shared/messages';
import {
  DEFAULT_SETTINGS,
  isProvider,
  PROVIDERS,
  providerGrammarIsEnglishOnly,
  providerHasStyle,
  SEEDED_SETTINGS,
} from '../src/features/translator/shared/settings';

const ID = 'abc';
const PAGE = { id: ID, url: `chrome-extension://${ID}/src/features/translator/popup/popup.html` };
const CONTENT = { id: ID, url: 'https://example.com/', tab: { id: 1 }, frameId: 0 } as chrome.runtime.MessageSender;

describe('translator settings: devdy provider', () => {
  it('devdy is a provider, the default stays openai', () => {
    expect(PROVIDERS).toContain('devdy');
    expect(isProvider('devdy')).toBe(true);
    expect(isProvider('claude')).toBe(false);
    expect(isProvider(undefined)).toBe(false);
    expect(DEFAULT_SETTINGS.provider).toBe('openai');
    expect(SEEDED_SETTINGS.provider).toBe('openai');
  });

  it('devdy has no style; its grammar check is not English-only', () => {
    expect(providerHasStyle('devdy')).toBe(false);
    expect(providerGrammarIsEnglishOnly('devdy')).toBe(false);
    expect(providerHasStyle('openai')).toBe(true);
    expect(providerGrammarIsEnglishOnly('ollama')).toBe(true);
  });

  it('maps target languages to Devdy codes or names', () => {
    expect(devdyTargetLang('vietnamese')).toBe('vi');
    expect(devdyTargetLang('english')).toBe('en');
    expect(devdyTargetLang('japanese')).toBe('ja');
    expect(devdyTargetLang('chinese')).toBe('zh');
    expect(devdyTargetLang('korean')).toBe('ko');
    expect(devdyTargetLang('french')).toBe('fr');
    expect(devdyTargetLang('german')).toBe('de');
    expect(devdyTargetLang('spanish')).toBe('es');
    expect(devdyTargetLang('portuguese')).toBe('Portuguese');
    expect(devdyTargetLang('thai')).toBe('Thai');
    expect(devdyTargetLang('klingon')).toBe('klingon');
  });
});

describe('devdy page pack', () => {
  it('packs items with marker lines and unpacks them back', () => {
    const items = ['Hello world', 'Sign in', 'Line 1\nLine 2'];
    const packed = packItems(items);
    expect(packed).toBe('⟦0⟧\nHello world\n\n⟦1⟧\nSign in\n\n⟦2⟧\nLine 1\nLine 2');
    expect(unpackItems(packed, 3)).toEqual(items);
  });

  it('parses a translated reply, tolerant of spacing, CRLF and full-width digits', () => {
    const reply = 'Here you go:\r\n⟦0⟧\r\nXin chào thế giới\r\n\r\n ⟦ 1 ⟧ \nĐăng nhập\n\n⟦２⟧\nDòng 1\nDòng 2\n';
    expect(unpackItems(reply, 3)).toEqual(['Xin chào thế giới', 'Đăng nhập', 'Dòng 1\nDòng 2']);
  });

  it('missing, empty, duplicated, unknown or reordered markers give null for the items they touch', () => {
    expect(unpackItems('⟦0⟧\nA\n\n⟦2⟧\nC', 3)).toEqual(['A', null, 'C']);
    expect(unpackItems('⟦0⟧\n\n⟦1⟧\nB', 2)).toEqual([null, 'B']);
    expect(unpackItems('⟦0⟧\nA\n⟦1⟧\nB\n⟦1⟧\nB again', 2)).toEqual(['A', null]);
    // Text after an unknown marker is not appended to the previous item.
    expect(unpackItems('⟦0⟧\nA\n⟦7⟧\nstray', 2)).toEqual(['A', null]);
    // Markers removed or rewritten by the model.
    expect(unpackItems('A\n\nB', 2)).toEqual([null, null]);
    expect(unpackItems('[0]\nA\n[1]\nB', 2)).toEqual([null, null]);
    // Reordered: both items are suspect.
    expect(unpackItems('⟦1⟧\nB\n⟦0⟧\nA', 2)).toEqual([null, null]);
    expect(unpackItems('⟦0⟧\nA\n⟦2⟧\nC\n⟦1⟧\nB', 3)).toEqual(['A', null, null]);
  });

  it('accepts a marker followed by text on the same line', () => {
    expect(unpackItems('⟦0⟧\nXin chào\n\n⟦1⟧ Đăng nhập', 2)).toEqual(['Xin chào', 'Đăng nhập']);
    expect(unpackItems('⟦0⟧ Một\nhai\n⟦1⟧   Ba', 2)).toEqual(['Một\nhai', 'Ba']);
  });

  it('accepts markers wrapped in Markdown', () => {
    expect(unpackItems('⟦0⟧\nXin chào\n\n**⟦1⟧**\nĐăng nhập', 2)).toEqual(['Xin chào', 'Đăng nhập']);
    expect(unpackItems('**⟦0⟧** A\n_⟦1⟧_\nB\n`⟦2⟧`\nC\n\\⟦3\\⟧\nD\n# ⟦4⟧\nE\n- ⟦5⟧ F', 6)).toEqual([
      'A',
      'B',
      'C',
      'D',
      'E',
      'F',
    ]);
  });

  it('a marker inside a line poisons the current section and the named item', () => {
    expect(unpackItems('⟦0⟧\nXin chào ⟦1⟧ Đăng nhập', 2)).toEqual([null, null]);
    expect(unpackItems('⟦0⟧\nA\n⟦1⟧\nB (see ⟦2⟧)\n⟦2⟧\nC\n⟦3⟧\nD', 4)).toEqual(['A', null, null, 'D']);
    // Two markers on one line.
    expect(unpackItems('⟦0⟧ A ⟦1⟧ B\n⟦2⟧\nC', 3)).toEqual([null, null, 'C']);
    // A lone bracket is not trusted either.
    expect(unpackItems('⟦0⟧\nA ⟧\n⟦1⟧\nB', 2)).toEqual([null, 'B']);
  });

  it('never returns text containing a marker bracket (property)', () => {
    const pieces = [
      '⟦0⟧',
      '⟦1⟧',
      '⟦2⟧',
      '⟦７⟧',
      '**⟦1⟧**',
      '⟦',
      '⟧',
      ' ',
      '\n',
      '\n\n',
      'Xin chào',
      'Đăng',
      '*',
      '`',
      '\\',
      '-',
      '#',
    ];
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    for (let run = 0; run < 2000; run++) {
      let reply = '';
      const len = 1 + rand(30);
      for (let k = 0; k < len; k++) reply += pieces[rand(pieces.length)];
      for (const item of unpackItems(reply, 3)) {
        if (item !== null) expect(item).not.toMatch(/[⟦⟧]/);
      }
    }
  });

  it('plans requests within the size limit and skips unpackable items', () => {
    expect(isPackable('plain text')).toBe(true);
    expect(isPackable('before\n⟦3⟧\nafter')).toBe(false);
    expect(isPackable('inline ⟦ bracket')).toBe(false);
    const texts = ['a'.repeat(3200), 'b'.repeat(3200), 'c'.repeat(200), 'x\n⟦0⟧', 'd'.repeat(DEVDY_PACK_MAX_CHARS)];
    const { groups, skipped } = planPacks(texts);
    expect(skipped).toEqual([3, 4]);
    expect(groups).toEqual([[0, 1], [2]]);
    for (const g of groups) expect(packItems(g.map((i) => texts[i]!)).length).toBeLessThanOrEqual(DEVDY_PACK_CHARS);
    // A single item larger than the target but within Devdy's limit gets its own request.
    expect(planPacks(['e'.repeat(7000), 'f']).groups).toEqual([[0], [1]]);
  });
});

describe('translator sender: devdy requests and the stream port', () => {
  const req = (r: Omit<TranslatorRequest, 'target'>) => ({ target: TRANSLATOR_TARGET, ...r }) as TranslatorRequest;

  it('devdy-status from extension pages only, open-devdy-settings from any extension sender', () => {
    expect(rejectReason(req({ type: 'devdy-status' }), PAGE, ID)).toBeNull();
    expect(rejectReason(req({ type: 'devdy-status' }), CONTENT, ID)).toBe('Not allowed from a web page');
    expect(rejectReason(req({ type: 'open-devdy-settings' }), CONTENT, ID)).toBeNull();
    expect(rejectReason(req({ type: 'open-devdy-settings' }), { id: 'other', url: 'https://x/' }, ID)).toBe(
      'Unknown sender',
    );
  });

  it('the stream port accepts our content scripts and pages, nobody else', () => {
    expect(streamPortRejectReason({ name: TRANSLATOR_STREAM_PORT, sender: CONTENT }, ID)).toBeNull();
    expect(streamPortRejectReason({ name: TRANSLATOR_STREAM_PORT, sender: PAGE }, ID)).toBeNull();
    expect(streamPortRejectReason({ name: TRANSLATOR_STREAM_PORT, sender: { id: 'other' } }, ID)).toBe(
      'Unknown sender',
    );
    expect(streamPortRejectReason({ name: TRANSLATOR_STREAM_PORT }, ID)).toBe('Unknown sender');
    expect(streamPortRejectReason({ name: 'something-else', sender: CONTENT }, ID)).toBe('Unknown port');
  });

  it('validates stream requests', () => {
    const ok = { type: 'translate', text: 'Hello', sourceLang: 'english', targetLang: 'vietnamese' };
    expect(isStreamRequest(ok)).toBe(true);
    expect(isStreamRequest({ ...ok, text: 'a'.repeat(MAX_TEXT_CHARS + 1) })).toBe(false);
    expect(isStreamRequest({ ...ok, text: 42 })).toBe(false);
    expect(isStreamRequest({ ...ok, type: 'grammar-check' })).toBe(false);
    expect(isStreamRequest({ ...ok, targetLang: 'x'.repeat(65) })).toBe(false);
    expect(isStreamRequest(null)).toBe(false);
  });
});

describe('translate tab: devdy status line', () => {
  it('describes each state', () => {
    expect(devdyStatusLine({ state: 'ready', version: '0.9.0' })).toEqual({
      text: 'Devdy 0.9.0 found — translation ready.',
      tone: 'ok',
      openDevdyTab: false,
    });
    expect(devdyStatusLine({ state: 'not_running' }).text).toMatch(/not running or its Inbox API is turned off/);
    expect(devdyStatusLine({ state: 'no_token' }).openDevdyTab).toBe(true);
    expect(devdyStatusLine({ state: 'unauthorized' }).tone).toBe('error');
    expect(devdyStatusLine({ state: 'choose_instance' }).openDevdyTab).toBe(true);
    expect(devdyStatusLine({ state: 'unsupported' }).text).toMatch(/translate feature/);
  });
});
