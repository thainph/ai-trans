import { describe, expect, it } from 'vitest';
import {
  createTextBatches,
  fitsInRequest,
  MAX_ITEM_CHARS,
  needsTranslation,
  RateLimiter,
  RetryBudget,
  TranslationCache,
  WeakOriginals,
  withOuterWhitespace,
} from '../src/features/translator/core/page-text';
import { MAX_BATCH_ITEMS, MAX_TEXT_CHARS } from '../src/features/translator/shared/messages';

describe('page text helpers', () => {
  it('needsTranslation skips numbers, URLs and letter-less text', () => {
    expect(needsTranslation('12,345.6 %')).toBe(false);
    expect(needsTranslation('https://example.com/x')).toBe(false);
    expect(needsTranslation('→ ✓ !!')).toBe(false);
    expect(needsTranslation('Hello 1')).toBe(true);
    expect(needsTranslation('日本語')).toBe(true);
  });

  it('createTextBatches caps characters and items per batch', () => {
    expect(createTextBatches(['aaaa', 'bbbb', 'cc'], 8)).toEqual([['aaaa', 'bbbb'], ['cc']]);
    expect(createTextBatches(['a', 'b', 'c'], 100, 2)).toEqual([['a', 'b'], ['c']]);
    expect(createTextBatches(['x'.repeat(50)], 10)).toEqual([['x'.repeat(50)]]);
    expect(createTextBatches([])).toEqual([]);
  });

  it('withOuterWhitespace keeps the spaces around a text node', () => {
    expect(withOuterWhitespace('  Hello ', 'Xin chào')).toBe('  Xin chào ');
    expect(withOuterWhitespace('Hi', 'Chào')).toBe('Chào');
    expect(withOuterWhitespace('   ', 'x')).toBe('   x');
  });

  it('TranslationCache dedupes missing texts and is scoped per language pair', () => {
    const cache = new TranslationCache(2);
    cache.use('en|vi|casual');
    expect(cache.missing(['a', 'b', 'a', 'c'])).toEqual(['a', 'b', 'c']);
    cache.set('a', 'A');
    expect(cache.missing(['a', 'b', 'a'])).toEqual(['b']);
    cache.set('b', 'B');
    cache.set('c', 'C'); // evicts the oldest ("a")
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('c')).toBe('C');
    cache.use('en|vi|casual');
    expect(cache.get('c')).toBe('C');
    cache.use('en|ja|casual');
    expect(cache.get('c')).toBeUndefined();
  });

  it('RateLimiter allows `max` per window and reports the wait', () => {
    let now = 0;
    const limiter = new RateLimiter(2, 1000, () => now);
    expect(limiter.tryAcquire()).toBe(true);
    now = 100;
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);
    expect(limiter.waitMs()).toBe(900);
    now = 1000;
    expect(limiter.waitMs()).toBe(0);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);
  });

  it('never builds a batch the service worker would refuse', () => {
    expect(fitsInRequest('x'.repeat(MAX_ITEM_CHARS))).toBe(true);
    expect(fitsInRequest('x'.repeat(MAX_ITEM_CHARS + 1))).toBe(false);
    expect(fitsInRequest('x'.repeat(MAX_TEXT_CHARS + 1))).toBe(false);
    const texts = [
      ...Array.from({ length: 500 }, (_, i) => `short text ${i}`),
      ...Array.from({ length: 30 }, () => 'y'.repeat(MAX_ITEM_CHARS)),
    ].filter(fitsInRequest);
    for (const batch of createTextBatches(texts)) {
      expect(batch.length).toBeLessThanOrEqual(MAX_BATCH_ITEMS);
      expect(batch.reduce((n, t) => n + t.length, 0)).toBeLessThanOrEqual(MAX_TEXT_CHARS);
    }
  });

  it('RetryBudget allows a bounded number of retries per text', () => {
    const budget = new RetryBudget(2);
    expect(budget.exhausted('a')).toBe(false);
    expect(budget.fail('a')).toBe(true);
    expect(budget.fail('a')).toBe(true);
    expect(budget.exhausted('a')).toBe(false);
    expect(budget.fail('a')).toBe(false);
    expect(budget.exhausted('a')).toBe(true);
    expect(budget.exhausted('b')).toBe(false);
    budget.clear();
    expect(budget.exhausted('a')).toBe(false);
  });

  it('WeakOriginals keeps the first original and restores every live node', () => {
    const originals = new WeakOriginals<{ data: string }>();
    const a = { data: 'Xin chào' };
    const b = { data: 'Thế giới' };
    originals.set(a, 'Hello');
    originals.set(a, 'ignored');
    originals.set(b, 'World');
    expect(originals.size).toBe(2);
    expect(originals.has(a)).toBe(true);
    originals.prune(); // nodes still referenced → kept
    expect(originals.size).toBe(2);
    originals.restoreAll((node, original) => {
      node.data = original;
    });
    expect([a.data, b.data]).toEqual(['Hello', 'World']);
    expect(originals.size).toBe(0);
    expect(originals.has(a)).toBe(false);
  });
});
