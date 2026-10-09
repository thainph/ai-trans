import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import {
  collectImageUrls,
  firstLineTitle,
  imageExtension,
  planImages,
  rewriteImageLinks,
  webFrontMatter,
} from '../src/features/web-to-md/core/web-capture';

describe('firstLineTitle', () => {
  it('uses the first non-empty line, collapsed and capped', () => {
    expect(firstLineTitle('\n\n   Deploy   failed on staging  \nsecond line')).toBe('Deploy failed on staging');
    expect(firstLineTitle('   \n\t')).toBeUndefined();
    const long = 'あ'.repeat(200);
    const t = firstLineTitle(long)!;
    expect(Array.from(t)).toHaveLength(120);
    expect(t.endsWith('…')).toBe(true);
  });
});

describe('webFrontMatter', () => {
  const at = new Date('2026-10-09T10:00:00Z');

  it('emits the Devdy web-page keys as valid YAML', () => {
    const fm = webFrontMatter(
      {
        url: 'https://v2.tauri.app/security/capabilities/?utm_source=x#top',
        pageTitle: 'Capabilities | Tauri',
        siteName: 'Tauri',
        author: 'Jane "J" Doe',
        description: 'How: to configure #capabilities',
        publishedAt: '2026-09-01',
      },
      { title: 'Capabilities define: what a window may do', selection: true, capturedAt: at },
    );
    const parsed = YAML.parse(fm.split('---')[1]!);
    expect(parsed).toEqual({
      title: 'Capabilities define: what a window may do',
      url: 'https://v2.tauri.app/security/capabilities/?utm_source=x#top',
      site_name: 'Tauri',
      author: 'Jane "J" Doe',
      published_at: '2026-09-01',
      captured_at: '2026-10-09T10:00:00.000Z',
      description: 'How: to configure #capabilities',
      selection: true,
    });
    expect(fm.endsWith('---\n\n')).toBe(true);
  });

  it('falls back to the page title and omits empty fields', () => {
    const parsed = YAML.parse(
      webFrontMatter({ url: 'https://example.com/', pageTitle: 'Example' }, { selection: false, capturedAt: at }).split(
        '---',
      )[1]!,
    );
    expect(parsed).toEqual({
      title: 'Example',
      url: 'https://example.com/',
      captured_at: '2026-10-09T10:00:00.000Z',
      selection: false,
    });
  });
});

describe('images', () => {
  const md = [
    '![Fig 1](https://cdn.example.com/a/diagram.final.png?v=2)',
    '![](https://cdn.example.com/a/diagram.final.png?v=2)', // duplicate
    '![logo](data:image/png;base64,iVBORw0KGgo=)',
    '![bad](javascript:alert(1))',
    '![rel](/relative.png)',
    '[not an image](https://example.com/x.png)',
    '![Ảnh màn hình](https://example.com/files/%E1%BA%A2nh%20m%C3%A0n%20h%C3%ACnh)',
  ].join('\n');

  it('collects unique fetchable image URLs only', () => {
    expect(collectImageUrls(md)).toEqual([
      'https://cdn.example.com/a/diagram.final.png?v=2',
      'data:image/png;base64,iVBORw0KGgo=',
      'https://example.com/files/%E1%BA%A2nh%20m%C3%A0n%20h%C3%ACnh',
    ]);
  });

  it('plans numbered, safe paths without extension', () => {
    expect(planImages(collectImageUrls(md)).map((p) => p.pathBase)).toEqual([
      'images/01-diagram-final',
      'images/02-image',
      'images/03-Ảnh-màn-hình',
    ]);
    expect(planImages(['https://a/1.png', 'https://a/2.png', 'https://a/3.png'], 2)).toHaveLength(2);
  });

  it('derives the extension from Content-Type, then the URL', () => {
    expect(imageExtension('image/jpeg; charset=binary')).toBe('jpg');
    expect(imageExtension('image/svg+xml')).toBe('svg');
    expect(imageExtension('application/octet-stream', 'https://x/y/photo.WEBP?x=1')).toBe('webp');
    expect(imageExtension(null, 'data:image/png;base64,AAA')).toBe('img');
  });

  it('rewrites only saved images to their zip paths', () => {
    const saved = new Map([['https://cdn.example.com/a/diagram.final.png?v=2', 'images/01-diagram-final.png']]);
    const out = rewriteImageLinks(md, saved);
    expect(out.split('\n').slice(0, 2)).toEqual([
      '![Fig 1](images/01-diagram-final.png)',
      '![](images/01-diagram-final.png)',
    ]);
    expect(out).toContain('![logo](data:image/png;base64,iVBORw0KGgo=)');
    expect(out).toContain('[not an image](https://example.com/x.png)');
  });
});
