import { describe, expect, it } from 'vitest';
import type { RenderContext } from '../src/features/slack/core/mrkdwn-to-md';
import { applyStyle, layoutBlocksToMd, richTextBlocksToMd } from '../src/features/slack/core/rich-text-to-md';
import type { SlackBlock } from '../src/features/slack/core/types';

const ctx: RenderContext = {
  userName: (id) => ({ U1: 'Alice' })[id] ?? id,
  channelName: (id) => ({ C1: 'general' })[id],
};

const rt = (...elements: unknown[]): SlackBlock[] => [{ type: 'rich_text', elements }];
const section = (...elements: unknown[]) => ({ type: 'rich_text_section', elements });

describe('applyStyle', () => {
  it('wraps styles and keeps whitespace outside markers', () => {
    expect(applyStyle(' hi ', { bold: true })).toBe(' **hi** ');
    expect(applyStyle('x', { bold: true, italic: true, strike: true })).toBe('***~~x~~***');
    expect(applyStyle('a`b', { code: true })).toBe('``a`b``');
  });

  it('picks an inline code delimiter longer than any backtick run inside (finding #5)', () => {
    expect(applyStyle('x', { code: true })).toBe('`x`');
    expect(applyStyle('a``b', { code: true })).toBe('```a``b```');
    expect(applyStyle('a```b', { code: true })).toBe('````a```b````');
    expect(applyStyle('a````b`c', { code: true })).toBe('`````a````b`c`````');
    expect(applyStyle('`edge`', { code: true })).toBe('`` `edge` ``');
    expect(applyStyle('``x', { code: true })).toBe('``` ``x ```');
    expect(applyStyle('   ', { bold: true })).toBe('   ');
  });
});

describe('richTextBlocksToMd', () => {
  it('returns null when there are no rich_text blocks', () => {
    expect(richTextBlocksToMd(undefined, ctx)).toBeNull();
    expect(richTextBlocksToMd([{ type: 'section' }], ctx)).toBeNull();
  });

  it('renders inline elements', () => {
    const out = richTextBlocksToMd(
      rt(
        section(
          { type: 'text', text: 'Hi ' },
          { type: 'user', user_id: 'U1' },
          { type: 'text', text: ' in ' },
          { type: 'channel', channel_id: 'C1' },
          { type: 'text', text: ' ' },
          { type: 'broadcast', range: 'channel' },
          { type: 'text', text: ' ' },
          { type: 'usergroup', usergroup_id: 'S01' },
          { type: 'text', text: ' ' },
          { type: 'emoji', name: 'tada' },
          { type: 'emoji', name: 'custom-one' },
          { type: 'text', text: ' ' },
          { type: 'link', url: 'https://x.com' },
          { type: 'text', text: ' ' },
          { type: 'link', url: 'https://y.com/a(b)', text: 'Y [docs]' },
          { type: 'text', text: ' ' },
          { type: 'date', timestamp: 1700000000, fallback: 'Nov 14' },
        ),
      ),
      ctx,
    );
    expect(out).toBe(
      'Hi @Alice in #general @channel @S01 🎉:custom-one: https://x.com [Y \\[docs\\]](<https://y.com/a(b)>) Nov 14',
    );
  });

  it('applies text styles and merges adjacent runs', () => {
    const out = richTextBlocksToMd(
      rt(
        section(
          { type: 'text', text: 'a', style: { bold: true } },
          { type: 'text', text: 'b', style: { bold: true } },
          { type: 'text', text: ' ' },
          { type: 'text', text: 'it', style: { italic: true } },
          { type: 'text', text: ' ' },
          { type: 'text', text: 'gone', style: { strike: true } },
          { type: 'text', text: ' ' },
          { type: 'text', text: 'x()', style: { code: true } },
          { type: 'text', text: ' ' },
          { type: 'link', url: 'https://z.com', text: 'z', style: { bold: true } },
        ),
      ),
      ctx,
    );
    expect(out).toBe('**ab** *it* ~~gone~~ `x()` **[z](https://z.com)**');
  });

  it('renders bullet and ordered lists with indent and offset', () => {
    const out = richTextBlocksToMd(
      rt(
        section({ type: 'text', text: 'Todo:\n' }),
        {
          type: 'rich_text_list',
          style: 'bullet',
          indent: 0,
          elements: [section({ type: 'text', text: 'one' }), section({ type: 'text', text: 'two' })],
        },
        {
          type: 'rich_text_list',
          style: 'ordered',
          indent: 1,
          elements: [section({ type: 'text', text: 'sub a' }), section({ type: 'text', text: 'sub b' })],
        },
        { type: 'rich_text_list', style: 'bullet', indent: 0, elements: [section({ type: 'text', text: 'three' })] },
        {
          type: 'rich_text_list',
          style: 'ordered',
          indent: 0,
          offset: 3,
          elements: [section({ type: 'text', text: 'fourth' })],
        },
        section({ type: 'text', text: 'after' }),
      ),
      ctx,
    );
    expect(out).toBe(
      ['Todo:', '', '- one', '- two', '    1. sub a', '    2. sub b', '- three', '4. fourth', '', 'after'].join('\n'),
    );
  });

  it('renders preformatted blocks verbatim and quotes', () => {
    const out = richTextBlocksToMd(
      rt(
        section({ type: 'text', text: 'Code:' }),
        {
          type: 'rich_text_preformatted',
          elements: [
            { type: 'text', text: 'a *b* <c>\n' },
            { type: 'link', url: 'https://u.com' },
          ],
        },
        {
          type: 'rich_text_quote',
          elements: [
            { type: 'text', text: 'line 1\n\nline ' },
            { type: 'text', text: '2', style: { bold: true } },
          ],
        },
        section({ type: 'text', text: 'end' }),
      ),
      ctx,
    );
    expect(out).toBe(
      ['Code:', '```', 'a *b* <c>', 'https://u.com', '```', '', '> line 1', '>', '> line **2**', '', 'end'].join('\n'),
    );
  });

  it('picks a code fence longer than any backtick run inside (finding #5)', () => {
    const pre = (text: string) =>
      richTextBlocksToMd(rt({ type: 'rich_text_preformatted', elements: [{ type: 'text', text }] }), ctx);
    expect(pre('a ``b`` c')).toBe('```\na ``b`` c\n```');
    expect(pre('```js\nx\n```')).toBe('````\n```js\nx\n```\n````');
    expect(pre('````\ny\n````')).toBe('`````\n````\ny\n````\n`````');
    expect(pre('a ``````` b')).toBe('````````\na ``````` b\n````````');
  });

  it('ignores unknown elements gracefully', () => {
    expect(richTextBlocksToMd(rt({ type: 'rich_text_future' }, section({ type: 'mystery', text: 'ok' })), ctx)).toBe(
      'ok',
    );
  });
});

describe('layoutBlocksToMd', () => {
  it('renders header, section (mrkdwn + fields), context and image blocks', () => {
    const out = layoutBlocksToMd(
      [
        { type: 'header', text: { type: 'plain_text', text: 'Title' } },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: '*Hi* <@U1>' },
          fields: [
            { type: 'mrkdwn', text: '*A*: 1' },
            { type: 'plain_text', text: 'B: 2' },
          ],
        },
        { type: 'divider' },
        {
          type: 'context',
          elements: [
            { type: 'mrkdwn', text: 'by _bot_' },
            { type: 'image', image_url: 'x' },
          ],
        },
        { type: 'image', image_url: 'https://img/x.png', alt_text: 'chart' },
      ],
      ctx,
    );
    expect(out).toBe('**Title**\n\n**Hi** @Alice\n\n**A**: 1\nB: 2\n\nby *bot*\n\n![chart](https://img/x.png)');
  });
});
