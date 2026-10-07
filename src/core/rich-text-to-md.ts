// Convert Slack Block Kit "rich_text" blocks (and a few basic layout blocks
// used by bots) to Markdown. Pure module.

import type { RichTextInline, RichTextStyle, SlackBlock } from '../types/slack';
import { renderEmoji } from './emoji';
import { type RenderContext, fencedCode, inlineCode, markdownLink, mrkdwnToMd } from './mrkdwn-to-md';

type AnyRecord = Record<string, unknown>;

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function sameStyle(a?: RichTextStyle, b?: RichTextStyle): boolean {
  return (
    !!a?.bold === !!b?.bold &&
    !!a?.italic === !!b?.italic &&
    !!a?.strike === !!b?.strike &&
    !!a?.code === !!b?.code
  );
}

/** Wrap text with Markdown style markers, keeping surrounding whitespace outside. */
export function applyStyle(text: string, style?: RichTextStyle): string {
  if (!style || !text) return text;
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  const lead = m?.[1] ?? '';
  let core = m?.[2] ?? text;
  const trail = m?.[3] ?? '';
  if (!core) return text;
  if (style.code) core = inlineCode(core);
  if (style.strike) core = `~~${core}~~`;
  if (style.italic) core = `*${core}*`;
  if (style.bold) core = `**${core}**`;
  return `${lead}${core}${trail}`;
}

/** Merge adjacent text elements that share the same style (avoids "**a****b**"). */
function mergeTextRuns(elements: RichTextInline[]): RichTextInline[] {
  const out: RichTextInline[] = [];
  for (const el of elements) {
    const prev = out[out.length - 1];
    if (
      el.type === 'text' &&
      prev?.type === 'text' &&
      typeof (el as AnyRecord).text === 'string' &&
      sameStyle((prev as AnyRecord).style as RichTextStyle, (el as AnyRecord).style as RichTextStyle)
    ) {
      out[out.length - 1] = {
        ...(prev as AnyRecord),
        text: String((prev as AnyRecord).text ?? '') + String((el as AnyRecord).text),
      } as RichTextInline;
    } else {
      out.push(el);
    }
  }
  return out;
}

function renderInlineElement(el: RichTextInline, ctx: RenderContext): string {
  const e = el as AnyRecord;
  const style = e.style as RichTextStyle | undefined;
  switch (el.type) {
    case 'text':
      return applyStyle(str(e.text) ?? '', style);
    case 'link': {
      const url = str(e.url) ?? '';
      const label = str(e.text);
      // Inline code on links would hide the link; drop the code style there.
      const linkStyle = style ? { ...style, code: false } : undefined;
      return applyStyle(markdownLink(url, label), linkStyle);
    }
    case 'user': {
      const id = str(e.user_id) ?? '';
      return applyStyle(`@${ctx.userName(id)}`, style);
    }
    case 'channel': {
      const id = str(e.channel_id) ?? '';
      return applyStyle(`#${ctx.channelName(id) ?? id}`, style);
    }
    case 'usergroup':
      return applyStyle(`@${str(e.usergroup_id) ?? 'usergroup'}`, style);
    case 'broadcast':
      return applyStyle(`@${str(e.range) ?? 'here'}`, style);
    case 'emoji': {
      const name = str(e.name) ?? '';
      const tone = typeof e.skin_tone === 'number' ? `::skin-tone-${e.skin_tone}` : '';
      return renderEmoji(`${name}${tone}`, str(e.unicode));
    }
    case 'date': {
      const fallback = str(e.fallback);
      if (fallback) return fallback;
      const ts = typeof e.timestamp === 'number' ? e.timestamp : Number(e.timestamp);
      return Number.isFinite(ts) ? new Date(ts * 1000).toISOString() : '';
    }
    case 'color':
      return str(e.value) ?? '';
    default:
      return str(e.text) ?? '';
  }
}

export function renderInline(elements: unknown[] | undefined, ctx: RenderContext): string {
  if (!Array.isArray(elements)) return '';
  return mergeTextRuns(elements as RichTextInline[])
    .map((el) => renderInlineElement(el, ctx))
    .join('');
}

/** Raw text for preformatted blocks: no styling, links as plain URLs/labels. */
function renderRaw(elements: unknown[] | undefined, ctx: RenderContext): string {
  if (!Array.isArray(elements)) return '';
  return (elements as RichTextInline[])
    .map((el) => {
      const e = el as AnyRecord;
      if (el.type === 'text') return str(e.text) ?? '';
      if (el.type === 'link') return str(e.text) ?? str(e.url) ?? '';
      return renderInlineElement(el, ctx);
    })
    .join('');
}

type PartKind = 'section' | 'list' | 'pre' | 'quote';

interface Part {
  kind: PartKind;
  text: string;
}

const INDENT = '    ';

function renderList(el: AnyRecord, ctx: RenderContext): string {
  const indent = typeof el.indent === 'number' ? el.indent : 0;
  const offset = typeof el.offset === 'number' ? el.offset : 0;
  const ordered = el.style === 'ordered';
  const items = Array.isArray(el.elements) ? (el.elements as AnyRecord[]) : [];
  const pad = INDENT.repeat(indent);
  return items
    .map((item, i) => {
      const marker = ordered ? `${offset + i + 1}. ` : '- ';
      const body = renderInline(item.elements as unknown[], ctx).replace(/\n+$/, '');
      const cont = `${pad}${' '.repeat(marker.length)}`;
      return `${pad}${marker}${body.split('\n').join(`\n${cont}`)}`;
    })
    .join('\n');
}

function renderRichTextElement(el: AnyRecord, ctx: RenderContext): Part | null {
  switch (el.type) {
    case 'rich_text_section':
      return { kind: 'section', text: renderInline(el.elements as unknown[], ctx).replace(/^\n+|\n+$/g, '') };
    case 'rich_text_list':
      return { kind: 'list', text: renderList(el, ctx) };
    case 'rich_text_preformatted': {
      const body = renderRaw(el.elements as unknown[], ctx).replace(/^\n+|\n+$/g, '');
      return { kind: 'pre', text: fencedCode(body) };
    }
    case 'rich_text_quote': {
      const body = renderInline(el.elements as unknown[], ctx).replace(/^\n+|\n+$/g, '');
      return { kind: 'quote', text: body.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n') };
    }
    default: {
      // Unknown element: best effort on nested inline elements.
      const text = renderInline(el.elements as unknown[], ctx);
      return text ? { kind: 'section', text } : null;
    }
  }
}

function joinParts(parts: Part[]): string {
  let out = '';
  parts.forEach((p, i) => {
    if (i > 0) {
      const prev = parts[i - 1]!;
      let sep: string;
      if (prev.kind === 'list' && p.kind === 'list') sep = '\n';
      else if (prev.kind === 'list' || prev.kind === 'quote' || p.kind === 'list' || p.kind === 'quote') sep = '\n\n';
      else sep = '\n';
      out += sep;
    }
    out += p.text;
  });
  return out;
}

/** Render all rich_text blocks of a message. Returns null when there are none. */
export function richTextBlocksToMd(blocks: SlackBlock[] | undefined, ctx: RenderContext): string | null {
  if (!Array.isArray(blocks)) return null;
  const richBlocks = blocks.filter((b) => b && b.type === 'rich_text');
  if (richBlocks.length === 0) return null;
  return richBlocks
    .map((b) => {
      const elements = Array.isArray(b.elements) ? (b.elements as AnyRecord[]) : [];
      const parts = elements.map((el) => renderRichTextElement(el, ctx)).filter((p): p is Part => !!p && p.text !== '');
      return joinParts(parts);
    })
    .filter(Boolean)
    .join('\n\n');
}

function textObjectToMd(obj: unknown, ctx: RenderContext): string {
  const o = obj as AnyRecord | undefined;
  const text = str(o?.text);
  if (!text) return '';
  return o?.type === 'mrkdwn' ? mrkdwnToMd(text, ctx) : text;
}

/** Best-effort rendering for non-rich_text Block Kit layouts (mostly bot messages). */
export function layoutBlocksToMd(blocks: SlackBlock[] | undefined, ctx: RenderContext): string {
  if (!Array.isArray(blocks)) return '';
  const out: string[] = [];
  for (const b of blocks) {
    switch (b?.type) {
      case 'header': {
        const t = textObjectToMd(b.text, ctx);
        if (t) out.push(`**${t}**`);
        break;
      }
      case 'section': {
        const t = textObjectToMd(b.text, ctx);
        if (t) out.push(t);
        if (Array.isArray(b.fields)) {
          const fields = b.fields.map((f) => textObjectToMd(f, ctx)).filter(Boolean);
          if (fields.length) out.push(fields.join('\n'));
        }
        break;
      }
      case 'context': {
        const items = (Array.isArray(b.elements) ? b.elements : [])
          .map((e) => textObjectToMd(e, ctx))
          .filter(Boolean);
        if (items.length) out.push(items.join(' · '));
        break;
      }
      case 'image': {
        const url = str(b.image_url);
        if (url) out.push(`![${str(b.alt_text) ?? 'image'}](${url})`);
        break;
      }
      default:
        break;
    }
  }
  return out.join('\n\n');
}
