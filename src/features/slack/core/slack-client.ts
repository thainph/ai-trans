// Slack Web internal API access.
//
// Two layers:
//  1. `pageSlackApi` — a SELF-CONTAINED function that is serialized and run in
//     the app.slack.com page (MAIN world) via chrome.scripting.executeScript.
//     It reads the session token from localStorage, performs exactly ONE API
//     call (with an immediate base-URL fallback) and returns plain JSON. It
//     never sleeps: rate-limit waits happen in the extension, where they can
//     keep the MV3 service worker alive. It must not reference anything outside
//     its own body (no imports, no module-level helpers, no closures).
//  2. `fetchThread` — orchestration (retry/backoff, pagination, user/channel
//     resolution, error mapping) running in the extension. It talks to the
//     page only via a `PageRunner`, so it can be unit-tested with a fake runner.
//
// All Slack-internal assumptions live in this file:
//   - localStorage key "localConfig_v2" -> { teams: { [id]: { id, token, url, domain, name } }, lastActiveTeamId }
//   - POST https://<domain>.slack.com/api/<method> with FormData { token, ... } and cookies.
//
// The token never leaves the page function: it is not returned, logged or stored,
// and it is only ever sent to https://app.slack.com or https://<sub>.slack.com origins.

import { mapLimit } from '../../../shared/async';
import type { ThreadData } from './md-builder';
import { buildPermalink, type ParsedThreadLink } from './permalink';
import type { SlackConversation, SlackMessage, SlackRepliesResponse, SlackUser } from './types';

// ---------------------------------------------------------------------------
// Page-side contract
// ---------------------------------------------------------------------------

export interface PageRequest {
  teamId?: string;
  domain?: string;
  method: string;
  params: Record<string, string>;
}

/** Body of a Slack Web API response: `ok`/`error` plus method-specific fields. */
export interface SlackApiData {
  ok?: boolean;
  error?: string;
  [key: string]: unknown;
}

export interface PageCallResult {
  ok: boolean;
  data?: SlackApiData;
  error?: string;
  httpStatus?: number;
  /** Seconds to wait before retrying, when rate limited (if Slack told us). */
  retryAfterSec?: number;
}

export interface PageTeamInfo {
  id: string;
  name?: string;
  domain?: string;
  /** Validated workspace origin with trailing slash, e.g. "https://papay.slack.com/". */
  url?: string;
  /** True when no team matched the link and the last active team was used. */
  guessed?: boolean;
}

export type PageErrorCode = 'no_local_config' | 'no_teams' | 'team_not_found' | 'exception';

export type PageResponse =
  | { ok: true; team: PageTeamInfo; result: PageCallResult }
  | { ok: false; error: PageErrorCode; detail?: string };

export type PageRunner = (req: PageRequest) => Promise<PageResponse>;

// Shapes of Slack's localStorage "localConfig_v2" as read by pageSlackApi.
// Every field is untrusted (unknown) until checked. Type-only: erased from the
// serialized function.
interface LocalConfigTeam {
  id?: unknown;
  enterprise_id?: unknown;
  token?: unknown;
  url?: unknown;
  domain?: unknown;
  name?: unknown;
}
interface LocalConfig {
  teams?: Record<string, LocalConfigTeam | null>;
  lastActiveTeamId?: unknown;
}
type TokenTeam = LocalConfigTeam & { token: string };

/**
 * Runs inside https://app.slack.com (MAIN world). SELF-CONTAINED: keep every
 * helper inside this function body. Performs a single API call, no sleeping.
 */
export async function pageSlackApi(req: PageRequest): Promise<PageResponse> {
  try {
    const raw = window.localStorage.getItem('localConfig_v2');
    if (!raw) return { ok: false, error: 'no_local_config' };

    const cfg = (JSON.parse(raw) ?? {}) as LocalConfig;
    const teams = Object.values(cfg.teams ?? {}).filter(
      (t): t is TokenTeam => !!t && typeof t.token === 'string' && !!t.token,
    );
    if (teams.length === 0) return { ok: false, error: 'no_teams' };

    // Only ever send the token to https://app.slack.com or https://<sub>.slack.com.
    // Returns the origin + "/" (paths, ports and credentials are dropped/rejected).
    const safeSlackOrigin = (u: unknown): string | null => {
      if (typeof u !== 'string') return null;
      try {
        const url = new URL(u);
        const host = url.hostname.toLowerCase();
        const hostOk =
          host === 'app.slack.com' || (host.endsWith('.slack.com') && /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host));
        if (url.protocol !== 'https:' || !hostOk || url.port || url.username || url.password) return null;
        return `${url.origin}/`;
      } catch {
        return null;
      }
    };
    const hostOf = (u: unknown): string => {
      try {
        return typeof u === 'string' ? new URL(u).hostname.toLowerCase() : '';
      } catch {
        return '';
      }
    };

    const wantDomain = req.domain ? req.domain.toLowerCase() : '';
    const wantHost = wantDomain ? `${wantDomain}.slack.com` : '';

    let guessed = false;
    let team =
      (req.teamId && teams.find((t) => t.id === req.teamId || t.enterprise_id === req.teamId)) ||
      (wantDomain &&
        teams.find((t) => String(t.domain || '').toLowerCase() === wantDomain || hostOf(t.url) === wantHost)) ||
      (teams.length === 1 ? teams[0] : undefined);
    if (!team && cfg.lastActiveTeamId) {
      // No match (e.g. Enterprise Grid org domain): fall back to the active team.
      team = teams.find((t) => t.id === cfg.lastActiveTeamId);
      guessed = !!team && !!(req.teamId || wantDomain);
    }
    if (!team) {
      const known = teams.map((t) => t.domain || hostOf(t.url) || t.id).join(', ');
      return { ok: false, error: 'team_not_found', detail: known };
    }

    let teamBase = safeSlackOrigin(team.url);
    // Multi-label domains (Enterprise Grid, e.g. "acme.enterprise") are allowed;
    // the result is still validated by safeSlackOrigin.
    if (!teamBase && typeof team.domain === 'string' && /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/i.test(team.domain)) {
      teamBase = safeSlackOrigin(`https://${team.domain}.slack.com/`);
    }
    const bases = Array.from(new Set([teamBase, 'https://app.slack.com/'].filter((b): b is string => !!b)));
    const token: string = team.token;
    const teamInfo: PageTeamInfo = {
      id: String(team.id),
      name: typeof team.name === 'string' ? team.name : undefined,
      domain: typeof team.domain === 'string' ? team.domain : undefined,
      url: teamBase || undefined,
      guessed,
    };

    let lastError = 'network_error';
    let lastStatus: number | undefined;
    for (const base of bases) {
      const body = new FormData();
      body.append('token', token);
      for (const [k, v] of Object.entries(req.params)) body.append(k, v);
      let res: Response;
      try {
        res = await fetch(`${base}api/${encodeURIComponent(req.method)}`, {
          method: 'POST',
          body,
          credentials: 'include',
        });
      } catch {
        lastError = 'network_error';
        continue; // try the fallback base URL
      }
      lastStatus = res.status;
      const retryAfter = Number(res.headers.get('Retry-After'));
      const retryAfterSec = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined;
      if (res.status === 429) {
        return {
          ok: true,
          team: teamInfo,
          result: { ok: false, error: 'ratelimited', httpStatus: 429, retryAfterSec },
        };
      }
      let data: SlackApiData | null;
      try {
        data = await res.json();
      } catch {
        lastError = `http_${res.status}`;
        continue; // non-JSON (HTML error page etc.) -> try fallback base
      }
      const result: PageCallResult = {
        ok: !!data?.ok,
        data: data ?? undefined,
        error: data?.error,
        httpStatus: res.status,
      };
      if (result.error === 'ratelimited') result.retryAfterSec = retryAfterSec;
      return { ok: true, team: teamInfo, result };
    }
    return { ok: true, team: teamInfo, result: { ok: false, error: lastError, httpStatus: lastStatus } };
  } catch (e) {
    return { ok: false, error: 'exception', detail: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Extension-side orchestration
// ---------------------------------------------------------------------------

export class SlackExportError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SlackExportError';
  }
}

const ERROR_MESSAGES: Record<string, string> = {
  no_local_config: 'Slack session not found in the app.slack.com tab. Please open app.slack.com and log in.',
  no_teams: 'No logged-in Slack workspace found. Please open app.slack.com and log in.',
  not_authed: 'Slack session is not authenticated. Reload app.slack.com, make sure you are logged in, and retry.',
  invalid_auth: 'Slack session is invalid or expired. Reload app.slack.com, log in again, and retry.',
  token_revoked: 'Slack session was revoked. Log in to app.slack.com again.',
  account_inactive: 'This Slack account is inactive.',
  channel_not_found:
    'Channel not found, or you do not have access to it. Check that the link belongs to a workspace you are logged into.',
  thread_not_found: 'Thread not found. The message may have been deleted or the link is wrong.',
  message_not_found: 'Message not found. The message may have been deleted or the link is wrong.',
  missing_scope: 'Your Slack session is not allowed to read this conversation.',
  not_in_channel: 'You are not a member of this channel.',
  ratelimited: 'Slack is rate limiting requests. Please wait a minute and try again.',
  network_error: 'Network error while contacting Slack. Check your connection and that app.slack.com is loaded.',
  exception: 'Unexpected error inside the Slack tab.',
};

export function describeSlackError(code: string, detail?: string): string {
  if (code === 'team_not_found') {
    return `This link's workspace is not logged in on app.slack.com.${detail ? ` Logged-in workspaces: ${detail}.` : ''}`;
  }
  const base = ERROR_MESSAGES[code] ?? `Slack API error: ${code}`;
  return detail && code === 'exception' ? `${base} (${detail})` : base;
}

function assertPageOk(res: PageResponse | undefined | null): asserts res is Extract<PageResponse, { ok: true }> {
  if (!res) throw new SlackExportError('exception', describeSlackError('exception', 'empty result from Slack tab'));
  if (!res.ok) throw new SlackExportError(res.error, describeSlackError(res.error, res.detail));
}

export function userDisplayName(u: SlackUser | undefined): string | undefined {
  if (!u) return undefined;
  const p = u.profile ?? {};
  return p.display_name || p.display_name_normalized || p.real_name || u.real_name || u.name || undefined;
}

/** Collect user and channel ids referenced in messages (authors + mentions). */
export function collectReferences(messages: SlackMessage[]): { users: Set<string>; channels: Set<string> } {
  const users = new Set<string>();
  const channels = new Set<string>();

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const n = node as Record<string, unknown>;
    if (n.type === 'user' && typeof n.user_id === 'string') users.add(n.user_id);
    if (n.type === 'channel' && typeof n.channel_id === 'string') channels.add(n.channel_id);
    for (const v of Object.values(n)) if (v && typeof v === 'object') walk(v);
  };
  const scanText = (text: unknown): void => {
    if (typeof text !== 'string') return;
    for (const m of text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)) if (m[1]) users.add(m[1]);
    for (const m of text.matchAll(/<#([CG][A-Z0-9]+)>/g)) if (m[1]) channels.add(m[1]);
  };

  for (const msg of messages) {
    const isBotMessage = msg.subtype === 'bot_message' && !msg.user;
    if (msg.user && !isBotMessage) users.add(msg.user);
    walk(msg.blocks);
    scanText(msg.text);
    for (const a of msg.attachments ?? []) {
      scanText(a.text);
      scanText(a.pretext);
      scanText(a.fallback);
    }
  }
  return { users, channels };
}

export interface FetchThreadOptions {
  onProgress?: (text: string) => void;
  /**
   * Wait implementation used for rate-limit backoff. The background worker
   * passes a keepalive-aware sleep so MV3 does not terminate it mid-wait.
   */
  sleep?: (ms: number) => Promise<void>;
  /** Rate-limit retries per API call (default 5). */
  maxRetries?: number;
  /** Safety cap on conversations.replies pages (default 2000 = 400k messages). */
  maxPages?: number;
  /** Parallel name-resolution calls (default 4). */
  concurrency?: number;
  /** Clock and RNG (injectable for tests). */
  now?: () => number;
  random?: () => number;
}

export interface FetchThreadResult {
  data: ThreadData;
  team: PageTeamInfo;
  /** Human-readable warning when the export may be incomplete. */
  warning?: string;
}

const REPLIES_PAGE_LIMIT = 200;
const DEFAULT_MAX_PAGES = 2000;
const DEFAULT_MAX_RETRIES = 5;
/** Cap for exponential backoff (used only when Retry-After is missing/invalid). */
const MAX_BACKOFF_MS = 60_000;
/** Longest Retry-After we are willing to honor before giving up. */
export const MAX_RETRY_AFTER_MS = 10 * 60_000;
/** Extra random delay added on top of Retry-After to de-synchronize workers. */
const RETRY_AFTER_JITTER_MS = 500;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Delay before retry #attempt (0-based).
 * - Valid Retry-After: honored fully (plus up to 500ms jitter); above 10 minutes we
 *   give up with a readable error instead of waiting.
 * - Missing/invalid: exponential 1s, 2s, 4s… capped at 60s, with "equal jitter"
 *   (between 50% and 100% of the step) so parallel callers do not retry in lockstep.
 */
export function backoffMs(attempt: number, retryAfterSec?: number, random: () => number = Math.random): number {
  if (typeof retryAfterSec === 'number' && Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
    const ms = retryAfterSec * 1000;
    if (ms > MAX_RETRY_AFTER_MS) {
      throw new SlackExportError(
        'ratelimited',
        `Slack is rate limiting requests and asked to wait ${Math.ceil(retryAfterSec / 60)} minutes. Please try again later.`,
      );
    }
    return ms + Math.floor(random() * RETRY_AFTER_JITTER_MS);
  }
  const step = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
  return Math.floor(step / 2 + random() * (step / 2));
}

export function formatWait(ms: number): string {
  const sec = Math.ceil(ms / 1000);
  return sec >= 120 ? `${Math.floor(sec / 60)}m ${sec % 60}s` : `${sec}s`;
}

export async function fetchThread(
  run: PageRunner,
  link: ParsedThreadLink,
  options: FetchThreadOptions = {},
): Promise<FetchThreadResult> {
  const onProgress = options.onProgress ?? (() => {});
  const sleep = options.sleep ?? defaultSleep;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const target = { teamId: link.teamId, domain: link.workspaceDomain };

  // Shared rate-limit gate: a 429 seen by any caller pauses every caller
  // (e.g. the whole users.info pool) until the wait is over.
  let pausedUntil = 0;
  const waitForGate = async () => {
    for (let remaining = pausedUntil - now(); remaining > 0; remaining = pausedUntil - now()) {
      await sleep(remaining);
    }
  };

  /** One API call with rate-limit retries; waiting happens here, not in the page. */
  const callApi = async (method: string, params: Record<string, string>) => {
    for (let attempt = 0; ; attempt++) {
      await waitForGate();
      const res = await run({ ...target, method, params });
      assertPageOk(res);
      if (res.result.error !== 'ratelimited' || attempt >= maxRetries) {
        return { team: res.team, result: res.result };
      }
      const wait = backoffMs(attempt, res.result.retryAfterSec, random);
      const until = now() + wait;
      if (until > pausedUntil) {
        pausedUntil = until;
        onProgress(`Rate limited by Slack — retrying in ${formatWait(wait)}…`);
      }
    }
  };

  // 1) Thread messages with cursor pagination.
  let threadTs = link.threadTs;
  let team: PageTeamInfo | undefined;
  const byTs = new Map<string, SlackMessage>();
  const seenCursors = new Set<string>();
  let cursor = '';
  let redirected = false;
  let warning: string | undefined;
  onProgress('Fetching thread…');

  for (let page = 0; ; page++) {
    if (page >= maxPages) {
      warning = `Stopped after ${maxPages} pages (${byTs.size} messages); the export may be incomplete.`;
      break;
    }
    const params: Record<string, string> = {
      channel: link.channelId,
      ts: threadTs,
      limit: String(REPLIES_PAGE_LIMIT),
      inclusive: 'true',
    };
    if (cursor) params.cursor = cursor;

    const { team: t, result } = await callApi('conversations.replies', params);
    team = t;
    if (!result.ok) {
      const code = result.error ?? 'unknown_error';
      let msg = describeSlackError(code);
      if (t.guessed && (code === 'channel_not_found' || code === 'thread_not_found')) {
        msg += ` (Note: could not match the link's workspace; tried "${t.domain ?? t.id}".)`;
      }
      throw new SlackExportError(code, msg);
    }
    const data = (result.data ?? {}) as SlackRepliesResponse;
    const msgs = Array.isArray(data.messages) ? data.messages : [];

    // If the link points at a reply, restart from its thread parent once.
    const first = msgs[0];
    if (page === 0 && !redirected && first?.thread_ts && first.thread_ts !== threadTs && first.ts === threadTs) {
      threadTs = first.thread_ts;
      redirected = true;
      byTs.clear();
      cursor = '';
      page = -1;
      continue;
    }

    for (const m of msgs) if (m && typeof m.ts === 'string') byTs.set(m.ts, m);
    onProgress(`Fetching… ${byTs.size} messages`);

    // next_cursor is the primary continuation signal.
    const nextCursor = data.response_metadata?.next_cursor ?? '';
    if (!nextCursor) {
      if (data.has_more) {
        warning = `Slack reported more messages but returned no cursor (${byTs.size} messages fetched); the export may be incomplete.`;
      }
      break;
    }
    if (seenCursors.has(nextCursor)) {
      warning = `Slack returned a repeated page cursor (${byTs.size} messages fetched); the export may be incomplete.`;
      break;
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  if (!team) throw new SlackExportError('exception', describeSlackError('exception'));
  const messages = [...byTs.values()].sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));
  if (messages.length === 0) throw new SlackExportError('thread_not_found', describeSlackError('thread_not_found'));

  // 2) Resolve channel + mentioned users/channels (best effort: failures fall back to ids).
  const refs = collectReferences(messages);
  refs.channels.delete(link.channelId);
  const userIds = [...refs.users];
  const channelIds = [...refs.channels];

  const lookups: { method: string; params: Record<string, string> }[] = [
    { method: 'conversations.info', params: { channel: link.channelId } },
    ...channelIds.map((c) => ({ method: 'conversations.info', params: { channel: c } })),
    ...userIds.map((u) => ({ method: 'users.info', params: { user: u } })),
  ];
  let done = 0;
  onProgress(`Resolving names… 0/${lookups.length}`);
  const results = await mapLimit(lookups, options.concurrency ?? 4, async (l) => {
    const { result } = await callApi(l.method, l.params);
    done++;
    if (done % 10 === 0 || done === lookups.length) onProgress(`Resolving names… ${done}/${lookups.length}`);
    return result;
  });

  const mainChannel = results[0]?.ok ? (results[0].data?.channel as SlackConversation | undefined) : undefined;
  const channels: Record<string, string> = {};
  channelIds.forEach((id, i) => {
    const r = results[1 + i];
    const name = r?.ok ? (r.data?.channel as SlackConversation | undefined)?.name : undefined;
    if (name) channels[id] = name;
  });

  const users: Record<string, string> = {};
  // Fallback: inline user_profile included in messages.
  for (const m of messages) {
    if (m.user && m.user_profile) {
      const n = m.user_profile.display_name || m.user_profile.real_name || m.user_profile.name;
      if (n) users[m.user] = n;
    }
  }
  userIds.forEach((id, i) => {
    const r = results[1 + channelIds.length + i];
    const name = r?.ok ? userDisplayName(r.data?.user as SlackUser | undefined) : undefined;
    if (name) users[id] = name;
  });

  // IM: resolve the other participant for the channel label.
  if (mainChannel?.is_im && mainChannel.user && !users[mainChannel.user]) {
    const { result } = await callApi('users.info', { user: mainChannel.user });
    const n = result.ok ? userDisplayName(result.data?.user as SlackUser | undefined) : undefined;
    if (n) users[mainChannel.user] = n;
  }

  onProgress(`Building Markdown for ${messages.length} messages…`);

  const workspaceUrl =
    team.url ?? (link.workspaceDomain ? `https://${link.workspaceDomain}.slack.com/` : 'https://app.slack.com/');
  const data: ThreadData = {
    workspace: { name: team.name, domain: team.domain },
    channel: {
      id: link.channelId,
      name: mainChannel?.name,
      isIm: !!mainChannel?.is_im,
      imUserId: mainChannel?.is_im ? mainChannel.user : undefined,
    },
    threadUrl: buildPermalink(workspaceUrl, link.channelId, threadTs),
    messages,
    users,
    channels,
    truncated: !!warning,
  };
  return { data, team, warning };
}
