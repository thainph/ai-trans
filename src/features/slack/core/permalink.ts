// Parse Slack thread links into { channelId, threadTs, ... }.
// Pure module: no chrome.* or DOM APIs.

export interface ParsedThreadLink {
  /** Subdomain part before ".slack.com", e.g. "papay" or "acme.enterprise". */
  workspaceDomain?: string;
  /** Team id (T…/E…) when present in the URL (app.slack.com client URLs). */
  teamId?: string;
  channelId: string;
  /** Thread parent timestamp, e.g. "1700000000.123456". */
  threadTs: string;
}

export type PermalinkErrorCode = 'EMPTY' | 'NOT_A_URL' | 'NOT_SLACK' | 'UNSUPPORTED_FORMAT' | 'INVALID_TS';

export interface PermalinkError {
  code: PermalinkErrorCode;
  message: string;
}

export type ParseResult = { ok: true; value: ParsedThreadLink } | { ok: false; error: PermalinkError };

const CHANNEL_RE = /^[CGD][A-Z0-9]{2,}$/;
const TEAM_RE = /^[TE][A-Z0-9]{2,}$/;
const TS_RE = /^\d{9,10}\.\d{6}$/;
const P_TS_RE = /^p(\d{16})$/;

function fail(code: PermalinkErrorCode, message: string): ParseResult {
  return { ok: false, error: { code, message } };
}

/** Convert the "p1700000000123456" path segment to "1700000000.123456". */
export function pSegmentToTs(segment: string): string | null {
  const m = P_TS_RE.exec(segment);
  if (!m?.[1]) return null;
  return `${m[1].slice(0, 10)}.${m[1].slice(10)}`;
}

/** Convert "1700000000.123456" back to "p1700000000123456". */
export function tsToPSegment(ts: string): string {
  return `p${ts.replace('.', '')}`;
}

export function buildPermalink(workspaceUrl: string, channelId: string, threadTs: string): string {
  const base = workspaceUrl.endsWith('/') ? workspaceUrl : `${workspaceUrl}/`;
  return `${base}archives/${channelId}/${tsToPSegment(threadTs)}`;
}

export function parseThreadLink(input: string): ParseResult {
  // Users sometimes paste links wrapped in <> (Slack mrkdwn) or with whitespace.
  const raw = (input ?? '').trim().replace(/^<|>$/g, '').trim();
  if (!raw) return fail('EMPTY', 'Please paste a Slack thread link.');

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail('NOT_A_URL', 'This does not look like a URL.');
  }

  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || !(host === 'slack.com' || host.endsWith('.slack.com'))) {
    return fail('NOT_SLACK', 'The link must be a https://*.slack.com URL.');
  }

  const segments = url.pathname.split('/').filter(Boolean);

  // 1) app.slack.com/client/<TEAM>/<CHANNEL>/thread/<CHANNEL>-<ts>
  if (host === 'app.slack.com') {
    if (segments[0] !== 'client') {
      return fail('UNSUPPORTED_FORMAT', 'Unsupported app.slack.com URL. Open the thread or use "Copy link".');
    }
    const teamId = segments[1];
    const threadIdx = segments.indexOf('thread');
    const threadSeg = threadIdx >= 0 ? segments[threadIdx + 1] : undefined;
    if (!teamId || !TEAM_RE.test(teamId) || !threadSeg) {
      return fail('UNSUPPORTED_FORMAT', 'This app.slack.com URL does not point to a thread. Open the thread first.');
    }
    const dash = threadSeg.indexOf('-');
    const channelId = dash > 0 ? threadSeg.slice(0, dash) : '';
    const ts = dash > 0 ? decodeURIComponent(threadSeg.slice(dash + 1)) : '';
    if (!CHANNEL_RE.test(channelId)) {
      return fail('UNSUPPORTED_FORMAT', 'Could not find a channel id in the thread URL.');
    }
    if (!TS_RE.test(ts)) return fail('INVALID_TS', 'Invalid thread timestamp in the URL.');
    return { ok: true, value: { teamId, channelId, threadTs: ts } };
  }

  // 2) <sub>.slack.com/archives/<CHANNEL>/p<16 digits>[?thread_ts=…&cid=…]
  if (segments[0] !== 'archives') {
    return fail(
      'UNSUPPORTED_FORMAT',
      'Expected a message link like https://<workspace>.slack.com/archives/<channel>/p<ts>.',
    );
  }
  const channelId = segments[1] ?? '';
  if (!CHANNEL_RE.test(channelId)) {
    return fail('UNSUPPORTED_FORMAT', 'Could not find a channel id in the link.');
  }
  const pSeg = segments[2];
  if (!pSeg) {
    return fail('UNSUPPORTED_FORMAT', 'This is a channel link, not a message/thread link.');
  }

  const threadTsParam = url.searchParams.get('thread_ts');
  let threadTs: string | null;
  if (threadTsParam) {
    threadTs = TS_RE.test(threadTsParam) ? threadTsParam : null;
  } else {
    threadTs = pSegmentToTs(pSeg);
  }
  if (!threadTs) return fail('INVALID_TS', 'Invalid message timestamp in the link.');

  const workspaceDomain = host === 'slack.com' ? undefined : host.slice(0, -'.slack.com'.length);
  const value: ParsedThreadLink = { channelId, threadTs };
  if (workspaceDomain) value.workspaceDomain = workspaceDomain;
  return { ok: true, value };
}
