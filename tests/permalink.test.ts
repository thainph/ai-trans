import { describe, expect, it } from 'vitest';
import { buildPermalink, parseThreadLink, pSegmentToTs, tsToPSegment } from '../src/core/permalink';

describe('parseThreadLink', () => {
  it('parses a workspace archive permalink', () => {
    const r = parseThreadLink('https://papay.slack.com/archives/C0123ABCD/p1700000000123456');
    expect(r).toEqual({
      ok: true,
      value: { workspaceDomain: 'papay', channelId: 'C0123ABCD', threadTs: '1700000000.123456' },
    });
  });

  it('uses thread_ts from a reply permalink', () => {
    const r = parseThreadLink(
      'https://papay.slack.com/archives/C0123ABCD/p1700000555000111?thread_ts=1700000000.123456&cid=C0123ABCD',
    );
    expect(r.ok && r.value).toEqual({
      workspaceDomain: 'papay',
      channelId: 'C0123ABCD',
      threadTs: '1700000000.123456',
    });
  });

  it('parses an app.slack.com client thread URL', () => {
    const r = parseThreadLink('https://app.slack.com/client/T0TEAM123/C0123ABCD/thread/C0123ABCD-1700000000.123456');
    expect(r.ok && r.value).toEqual({ teamId: 'T0TEAM123', channelId: 'C0123ABCD', threadTs: '1700000000.123456' });
  });

  it('accepts enterprise subdomains, private channels, DMs, whitespace and <> wrapping', () => {
    const r1 = parseThreadLink('  <https://acme.enterprise.slack.com/archives/G01PRIV/p1700000000123456>  ');
    expect(r1.ok && r1.value).toEqual({ workspaceDomain: 'acme.enterprise', channelId: 'G01PRIV', threadTs: '1700000000.123456' });
    const r2 = parseThreadLink('https://papay.slack.com/archives/D01DM/p1700000000123456');
    expect(r2.ok && r2.value.channelId).toBe('D01DM');
  });

  it.each([
    ['', 'EMPTY'],
    ['   ', 'EMPTY'],
    ['not a url', 'NOT_A_URL'],
    ['https://example.com/archives/C0123/p1700000000123456', 'NOT_SLACK'],
    ['http://papay.slack.com/archives/C0123/p1700000000123456', 'NOT_SLACK'],
    ['https://evilslack.com/archives/C0123/p1700000000123456', 'NOT_SLACK'],
    ['https://papay.slack.com/archives/C0123ABCD', 'UNSUPPORTED_FORMAT'],
    ['https://papay.slack.com/team/U0123', 'UNSUPPORTED_FORMAT'],
    ['https://papay.slack.com/archives/lowercase/p1700000000123456', 'UNSUPPORTED_FORMAT'],
    ['https://papay.slack.com/archives/C0123ABCD/p17000000001234', 'INVALID_TS'],
    ['https://papay.slack.com/archives/C0123ABCD/p1700000000123456?thread_ts=abc', 'INVALID_TS'],
    ['https://app.slack.com/client/T0TEAM123/C0123ABCD', 'UNSUPPORTED_FORMAT'],
    ['https://app.slack.com/client/T0TEAM123/C0123ABCD/thread/C0123ABCD-123', 'INVALID_TS'],
    ['https://app.slack.com/some/other', 'UNSUPPORTED_FORMAT'],
  ])('rejects %j with %s', (input, code) => {
    const r = parseThreadLink(input);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe(code);
      expect(r.error.message).toBeTruthy();
    }
  });
});

describe('ts helpers', () => {
  it('round-trips p-segment and ts', () => {
    expect(pSegmentToTs('p1700000000123456')).toBe('1700000000.123456');
    expect(pSegmentToTs('p123')).toBeNull();
    expect(tsToPSegment('1700000000.123456')).toBe('p1700000000123456');
  });

  it('builds a canonical permalink', () => {
    expect(buildPermalink('https://papay.slack.com/', 'C01', '1700000000.123456')).toBe(
      'https://papay.slack.com/archives/C01/p1700000000123456',
    );
    expect(buildPermalink('https://papay.slack.com', 'C01', '1700000000.123456')).toBe(
      'https://papay.slack.com/archives/C01/p1700000000123456',
    );
  });
});
