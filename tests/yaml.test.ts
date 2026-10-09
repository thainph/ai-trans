import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { webFrontMatter } from '../src/features/web-to-md/core/web-capture';
import { frontMatter, yamlPlain, yamlScalar } from '../src/shared/yaml';

/** Body of a `---\n…\n---` block, checked to be one line per field. */
function body(fm: string, fieldCount: number): string {
  const lines = fm.trimEnd().split('\n');
  expect(lines[0]).toBe('---');
  expect(lines.at(-1)).toBe('---');
  // Values never spill onto extra lines (no raw newline, no "---" line inside).
  expect(lines).toHaveLength(fieldCount + 2);
  return lines.slice(1, -1).join('\n');
}

const TRICKY = [
  'line one\nline two',
  'crlf\r\nend',
  'trailing newline\n',
  'tab\tinside',
  'back\\slash \\n not a newline',
  'ends with backslash\\',
  'double "quoted" text',
  "single 'quoted' text",
  'key: value',
  'trailing colon:',
  'hash # not a comment',
  '#leading hash',
  '- leading dash',
  '-',
  '---',
  '--- inside --- value',
  '...',
  '? question',
  ': colon first',
  '*alias',
  '&anchor',
  '!tag',
  '%directive',
  '@reserved',
  '`backtick',
  '|literal',
  '>folded',
  '[flow, seq]',
  '{flow: map}',
  '"',
  "'",
  ' leading space',
  'trailing space ',
  'yes',
  'No',
  'null',
  '~',
  '0x1F',
  '1e3',
  '2026-10-09',
  'control \u0001\u001f chars',
  'del \u007f char',
  'separators    here',
  'bom ﻿ inside',
  'emoji 🚀 and 日本語',
];

describe('shared/yaml', () => {
  it('round-trips tricky strings as block values', () => {
    for (const value of TRICKY) {
      const parsed = YAML.parse(body(frontMatter({ v: value }), 1));
      expect(parsed, JSON.stringify(value)).toEqual({ v: value });
    }
  });

  it('round-trips tricky strings as plain-when-safe values and flow-sequence items', () => {
    for (const value of TRICKY) {
      const fm = frontMatter({ p: yamlPlain(value), list: [value, 'b'] });
      const parsed = YAML.parse(body(fm, 2));
      expect(parsed, JSON.stringify(value)).toEqual({ p: value, list: [value, 'b'] });
    }
  });

  it('keeps simple words plain and quotes everything else', () => {
    expect(yamlScalar('Tauri docs')).toBe('Tauri docs');
    expect(yamlScalar('a: b')).toBe('"a: b"');
    expect(yamlScalar('-x')).toBe('"-x"');
    expect(yamlScalar('a\nb')).toBe('"a\\nb"');
  });

  it('Web → MD front matter survives hostile page metadata', () => {
    const page = {
      url: 'https://example.com/a?b=c&d="e"#f',
      pageTitle: '--- "Title": with\nnewline \\ and #hash',
      siteName: '- Site: name',
      author: 'O\'Brien \\ "Doc"',
      description: 'Line 1\r\nLine 2\n\n---\nnot: a key',
      publishedAt: '2026-09-01T10:00:00+09:00',
    };
    const fm = webFrontMatter(page, { selection: false, capturedAt: new Date('2026-10-09T10:00:00Z') });
    expect(YAML.parse(body(fm, 8))).toEqual({
      title: page.pageTitle,
      url: page.url,
      site_name: page.siteName,
      author: page.author,
      published_at: page.publishedAt,
      captured_at: '2026-10-09T10:00:00.000Z',
      description: page.description,
      selection: false,
    });
  });
});
