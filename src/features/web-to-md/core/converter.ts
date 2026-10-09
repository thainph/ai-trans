// htmlToMarkdown — a small dependency-free HTML → Markdown converter (needs
// DOMParser: popup pages and content scripts).

import { bestImageSrc } from './image-src';

export interface ConvertOptions {
  keepImages: boolean;
  keepLinks: boolean;
  /** Base for relative links/images. */
  baseUrl: string;
}

interface ListContext {
  depth: number;
}

const BLOCK = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'DIV',
  'DL',
  'FIELDSET',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'FORM',
  'HEADER',
  'HR',
  'MAIN',
  'NAV',
  'SECTION',
  'TABLE',
  'UL',
  'OL',
  'P',
  'PRE',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
]);

const SKIP = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'IFRAME',
  'SVG',
  'CANVAS',
  'TEMPLATE',
  'HEAD',
  'INPUT',
  'BUTTON',
  'SELECT',
  'TEXTAREA',
  'OBJECT',
  'EMBED',
  'AUDIO',
  'VIDEO',
  'MAP',
]);

function collapse(s: string): string {
  return s.replace(/[ \t\r\n]+/g, ' ');
}

function walk(node: Node, opts: ConvertOptions, listCtx: ListContext): string {
  let out = '';
  for (const child of node.childNodes) {
    out += render(child, opts, listCtx);
  }
  return out;
}

function absUrl(url: string | null, baseUrl: string): string {
  if (!url) return '';
  try {
    return new URL(url, baseUrl).href;
  } catch {
    return url;
  }
}

function render(node: Node, opts: ConvertOptions, listCtx: ListContext): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return collapse(node.nodeValue ?? '');
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const el = node as Element;

  const tag = el.tagName;
  if (SKIP.has(tag)) return '';
  if (el.getAttribute('aria-hidden') === 'true') return '';

  switch (tag) {
    case 'H1':
    case 'H2':
    case 'H3':
    case 'H4':
    case 'H5':
    case 'H6': {
      const level = Number(tag[1]);
      const text = walk(el, opts, listCtx).trim();
      if (!text) return '';
      return `\n\n${'#'.repeat(level)} ${text}\n\n`;
    }
    case 'P': {
      const text = walk(el, opts, listCtx).trim();
      return text ? `\n\n${text}\n\n` : '';
    }
    case 'BR':
      return '  \n';
    case 'HR':
      return '\n\n---\n\n';
    case 'STRONG':
    case 'B': {
      const t = walk(el, opts, listCtx).trim();
      return t ? `**${t}**` : '';
    }
    case 'EM':
    case 'I': {
      const t = walk(el, opts, listCtx).trim();
      return t ? `*${t}*` : '';
    }
    case 'DEL':
    case 'S':
    case 'STRIKE': {
      const t = walk(el, opts, listCtx).trim();
      return t ? `~~${t}~~` : '';
    }
    case 'CODE': {
      // Inside PRE it is handled by the PRE case.
      if (el.closest('pre')) return el.textContent ?? '';
      const t = el.textContent;
      return t ? `\`${t.replace(/`/g, '\\`')}\`` : '';
    }
    case 'PRE': {
      const codeEl = el.querySelector('code');
      const raw = ((codeEl ? codeEl.textContent : el.textContent) ?? '').replace(/\n$/, '');
      let lang = '';
      if (codeEl?.className) {
        const m = codeEl.className.match(/language-([\w+-]+)/);
        if (m) lang = m[1]!;
      }
      return `\n\n\`\`\`${lang}\n${raw}\n\`\`\`\n\n`;
    }
    case 'BLOCKQUOTE': {
      const inner = walk(el, opts, listCtx).trim();
      if (!inner) return '';
      const quoted = inner
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n');
      return `\n\n${quoted}\n\n`;
    }
    case 'A': {
      const text = walk(el, opts, listCtx).trim();
      if (!opts.keepLinks) return text;
      const href = absUrl(el.getAttribute('href'), opts.baseUrl);
      if (!href || href.startsWith('javascript:')) return text;
      return text ? `[${text}](${href})` : '';
    }
    case 'IMG': {
      if (!opts.keepImages) return '';
      const src = absUrl(bestImageSrc(el), opts.baseUrl);
      if (!src) return '';
      const alt = (el.getAttribute('alt') || '').trim();
      return `![${alt}](${src})`;
    }
    case 'UL':
    case 'OL': {
      return `\n${renderList(el, opts, listCtx)}\n`;
    }
    case 'LI': {
      // Handled by renderList; a stray <li> renders as text.
      return walk(el, opts, listCtx).trim();
    }
    case 'TABLE': {
      return renderTable(el, opts, listCtx);
    }
    case 'FIGCAPTION': {
      const t = walk(el, opts, listCtx).trim();
      return t ? `\n\n*${t}*\n\n` : '';
    }
    default: {
      let out = walk(el, opts, listCtx);
      if (BLOCK.has(tag)) out = `\n\n${out.trim()}\n\n`;
      return out;
    }
  }
}

// A list item's content may be several blocks (a card: heading, date line,
// image…). The first block goes on the marker line, later lines are indented
// under it; a plain one-liner stays on one line. Code fences keep their lines.
function formatListItem(text: string, indent: string, marker: string): string {
  const pad = indent + ' '.repeat(marker.length);
  const blocks = text
    .trim()
    .split(/\n[ \t]*\n+/)
    .map((b) => b.trim())
    .filter(Boolean);
  const lines: string[] = [];
  for (const b of blocks) {
    if (/^```/.test(b)) lines.push(...b.split('\n'));
    else
      lines.push(
        ...b
          .split('\n')
          .map((l) => l.replace(/\s+/g, ' ').trim())
          .filter(Boolean),
      );
  }
  if (!lines.length) return indent + marker.trimEnd();
  return (
    indent +
    marker +
    lines[0] +
    lines
      .slice(1)
      .map((l) => `\n${pad}${l}`)
      .join('')
  );
}

function renderList(listNode: Element, opts: ConvertOptions, listCtx: ListContext): string {
  const ordered = listNode.tagName === 'OL';
  const depth = listCtx?.depth || 0;
  const indent = '  '.repeat(depth);
  let idx = ordered ? parseInt(listNode.getAttribute('start') ?? '', 10) || 1 : 0;
  const lines: string[] = [];
  for (const li of listNode.children) {
    if (li.tagName !== 'LI') continue;
    const marker = ordered ? `${idx++}. ` : '- ';
    // Nested lists are rendered after the item's own text.
    const nested: Element[] = [];
    for (const c of Array.from(li.children)) {
      if (c.tagName === 'UL' || c.tagName === 'OL') nested.push(c);
    }
    let text = '';
    for (const c of li.childNodes) {
      if (c.nodeType === Node.ELEMENT_NODE && ((c as Element).tagName === 'UL' || (c as Element).tagName === 'OL')) {
        continue;
      }
      text += render(c, opts, listCtx);
    }
    lines.push(formatListItem(text, indent, marker));
    for (const nl of nested) {
      lines.push(renderList(nl, opts, { depth: depth + 1 }));
    }
  }
  return lines.join('\n');
}

function renderTable(tableNode: Element, opts: ConvertOptions, listCtx: ListContext): string {
  const rows = Array.from(tableNode.querySelectorAll('tr'));
  if (!rows.length) return '';
  const grid = rows.map((tr) =>
    Array.from(tr.querySelectorAll('th,td')).map((cell) =>
      walk(cell, opts, listCtx).replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim(),
    ),
  );
  const cols = Math.max(...grid.map((r) => r.length));
  if (cols === 0) return '';
  const pad = (r: string[]) => {
    while (r.length < cols) r.push('');
    return r;
  };
  const header = pad(grid[0]!);
  let md = `\n\n| ${header.join(' | ')} |\n`;
  md += `| ${new Array(cols).fill('---').join(' | ')} |\n`;
  for (let i = 1; i < grid.length; i++) {
    md += `| ${pad(grid[i]!).join(' | ')} |\n`;
  }
  return `${md}\n`;
}

function cleanup(md: string): string {
  return `${md
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+|\s+$/g, '')}\n`;
}

export function htmlToMarkdown(html: string, options: Partial<ConvertOptions> = {}): string {
  const opts: ConvertOptions = { keepImages: true, keepLinks: true, baseUrl: '', ...options };
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // Drop leftover noise elements.
  doc.querySelectorAll('script,style,noscript,template,svg,iframe').forEach((el) => {
    el.remove();
  });
  const md = walk(doc.body || doc.documentElement, opts, { depth: 0 });
  return cleanup(md);
}
