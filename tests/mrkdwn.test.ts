import { describe, expect, it } from 'vitest';
import { renderEmoji, replaceEmojiShortcodes } from '../src/core/emoji';
import { type RenderContext, fencedCode, inlineCode, mrkdwnToMd } from '../src/core/mrkdwn-to-md';

const ctx: RenderContext = {
  userName: (id) => ({ U123: 'Alice', U456: 'Bob' })[id] ?? id,
  channelName: (id) => ({ C999: 'random' })[id],
};
const md = (s: string) => mrkdwnToMd(s, ctx);

describe('mrkdwnToMd', () => {
  it('converts user, channel and special mentions', () => {
    expect(md('hi <@U123> and <@U456|bob>')).toBe('hi @Alice and @Bob');
    expect(md('unknown <@U777|carol> <@U888>')).toBe('unknown @carol @U888');
    expect(md('see <#C1|general> and <#C999>')).toBe('see #general and #random');
    expect(md('<!here> <!channel> <!everyone|@everyone>')).toBe('@here @channel @everyone');
    expect(md('<!subteam^S01|@devs> ping')).toBe('@devs ping');
    expect(md('<!date^1700000000^{date}|Nov 14, 2023>')).toBe('Nov 14, 2023');
  });

  it('converts links', () => {
    expect(md('<https://example.com|Example>')).toBe('[Example](https://example.com)');
    expect(md('<https://example.com>')).toBe('https://example.com');
    expect(md('<https://e.com/a?x=1&amp;y=2|q &amp; a>')).toBe('[q & a](https://e.com/a?x=1&y=2)');
    expect(md('<mailto:a@b.co|a@b.co>')).toBe('[a@b.co](mailto:a@b.co)');
  });

  it('does not mangle underscores/asterisks inside URLs', () => {
    expect(md('<https://e.com/a_b_c*d*|x_y_z>')).toBe('[x_y_z](https://e.com/a_b_c*d*)');
    expect(md('go to <https://e.com/snake_case_path>')).toBe('go to https://e.com/snake_case_path');
  });

  it('converts bold, italic and strike', () => {
    expect(md('*bold* _italic_ ~strike~')).toBe('**bold** *italic* ~~strike~~');
    expect(md('a *bold phrase*, then _it_.')).toBe('a **bold phrase**, then *it*.');
    expect(md('*_both_*')).toBe('***both***');
  });

  it('leaves non-formatting characters alone', () => {
    expect(md('snake_case_name and 2*3*4')).toBe('snake_case_name and 2*3*4');
    expect(md('* not bold *')).toBe('* not bold *');
    expect(md('10:30:45')).toBe('10:30:45');
  });

  it('keeps code spans and code blocks verbatim', () => {
    expect(md('run `npm *test*` now')).toBe('run `npm *test*` now');
    expect(md('```*x* <@U123> _y_```')).toBe('```*x* <@U123> _y_```');
    expect(md('code:\n```line1\nif a &lt; b &amp;&amp; c```\nafter *b*')).toBe(
      'code:\n```\nline1\nif a < b && c\n```\nafter **b**',
    );
  });

  it('uses a safe fence for code blocks containing backtick runs (finding #5)', () => {
    expect(md('```a\n``b`` c```')).toBe('```\na\n``b`` c\n```');
    // A Slack ``` block cannot contain ``` (it would end the block), so the
    // inner run here closes it; the remainder is ordinary text.
    expect(md('```x\ny```z')).toBe('```\nx\ny\n```\nz');
  });

  it('exports inline/fenced code helpers with correct delimiters', () => {
    expect(inlineCode('a`b')).toBe('``a`b``');
    expect(inlineCode('a``b')).toBe('```a``b```');
    expect(inlineCode(' padded ')).toBe('`  padded  `');
    expect(fencedCode('x')).toBe('```\nx\n```');
    expect(fencedCode('````')).toBe('`````\n````\n`````');
  });

  it('decodes entities and keeps quotes', () => {
    expect(md('&lt;div&gt; &amp;amp;')).toBe('<div> &amp;');
    expect(md('&gt; quoted *text*\nnormal')).toBe('> quoted **text**\nnormal');
  });

  it('converts known emoji and keeps unknown ones', () => {
    expect(md('ship it :rocket: :+1::skin-tone-3: :my-custom:')).toBe('ship it 🚀 👍 :my-custom:');
  });

  it('handles empty input', () => {
    expect(md('')).toBe('');
    expect(mrkdwnToMd(undefined, ctx)).toBe('');
  });
});

describe('emoji helpers', () => {
  it('renders from unicode hex first, then the map, else shortcode', () => {
    expect(renderEmoji('rocket', '1f680')).toBe('🚀');
    expect(renderEmoji('thumbsup', '1f44d-1f3fb')).toBe('👍🏻');
    expect(renderEmoji('white_check_mark')).toBe('✅');
    expect(renderEmoji('party-parrot')).toBe(':party-parrot:');
    expect(replaceEmojiShortcodes(':tada: :nope:')).toBe('🎉 :nope:');
  });
});
