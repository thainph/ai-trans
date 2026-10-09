// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { pageMeta, selectionHtml } from '../src/features/web-to-md/content/selection';
import { bestImageSrc, largestFromSrcset } from '../src/features/web-to-md/core/image-src';

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

describe('selectionHtml', () => {
  it('clones the selected fragment with absolute, real image URLs', () => {
    document.body.innerHTML = `
      <article><p id="p1">Deploy failed <b>badly</b></p>
      <figure><img id="i" src="data:image/gif;base64,R0lGOD" data-src="img/fig1.png" srcset="x.png 1x"></figure>
      <p id="p2">Second paragraph</p><p id="after">not selected</p></article>`;
    const range = document.createRange();
    range.setStartBefore(document.getElementById('p1')!);
    range.setEndAfter(document.getElementById('p2')!);
    const html = selectionHtml(range, 'https://example.com/docs/page.html');
    expect(html).toContain('Deploy failed <b>badly</b>');
    expect(html).toContain('src="https://example.com/docs/img/fig1.png"');
    expect(html).not.toContain('srcset');
    expect(html).not.toContain('not selected');
    // the live page is untouched
    expect(document.getElementById('i')!.getAttribute('src')).toBe('data:image/gif;base64,R0lGOD');
  });
});

describe('pageMeta', () => {
  it('reads og/meta tags with sensible fallbacks', () => {
    document.head.innerHTML = `
      <title>Fallback title</title>
      <meta property="og:title" content="Capabilities">
      <meta property="og:site_name" content="Tauri">
      <meta name="author" content="Jane">
      <meta name="description" content="How to">
      <meta property="article:published_time" content="2026-09-01">`;
    expect(pageMeta(document, 'https://v2.tauri.app/x')).toEqual({
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
    expect(pageMeta(document, 'https://www.example.com/a')).toMatchObject({
      pageTitle: 'Plain page',
      siteName: 'example.com',
      author: undefined,
    });
  });
});
