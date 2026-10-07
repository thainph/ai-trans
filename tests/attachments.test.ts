import { describe, expect, it } from 'vitest';
import {
  isAllowedFileUrl,
  isCompressiblePath,
  planAttachments,
  safeFileName,
  type AttachmentOutcome,
} from '../src/core/attachments';
import { buildThreadMarkdown, type ThreadData } from '../src/core/md-builder';
import type { SlackFile, SlackMessage } from '../src/types/slack';

const MB = 1024 * 1024;

function msg(ts: string, files: SlackFile[]): SlackMessage {
  return { type: 'message', ts, user: 'U1', text: `message ${ts}`, files } as SlackMessage;
}

const png: SlackFile = {
  id: 'F1',
  name: 'Screen Shot (1).png',
  mimetype: 'image/png',
  size: 1000,
  url_private_download: 'https://files.slack.com/files-pri/T1-F1/download/screen_shot.png',
  permalink: 'https://acme.slack.com/files/U1/F1/screen_shot.png',
};
const pdf: SlackFile = {
  id: 'F2',
  name: 'spec.pdf',
  mimetype: 'application/pdf',
  size: 2 * MB,
  url_private: 'https://files.slack.com/files-pri/T1-F2/spec.pdf',
  permalink: 'https://acme.slack.com/files/U1/F2/spec.pdf',
};

describe('isAllowedFileUrl', () => {
  it.each([
    ['https://files.slack.com/files-pri/T1-F1/download/a.png', true],
    ['https://acme.slack.com/files/U1/F1/a.png', true],
    ['http://files.slack.com/a.png', false],
    ['https://files.slack.com.evil.tld/a.png', false],
    ['https://files.slack.com@evil.tld/a.png', false],
    ['https://files.slack.com:8443/a.png', false],
    ['https://example.com/a.png', false],
    [undefined, false],
  ])('%s -> %s', (url, ok) => {
    expect(isAllowedFileUrl(url)).toBe(ok);
  });
});

describe('safeFileName', () => {
  it('keeps the extension and replaces unsafe characters', () => {
    expect(safeFileName('Screen Shot (1).png')).toBe('Screen-Shot-1.png');
    expect(safeFileName('Ảnh màn hình.JPG')).toBe('Ảnh-màn-hình.jpg');
    expect(safeFileName('../../etc/passwd')).toBe('etc-passwd');
    expect(safeFileName('noext')).toBe('noext');
    expect(safeFileName('')).toBe('file');
  });

  it('truncates long names but keeps the extension', () => {
    const out = safeFileName(`${'a'.repeat(200)}.pdf`, 40);
    expect(out.endsWith('.pdf')).toBe(true);
    expect(out.length).toBe(40);
  });
});

describe('planAttachments', () => {
  it('plans Slack-hosted files in thread order with unique numbered paths', () => {
    const dup: SlackFile = { ...pdf, id: 'F3', name: 'spec.pdf' };
    const plan = planAttachments([msg('1.0', [png]), msg('2.0', [pdf, png, dup])]);
    expect(plan.downloads.map((d) => [d.id, d.path, d.isImage])).toEqual([
      ['F1', 'files/01-Screen-Shot-1.png', true],
      ['F2', 'files/02-spec.pdf', false],
      ['F3', 'files/03-spec.pdf', false],
    ]);
    // url_private_download preferred, url_private as fallback
    expect(plan.downloads[0]!.url).toContain('/download/');
    expect(plan.downloads[1]!.url).toBe(pdf.url_private);
    expect(plan.skipped.size).toBe(0);
  });

  it('skips external, URL-less, oversized files and respects the total cap', () => {
    const plan = planAttachments(
      [
        msg('1.0', [
          { id: 'E', name: 'doc', is_external: true, url_private: 'https://docs.google.com/x' },
          { id: 'N', name: 'n.txt' },
          { id: 'X', name: 'x.bin', url_private: 'https://evil.tld/x.bin' },
          { ...pdf, id: 'BIG', size: 30 * MB },
          { ...pdf, id: 'A', size: 6 * MB },
          { ...pdf, id: 'B', size: 6 * MB },
          { id: 'T', mode: 'tombstone' },
        ]),
      ],
      { maxFileBytes: 25 * MB, maxTotalBytes: 10 * MB },
    );
    expect(plan.downloads.map((d) => d.id)).toEqual(['A']);
    expect(Object.fromEntries([...plan.skipped].map(([id, o]) => [id, o.kind === 'skipped' ? o.reason : '']))).toEqual({
      E: 'external file',
      N: 'no downloadable URL',
      X: 'no downloadable URL',
      BIG: 'too large (30.0 MB > 25.0 MB)',
      B: 'export size limit (10.0 MB) reached',
    });
    expect(plan.skipped.has('T')).toBe(false);
  });
});

describe('isCompressiblePath', () => {
  it('deflates text-like files only', () => {
    expect(isCompressiblePath('thread.md')).toBe(true);
    expect(isCompressiblePath('files/01-log.TXT')).toBe(true);
    expect(isCompressiblePath('files/02-a.png')).toBe(false);
    expect(isCompressiblePath('files/03-a.zip')).toBe(false);
  });
});

describe('buildThreadMarkdown with attachments', () => {
  const data: ThreadData = {
    workspace: { name: 'Acme' },
    channel: { id: 'C1', name: 'general' },
    threadUrl: 'https://acme.slack.com/archives/C1/p1000000000000000',
    messages: [msg('1000000000.000000', [png, pdf, { ...pdf, id: 'F9', name: 'a [draft].pdf' }])],
    users: { U1: 'alice' },
    channels: {},
  };

  it('links saved files locally, embeds images, and annotates skipped ones', () => {
    const attachments = new Map<string, AttachmentOutcome>([
      ['F1', { kind: 'saved', path: 'files/01-Screen-Shot-1.png', isImage: true }],
      ['F2', { kind: 'skipped', reason: 'download failed: HTTP 403' }],
      ['F9', { kind: 'saved', path: 'files/03-a-draft.pdf', isImage: false }],
    ]);
    const { markdown } = buildThreadMarkdown(data, { includeReactions: false, includeFiles: true, attachments });
    expect(markdown).toContain('![Screen Shot (1).png](files/01-Screen-Shot-1.png)');
    expect(markdown).toContain(
      '📎 spec.pdf — https://acme.slack.com/files/U1/F2/spec.pdf _(not included: download failed: HTTP 403)_',
    );
    expect(markdown).toContain('📎 [a \\[draft\\].pdf](files/03-a-draft.pdf)');
  });

  it('keeps the original link format without attachment outcomes', () => {
    const { markdown } = buildThreadMarkdown(data, { includeReactions: false, includeFiles: true });
    expect(markdown).toContain('📎 Screen Shot (1).png — https://acme.slack.com/files/U1/F1/screen_shot.png');
  });
});
