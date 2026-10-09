// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import extractSource from '../public/web-to-md/extract.js?raw';

type Extracted = { html: string; textLen: number; title: string };
const extractInPage = new Function(`${extractSource}; return extractInPage;`)() as (mode: string) => Extracted;

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
    const para = '<p>' + 'Long paragraph of the story. '.repeat(30) + '</p>';
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
