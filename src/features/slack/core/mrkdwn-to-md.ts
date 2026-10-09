// Convert Slack "mrkdwn" text (message.text) to CommonMark-ish Markdown.
// Pure module.

import { replaceEmojiShortcodes } from './emoji';

/** Name lookups used while rendering mentions. Must never throw. */
export interface RenderContext {
  /** Display name for a user id (fallback: the id itself). */
  userName(id: string): string;
  /** Channel name for a channel id, if known. */
  channelName(id: string): string | undefined;
}

export function decodeEntities(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** Escape characters that would break a Markdown link label. */
export function escapeLinkLabel(text: string): string {
  return text.replace(/([[\]\\])/g, '\\$1');
}

/** Make a URL safe as a Markdown link destination. */
export function formatLinkUrl(url: string): string {
  return /[\s()<>]/.test(url) ? `<${url.replace(/[<>]/g, encodeURIComponent).replace(/\s/g, '%20')}>` : url;
}

function longestBacktickRun(text: string): number {
  let max = 0;
  for (const m of text.matchAll(/`+/g)) max = Math.max(max, m[0].length);
  return max;
}

/** Inline code span whose delimiter is longer than any backtick run inside. */
export function inlineCode(text: string): string {
  const fence = '`'.repeat(longestBacktickRun(text) + 1);
  // CommonMark strips one leading/trailing space when both are present, and a
  // backtick touching the delimiter would merge with it: pad in those cases.
  const needsPad = text.startsWith('`') || text.endsWith('`') || (/^ .*[^ ].* $/s.test(text));
  const pad = needsPad ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** Fenced code block whose fence is longer than any backtick run inside (min 3). */
export function fencedCode(body: string): string {
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(body) + 1));
  return `${fence}\n${body}\n${fence}`;
}

export function markdownLink(url: string, label?: string): string {
  if (!label || label === url) return url;
  return `[${escapeLinkLabel(label)}](${formatLinkUrl(url)})`;
}

// Private-use characters as placeholder delimiters (never present in Slack text).
const PH_OPEN = '';
const PH_CLOSE = '';

const BOUNDARY_BEFORE = `(^|[\\s([{"'*_~>\\u201C\\u2018${PH_CLOSE}])`;
const BOUNDARY_AFTER = `(?=$|[\\s.,;:!?)\\]}"'*_~\\u201D\\u2019${PH_OPEN}])`;

function styleRegex(marker: string): RegExp {
  const m = marker === '*' ? '\\*' : marker;
  return new RegExp(`${BOUNDARY_BEFORE}${m}(?!\\s)([^${m}\\n]+?)(?<!\\s)${m}${BOUNDARY_AFTER}`, 'gm');
}

const BOLD_RE = styleRegex('*');
const ITALIC_RE = styleRegex('_');
const STRIKE_RE = styleRegex('~');

/** Resolve one Slack "<…>" token to Markdown. */
function renderAngleToken(inner: string, ctx: RenderContext): string {
  const pipe = inner.indexOf('|');
  const target = pipe >= 0 ? inner.slice(0, pipe) : inner;
  const label = pipe >= 0 ? inner.slice(pipe + 1) : undefined;

  if (target.startsWith('@')) {
    const id = target.slice(1);
    const resolved = ctx.userName(id);
    const name = resolved && resolved !== id ? resolved : (label?.replace(/^@/, '') || id);
    return `@${decodeEntities(name)}`;
  }
  if (target.startsWith('#')) {
    const id = target.slice(1);
    const name = label || ctx.channelName(id) || id;
    return `#${decodeEntities(name)}`;
  }
  if (target.startsWith('!')) {
    const cmd = target.slice(1);
    if (cmd === 'here' || cmd === 'channel' || cmd === 'everyone') return `@${cmd}`;
    if (cmd.startsWith('subteam^')) {
      return label ? decodeEntities(label.startsWith('@') ? label : `@${label}`) : `@${cmd.slice(8)}`;
    }
    if (cmd.startsWith('date^')) return decodeEntities(label ?? cmd);
    return decodeEntities(label ?? cmd);
  }
  const url = decodeEntities(target);
  return markdownLink(url, label !== undefined ? decodeEntities(label) : undefined);
}

function convertInlineSegment(text: string, ctx: RenderContext): string {
  const stash: string[] = [];
  const protect = (s: string): string => {
    stash.push(s);
    return `${PH_OPEN}${stash.length - 1}${PH_CLOSE}`;
  };

  let out = text.replace(/<([^<>\n]+)>/g, (_m, inner: string) => protect(renderAngleToken(inner, ctx)));

  out = out.replace(BOLD_RE, (_m, pre: string, body: string) => `${pre}**${body}**`);
  out = out.replace(ITALIC_RE, (_m, pre: string, body: string) => `${pre}*${body}*`);
  out = out.replace(STRIKE_RE, (_m, pre: string, body: string) => `${pre}~~${body}~~`);
  out = replaceEmojiShortcodes(out);
  out = decodeEntities(out);

  return out.replace(new RegExp(`${PH_OPEN}(\\d+)${PH_CLOSE}`, 'g'), (_m, i: string) => stash[Number(i)] ?? '');
}

/**
 * Convert Slack mrkdwn to Markdown.
 * Code spans and code blocks are kept verbatim (entities decoded only);
 * multi-line ``` blocks are normalized so fences sit on their own lines.
 */
export function mrkdwnToMd(text: string | undefined, ctx: RenderContext): string {
  if (!text) return '';
  const codeRe = /```([\s\S]*?)```|`[^`\n]+`/g;
  let out = '';
  let last = 0;
  for (let m = codeRe.exec(text); m !== null; m = codeRe.exec(text)) {
    out += convertInlineSegment(text.slice(last, m.index), ctx);
    const whole = m[0];
    if (m[1] !== undefined && m[1].includes('\n')) {
      const body = decodeEntities(m[1]).replace(/^\n+|\n+$/g, '');
      const needsLeadingNl = out.length > 0 && !out.endsWith('\n');
      const next = text.charAt(m.index + whole.length);
      const needsTrailingNl = next !== '' && next !== '\n';
      out += `${needsLeadingNl ? '\n' : ''}${fencedCode(body)}${needsTrailingNl ? '\n' : ''}`;
    } else {
      out += decodeEntities(whole);
    }
    last = m.index + whole.length;
  }
  out += convertInlineSegment(text.slice(last), ctx);
  return out;
}
