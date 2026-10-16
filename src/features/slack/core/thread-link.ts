// Slack thread permalinks for Devdy's `POST /v1/slack-threads` (pure, unit-tested).
//
// Devdy accepts exactly what Slack's "Copy link" gives (Inbox API §7.1):
//   https://<ws>.slack.com/archives/<channel>/p<16 digits>
//   https://<ws>.slack.com/archives/<channel>/p<16 digits>?thread_ts=<10>.<6>&cid=<channel>   (a reply)
// with <ws> = "<name>" or "<name>.enterprise", channel C…/G… (≥ 9 chars).
// Direct messages (D…) are refused by Devdy, so they are rejected here first.

export interface ThreadLinkParts {
  /** Workspace host, e.g. "acme.slack.com" or "acme.enterprise.slack.com". */
  host: string;
  channelId: string;
  /** Timestamp of the clicked message, "1700000000.123456". */
  ts: string;
  /** Timestamp of the thread's root message, when the clicked message is a reply. */
  threadTs?: string;
}

export type ThreadLinkError = 'dm' | 'invalid' | 'no_workspace';

export type ThreadLinkResult = { ok: true; url: string } | { ok: false; error: ThreadLinkError; message: string };

const TS_RE = /^\d{10}\.\d{6}$/;
const CHANNEL_RE = /^[CG][A-Z0-9]{8,}$/;
const DM_RE = /^D[A-Z0-9]+$/;
const WORKSPACE_HOST_RE = /^[a-z0-9-]+(?:\.enterprise)?\.slack\.com$/;
/** Slack hosts that are not a workspace. */
const NON_WORKSPACE_HOSTS = new Set(['app.slack.com', 'api.slack.com', 'files.slack.com', 'www.slack.com']);

export const DM_MESSAGE = 'Direct messages (DMs) can’t be sent to Devdy — only channel threads.';

const fail = (error: ThreadLinkError, message: string): ThreadLinkResult => ({ ok: false, error, message });

/** Workspace host of a URL or host name (`<ws>.slack.com` / `<ws>.enterprise.slack.com`), or null. */
export function workspaceHost(urlOrHost: string | null | undefined): string | null {
  if (!urlOrHost) return null;
  let host = urlOrHost.trim().toLowerCase();
  if (host.includes('/')) {
    try {
      const url = new URL(host);
      if (url.protocol !== 'https:' || url.port || url.username || url.password) return null;
      host = url.hostname;
    } catch {
      return null;
    }
  }
  return WORKSPACE_HOST_RE.test(host) && !NON_WORKSPACE_HOSTS.has(host) ? host : null;
}

/** True for a direct-message channel id (D…). */
export function isDmChannel(channelId: string): boolean {
  return DM_RE.test(channelId);
}

/**
 * The permalink Devdy expects: the message's own permalink, plus
 * `?thread_ts=<root>&cid=<channel>` when the message is a reply.
 */
export function buildThreadLink(parts: ThreadLinkParts): ThreadLinkResult {
  if (isDmChannel(parts.channelId)) return fail('dm', DM_MESSAGE);
  const host = workspaceHost(parts.host);
  if (!host) return fail('no_workspace', 'Could not find the Slack workspace address of this message.');
  if (!CHANNEL_RE.test(parts.channelId)) return fail('invalid', 'Could not find the channel of this message.');
  if (!TS_RE.test(parts.ts)) return fail('invalid', 'Could not find the timestamp of this message.');
  let url = `https://${host}/archives/${parts.channelId}/p${parts.ts.replace('.', '')}`;
  if (parts.threadTs && parts.threadTs !== parts.ts) {
    if (!TS_RE.test(parts.threadTs)) return fail('invalid', 'Invalid thread timestamp.');
    url += `?thread_ts=${parts.threadTs}&cid=${parts.channelId}`;
  }
  return { ok: true, url };
}

/** Parts of a `…/archives/<channel>/p<16 digits>[?thread_ts=…]` permalink (host not validated). */
export function parsePermalink(href: string): ThreadLinkParts | null {
  let url: URL;
  try {
    url = new URL(href.trim().replace(/^<|>$/g, ''));
  } catch {
    return null;
  }
  const m = /^\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})\/?$/.exec(url.pathname);
  if (!m) return null;
  const parts: ThreadLinkParts = { host: url.hostname.toLowerCase(), channelId: m[1]!, ts: `${m[2]}.${m[3]}` };
  const threadTs = url.searchParams.get('thread_ts');
  if (threadTs && TS_RE.test(threadTs)) parts.threadTs = threadTs;
  return parts;
}

/** Rebuild a Slack permalink in the canonical form Devdy accepts (DM / foreign hosts rejected). */
export function normalizeThreadLink(href: string): ThreadLinkResult {
  const parts = parsePermalink(href);
  if (!parts) return fail('invalid', 'Not a Slack thread link.');
  return buildThreadLink(parts);
}

/** `url` is already a canonical thread link (what the background accepts from the content script). */
export function isCanonicalThreadLink(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  const r = normalizeThreadLink(url);
  return r.ok && r.url === url;
}

// Shape of Slack's localStorage "localConfig_v2", as far as it is read here
// (only the workspace address — never the token).
interface LocalConfigTeam {
  id?: unknown;
  enterprise_id?: unknown;
  url?: unknown;
  domain?: unknown;
}

/**
 * Workspace host of team `teamId` from Slack's `localConfig_v2` JSON (the
 * app.slack.com page's localStorage). Without a team id: the only / last active team.
 */
export function workspaceHostFromLocalConfig(raw: string | null, teamId?: string): string | null {
  if (!raw) return null;
  let cfg: { teams?: Record<string, LocalConfigTeam | null>; lastActiveTeamId?: unknown };
  try {
    // Token-like keys are dropped while parsing: they never exist in our objects.
    cfg = JSON.parse(raw, (key, value) => (/token/i.test(key) ? undefined : value)) ?? {};
  } catch {
    return null;
  }
  const teams = Object.values(cfg.teams ?? {}).filter((t): t is LocalConfigTeam => !!t && typeof t === 'object');
  const only = teams.length === 1 ? teams[0] : undefined;
  // A team id that matches nothing must not pick another workspace (unless it's the only one).
  const team = teamId
    ? (teams.find((t) => t.id === teamId || t.enterprise_id === teamId) ?? only)
    : (only ?? teams.find((t) => t.id === cfg.lastActiveTeamId));
  if (!team) return null;
  return (
    workspaceHost(typeof team.url === 'string' ? team.url : null) ??
    (typeof team.domain === 'string' ? workspaceHost(`${team.domain}.slack.com`) : null)
  );
}
