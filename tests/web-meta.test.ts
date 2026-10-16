// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { extractInPage } from '../src/features/web-to-md/core/extract';
import { bestImageSrc, largestFromSrcset } from '../src/features/web-to-md/core/image-src';

const setUrl = (url: string) => (window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL(url);

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('image sources', () => {
  it('picks the largest srcset candidate (w or x descriptors)', () => {
    expect(largestFromSrcset('a.png 480w, b.png 960w, c.png 720w')).toBe('b.png');
    expect(largestFromSrcset('a.png 1x, b.png 2x')).toBe('b.png');
    expect(largestFromSrcset('only.png')).toBe('only.png');
    expect(largestFromSrcset(null)).toBeNull();
  });

  it('prefers lazy-loading attributes over placeholder src', () => {
    document.body.innerHTML = `
      <img id="lazy" src="data:image/gif;base64,R0lGOD" data-src="/real.png">
      <img id="set" src="data:image/svg+xml,%3Csvg%3E" srcset="/s.png 1x, /l.png 2x">
      <img id="plain" src="/plain.png" data-src="/ignored.png">`;
    expect(bestImageSrc(document.getElementById('lazy')!)).toBe('/real.png');
    expect(bestImageSrc(document.getElementById('set')!)).toBe('/l.png');
    expect(bestImageSrc(document.getElementById('plain')!)).toBe('/plain.png');
  });
});

describe('page metadata (extractInPage)', () => {
  const meta = () => extractInPage('article', 'meta').meta;

  it('reads og/meta tags with sensible fallbacks', () => {
    document.head.innerHTML = `
      <title>Fallback title</title>
      <meta property="og:title" content="Capabilities">
      <meta property="og:site_name" content="Tauri">
      <meta name="author" content="Jane">
      <meta name="description" content="How to">
      <meta property="article:published_time" content="2026-09-01">`;
    setUrl('https://v2.tauri.app/x');
    expect(meta()).toEqual({
      url: 'https://v2.tauri.app/x',
      pageTitle: 'Capabilities',
      siteName: 'Tauri',
      author: 'Jane',
      description: 'How to',
      publishedAt: '2026-09-01',
    });
  });

  it('falls back to <title> and the host name', () => {
    document.head.innerHTML = '<title> Plain page </title>';
    setUrl('https://www.example.com/a');
    expect(meta()).toMatchObject({ pageTitle: 'Plain page', siteName: 'example.com', author: undefined });
  });
});
