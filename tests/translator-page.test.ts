import { describe, expect, it } from 'vitest';
import {
  createTextBatches,
  needsTranslation,
  RateLimiter,
  TranslationCache,
  withOuterWhitespace,
} from '../src/features/translator/core/page-text';

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
});
