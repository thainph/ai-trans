// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { extractInPage } from '../src/features/web-to-md/core/extract';

// chrome.scripting.executeScript serializes `func`: it must work standalone.
const revived = new Function(`return (${extractInPage.toString()});`)() as typeof extractInPage;

const card = (i: number) => `
  <article class="list-article">
    <header><h3><a href="/r/${i}">Press release ${i} title</a></h3></header>
    <time>2026年9月${i}日</time><span>株式会社Malme</span>
  </article>`;

beforeEach(() => {
  document.head.innerHTML = '<title>Test</title>';
  document.body.innerHTML = '';
});

describe('extractInPage (main content)', () => {
  it('takes every card of a listing page, not just the first <article>', () => {
    document.body.innerHTML = `
      <header id="site"><nav><a href="/">Top</a><a href="/login">Login</a></nav></header>
      <main>
        <h1>株式会社Malmeのプレスリリース</h1>
        <section class="list">${Array.from({ length: 24 }, (_, i) => card(i + 1)).join('')}</section>
      </main>
      <footer>© PR TIMES</footer>`;
    const r = extractInPage('article');
    for (const i of [1, 12, 24]) expect(r.html).toContain(`Press release ${i} title`);
    expect(r.html).toContain('株式会社Malmeのプレスリリース');
    // the cards keep their own <header> (title), page chrome is dropped
    expect((r.html.match(/<header>/g) ?? []).length).toBe(24);
    expect(r.html).not.toContain('Login');
    expect(r.html).not.toContain('© PR TIMES');
  });

  it('uses the common container of the cards when there is no <main>', () => {
    document.body.innerHTML = `
      <nav>menu</nav>
      <div id="wrap"><div id="list">${card(1)}${card(2)}${card(3)}</div><div id="side">ads</div></div>`;
    const r = extractInPage('article');
    expect(r.html).toContain('Press release 1 title');
    expect(r.html).toContain('Press release 3 title');
    expect(r.html).not.toContain('ads');
  });

  it('picks the single big <article> on an article page', () => {
    const para = `<p>${'Long paragraph of the story. '.repeat(30)}</p>`;
    document.body.innerHTML = `
      <main>
        <article id="story"><header><h1>Story title</h1></header>${para.repeat(5)}</article>
        <aside><article><h4>Related story</h4></article></aside>
      </main>`;
    const r = extractInPage('article');
    expect(r.html).toContain('Story title');
    expect(r.html).toContain('Long paragraph of the story.');
    expect(r.html).not.toContain('Related story');
  });

  it('falls back to <main>, then to the densest block', () => {
    document.body.innerHTML = `<nav>menu</nav><main><h1>Docs</h1><p>Body text</p></main><footer>foot</footer>`;
    expect(extractInPage('article').html).toContain('Body text');

    document.body.innerHTML = `
      <div id="menu"><a href="/a">a</a><a href="/b">b</a></div>
      <div id="content"><p>${'Real content here. '.repeat(20)}</p><p>More</p></div>`;
    const r = extractInPage('article');
    expect(r.html).toContain('Real content here.');
    expect(r.textLen).toBeGreaterThan(100);
  });

  it('keeps "full" mode as the whole body', () => {
    document.body.innerHTML = `<nav>menu</nav><main>${card(1)}${card(2)}</main>`;
    const r = extractInPage('full');
    expect(r.html).toContain('menu');
    expect(r.html).toContain('Press release 2 title');
  });
});

describe('extractInPage (depth)', () => {
  it('"score" reports the text length without the HTML', () => {
    document.body.innerHTML = '<main><h1>Docs</h1><p>Body text</p></main>';
    const full = extractInPage('article', 'content');
    const score = extractInPage('article', 'score');
    expect(score.html).toBe('');
    expect(score.textLen).toBe(full.textLen);
    expect(score.textLen).toBeGreaterThan(0);
    expect(score.meta).toEqual(full.meta);
  });

  it('"score" drops the selected text, "content" keeps it', () => {
    document.body.innerHTML = '<p id="p">Selected words</p>';
    const range = document.createRange();
    range.selectNodeContents(document.getElementById('p')!);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    const score = extractInPage('selection', 'score');
    expect(score.text).toBeUndefined();
    expect(score.textLen).toBe('Selected words'.length);
    expect(extractInPage('selection', 'content').text).toBe('Selected words');
  });

  it('"meta" skips extraction', () => {
    document.head.innerHTML = '<title>T</title><meta property="og:site_name" content="S">';
    document.body.innerHTML = '<main><p>Body</p></main>';
    const r = extractInPage('full', 'meta');
    expect(r).toMatchObject({ html: '', textLen: 0, meta: { pageTitle: 'T', siteName: 'S' } });
  });
});

describe('extractInPage (serialized)', () => {
  it('runs after toString() serialization like chrome.scripting does', () => {
    document.head.innerHTML = '<title>Doc</title><meta property="og:site_name" content="Site">';
    document.body.innerHTML = '<main><h1>Docs</h1><p>Body text</p></main>';
    const r = revived('article');
    expect(r.html).toContain('Body text');
    expect(r.meta.pageTitle).toBe('Doc');
    expect(r.meta.siteName).toBe('Site');
  });
});
