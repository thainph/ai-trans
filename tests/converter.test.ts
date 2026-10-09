// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { htmlToMarkdown } from '../src/features/web-to-md/core/converter';

const toMd = (html: string) =>
  htmlToMarkdown(html, {
    keepImages: true,
    keepLinks: true,
    baseUrl: 'https://example.com/docs/',
  });

describe('htmlToMarkdown: lists', () => {
  it('keeps simple items on one line', () => {
    expect(toMd('<ul><li>One   item</li><li>Two <b>bold</b></li></ul>')).toBe('- One item\n- Two **bold**\n');
  });

  it('puts card-like items (heading, meta, image) on indented lines', () => {
    const md = toMd(`
      <ul>
        <li><article><header><h3><a href="/r/1">Release one</a></h3></header>
          <time>2026年9月29日</time> <a href="/c">株式会社Malme</a>
          <div><img src="/i/1.jpg" alt="thumb"></div></article></li>
        <li><article><h3>Release two</h3><p>Summary</p></article></li>
      </ul>`);
    expect(md).toBe(
      [
        '- ### [Release one](https://example.com/r/1)',
        '  2026年9月29日 [株式会社Malme](https://example.com/c)',
        '  ![thumb](https://example.com/i/1.jpg)',
        '- ### Release two',
        '  Summary',
        '',
      ].join('\n'),
    );
  });

  it('indents continuation lines under nested and ordered markers', () => {
    const md = toMd('<ol start="3"><li><p>First</p><p>Second para</p><ul><li><p>a</p><p>b</p></li></ul></li></ol>');
    expect(md).toBe(['3. First', '   Second para', '  - a', '    b', ''].join('\n'));
  });

  it('keeps code fences inside items line by line', () => {
    const md = toMd('<ul><li><p>Run:</p><pre><code>npm i\nnpm test</code></pre></li></ul>');
    expect(md).toContain('- Run:\n  ```\n  npm i\n  npm test\n  ```');
  });
});

describe('htmlToMarkdown: images, headings, code', () => {
  it('uses the real URL of lazy-loaded images', () => {
    expect(toMd('<img src="data:image/gif;base64,R0lGOD" data-src="/real.png" alt="a">')).toContain(
      '![a](https://example.com/real.png)',
    );
    expect(toMd('<img src="data:image/svg+xml,x" srcset="/s.png 1x, /l.png 2x" alt="b">')).toContain(
      '![b](https://example.com/l.png)',
    );
    expect(toMd('<img src="/plain.png" data-src="/other.png" alt="c">')).toContain(
      '![c](https://example.com/plain.png)',
    );
  });

  it('renders ATX headings and fenced code', () => {
    const md = toMd('<h2>Title</h2><pre><code class="language-js">const a = 1;</code></pre>');
    expect(md).toContain('## Title');
    expect(md).toContain('```js\nconst a = 1;\n```');
  });
});
