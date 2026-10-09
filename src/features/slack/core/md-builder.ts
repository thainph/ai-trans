// Assemble the final Markdown document for a thread. Pure module
// (uses the runtime's local timezone for date formatting).

import { filenamePart } from '../../../shared/filename';
import { frontMatter, yamlPlain, yamlRaw } from '../../../shared/yaml';
import type { AttachmentOutcome } from './attachments';
import { renderEmoji } from './emoji';
import { markdownLink, mrkdwnToMd, type RenderContext } from './mrkdwn-to-md';
import { layoutBlocksToMd, richTextBlocksToMd } from './rich-text-to-md';
import type { SlackAttachment, SlackMessage } from './types';

export interface ThreadData {
  workspace: { name?: string; domain?: string };
  channel: { id: string; name?: string; isIm?: boolean; imUserId?: string };
  /** Canonical permalink of the thread parent. */
  threadUrl: string;
  messages: SlackMessage[];
  /** user id -> display name */
  users: Record<string, string>;
  /** channel id -> name (for #channel mentions) */
  channels: Record<string, string>;
  /** True when fetching stopped early (safety cap / missing cursor). */
  truncated?: boolean;
}

export interface BuildOptions {
  includeReactions: boolean;
  includeFiles: boolean;
  /**
   * Zip export: outcome per Slack file id. Saved files are linked by their
   * path inside the zip; skipped/failed ones keep the Slack link plus a note.
   */
  attachments?: ReadonlyMap<string, AttachmentOutcome>;
}

export interface BuildResult {
  markdown: string;
  filename: string;
  messageCount: number;
}

const TITLE_MAX = 80;

// ---------- date helpers (local timezone) ----------

const pad = (n: number, len = 2): string => String(n).padStart(len, '0');

export function tsToDate(ts: string): Date {
  return new Date(Math.round(parseFloat(ts) * 1000));
}

/** "YYYY-MM-DD HH:mm" in local time. */
export function formatLocalDateTime(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** ISO 8601 with local offset, e.g. "2026-10-07T16:20:05+09:00". */
export function formatLocalIso(d: Date): string {
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

function compactStamp(d: Date): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

// ---------- message helpers ----------

export function authorName(msg: SlackMessage, users: Record<string, string>): string {
  const isBotMessage = msg.subtype === 'bot_message' || (!!msg.bot_id && !msg.user);
  if (isBotMessage) {
    return msg.username || msg.bot_profile?.name || (msg.user && users[msg.user]) || `bot ${msg.bot_id ?? ''}`.trim();
  }
  if (msg.user && users[msg.user]) return users[msg.user]!;
  const p = msg.user_profile;
  return p?.display_name || p?.real_name || p?.name || msg.username || msg.bot_profile?.name || msg.user || 'Unknown';
}

function renderAttachments(atts: SlackAttachment[] | undefined, ctx: RenderContext): string {
  if (!Array.isArray(atts) || atts.length === 0) return '';
  const blocks: string[] = [];
  for (const a of atts) {
    const lines: string[] = [];
    if (a.from_url) {
      // Link unfurl: keep it short.
      lines.push(`🔗 ${markdownLink(a.from_url, a.title)}`);
    } else {
      if (a.pretext) lines.push(mrkdwnToMd(a.pretext, ctx));
      if (a.author_name) lines.push(a.author_name);
      if (a.title) lines.push(`**${a.title_link ? markdownLink(a.title_link, a.title) : a.title}**`);
      if (a.text) lines.push(mrkdwnToMd(a.text, ctx));
      if (lines.length === 0 && a.fallback) lines.push(mrkdwnToMd(a.fallback, ctx));
    }
    const text = lines.join('\n').trim();
    if (text)
      blocks.push(
        text
          .split('\n')
          .map((l) => (l ? `> ${l}` : '>'))
          .join('\n'),
      );
  }
  return blocks.join('\n\n');
}

export function renderMessageBody(msg: SlackMessage, ctx: RenderContext): string {
  const rich = richTextBlocksToMd(msg.blocks, ctx);
  let body: string;
  if (rich !== null) body = rich;
  else {
    const layout = layoutBlocksToMd(msg.blocks, ctx);
    body = layout || mrkdwnToMd(msg.text, ctx);
  }
  const atts = renderAttachments(msg.attachments, ctx);
  return [body.trim(), atts].filter(Boolean).join('\n\n');
}

/** Escape a file name for use as Markdown link text / image alt text. */
function linkText(s: string): string {
  return s.replace(/[\\[\]]/g, '\\$&');
}

function renderFiles(msg: SlackMessage, attachments?: ReadonlyMap<string, AttachmentOutcome>): string {
  if (!Array.isArray(msg.files) || msg.files.length === 0) return '';
  return msg.files
    .map((f) => {
      const name =
        f.name || f.title || (f.mode === 'tombstone' || f.mode === 'hidden_by_limit' ? '(file unavailable)' : 'file');
      const outcome = f.id ? attachments?.get(f.id) : undefined;
      if (outcome?.kind === 'saved') {
        return outcome.isImage ? `![${linkText(name)}](${outcome.path})` : `📎 [${linkText(name)}](${outcome.path})`;
      }
      const link = f.permalink || f.url_private;
      const base = link ? `📎 ${name} — ${link}` : `📎 ${name}`;
      return outcome?.kind === 'skipped' ? `${base} _(not included: ${outcome.reason})_` : base;
    })
    .join('\n');
}

function renderReactions(msg: SlackMessage): string {
  if (!Array.isArray(msg.reactions) || msg.reactions.length === 0) return '';
  const items = msg.reactions.map((r) => `${renderEmoji(r.name)} ${r.count ?? r.users?.length ?? 1}`);
  return `Reactions: ${items.join(', ')}`;
}

/** Plain one-line title from the parent message body. */
export function makeTitle(body: string): string {
  const firstLine =
    body
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !/^(`{3,}|>$)/.test(l)) ?? '';
  let t = firstLine
    .replace(/^(#{1,6}\s+|>\s*|[-*+]\s+|\d+\.\s+)+/, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|~~|`/g, '')
    .trim();
  if (!t) return '(no text)';
  const chars = Array.from(t);
  if (chars.length > TITLE_MAX)
    t = `${chars
      .slice(0, TITLE_MAX - 1)
      .join('')
      .trimEnd()}…`;
  return t;
}

export function sanitizeFilenamePart(s: string): string {
  return filenamePart(s.replace(/^[#@]+/, ''), 'channel');
}

function channelLabel(data: ThreadData): string {
  const { channel, users } = data;
  if (channel.isIm) {
    const who = channel.imUserId ? (users[channel.imUserId] ?? channel.imUserId) : channel.name;
    return `@${who ?? channel.id}`;
  }
  return `#${channel.name ?? channel.id}`;
}

export function buildThreadMarkdown(data: ThreadData, options: BuildOptions, now: Date = new Date()): BuildResult {
  const ctx: RenderContext = {
    userName: (id) => data.users[id] ?? id,
    channelName: (id) => data.channels[id] ?? (id === data.channel.id ? data.channel.name : undefined),
  };

  const messages = [...data.messages].sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));
  const participants: string[] = [];
  const sections: string[] = [];
  let title = '(no text)';

  messages.forEach((msg, i) => {
    const name = authorName(msg, data.users);
    if (!participants.includes(name)) participants.push(name);

    const body = renderMessageBody(msg, ctx);
    if (i === 0) {
      title = makeTitle(body);
      if (title === '(no text)' && msg.files?.[0]) title = makeTitle(msg.files[0].name ?? msg.files[0].title ?? '');
    }

    const header = `### ${name} — ${formatLocalDateTime(tsToDate(msg.ts))}${msg.edited ? ' _(edited)_' : ''}`;
    const parts = [header];
    if (body) parts.push(body);
    if (options.includeFiles) {
      const files = renderFiles(msg, options.attachments);
      if (files) parts.push(files);
    }
    if (options.includeReactions) {
      const reactions = renderReactions(msg);
      if (reactions) parts.push(reactions);
    }
    sections.push(parts.join('\n\n'));
  });

  const label = channelLabel(data);
  const threadTs = messages[0]?.thread_ts ?? messages[0]?.ts;
  const frontmatter = frontMatter({
    // title / thread_url / thread_ts let Devdy name and de-duplicate the thread.
    title,
    workspace: yamlPlain(data.workspace.name ?? data.workspace.domain ?? 'unknown'),
    channel: label,
    thread_url: /^https:\/\/[^\s#,[\]{}"']+$/.test(data.threadUrl) ? yamlRaw(data.threadUrl) : data.threadUrl,
    thread_ts: threadTs,
    exported_at: yamlRaw(formatLocalIso(now)),
    messages: messages.length,
    participants,
    truncated: data.truncated ? true : undefined,
  });

  const notice = data.truncated
    ? '> ⚠️ This export may be incomplete: fetching stopped before the end of the thread.\n\n'
    : '';
  const markdown = `${frontmatter}\n\n# Thread: ${title}\n\n${notice}${sections.join('\n\n---\n\n')}\n`;

  const parentDate = messages[0] ? tsToDate(messages[0].ts) : now;
  const filename = `slack-thread-${sanitizeFilenamePart(label)}-${compactStamp(parentDate)}.md`;

  return { markdown, filename, messageCount: messages.length };
}
