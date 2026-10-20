// Client for Devdy's local Inbox API (contract: Devdy docs/inbox-api.md, 2026-10-20).
//
//   GET  /health            → {"app":"devdy","version":"…","api":1,"features":["translate","grammar","slack-thread-link"]}   (no token)
//   GET  /v1/projects       → [{"id","name"}]                         (Bearer token)
//   POST /v1/slack-threads  → JSON {"url"} → 202 {"id","status":"created"|"existing","fetchStatus","errorCode"?}
//                             (only when features has "slack-thread-link"; Devdy fetches/translates the thread itself)
//   POST /v1/translate      → see core/translate.ts (only when features has "translate")
//   POST /v1/grammar        → see core/grammar.ts (only when features has "grammar")
//
// Loopback only, on the first free port in 47821…47830. Must be called from an
// extension context (service worker / offscreen): Devdy only accepts a
// chrome-extension:// Origin. `fetch` is injectable for tests.

export const DEVDY_PORT_FIRST = 47821;
export const DEVDY_PORT_LAST = 47830;

const HEALTH_TIMEOUT_MS = 800;
const REQUEST_TIMEOUT_MS = 30_000;

export type FetchFn = typeof fetch;

export interface DevdyHealth {
  app: 'devdy';
  version?: string;
  api?: number;
  /** Optional features ("translate", "grammar", "slack-thread-link"); missing on older Devdy builds. */
  features?: string[];
}

/** Devdy feature flag of `POST /v1/translate`. */
export const TRANSLATE_FEATURE = 'translate';

/** Devdy feature flag of `POST /v1/grammar`. */
export const GRAMMAR_FEATURE = 'grammar';

/** Devdy feature flag of `POST /v1/slack-threads` taking a JSON thread link. */
export const SLACK_THREAD_LINK_FEATURE = 'slack-thread-link';

/** Translation is available only when /health lists the "translate" feature. */
export function supportsTranslate(health: DevdyHealth | null | undefined): boolean {
  return !!health?.features?.includes(TRANSLATE_FEATURE);
}

/** Grammar check is available only when /health lists the "grammar" feature. */
export function supportsGrammar(health: DevdyHealth | null | undefined): boolean {
  return !!health?.features?.includes(GRAMMAR_FEATURE);
}

/**
 * Slack thread links can be sent only when /health lists "slack-thread-link".
 * Older Devdy builds still expect Markdown/zip uploads: never send to them.
 */
export function supportsSlackThreadLink(health: DevdyHealth | null | undefined): boolean {
  return !!health?.features?.includes(SLACK_THREAD_LINK_FEATURE);
}

/** Keep the /health fields we use, with their types checked. */
export function parseHealth(j: unknown): DevdyHealth | null {
  if (!j || typeof j !== 'object' || (j as { app?: unknown }).app !== 'devdy') return null;
  const { version, api, features } = j as Record<string, unknown>;
  const health: DevdyHealth = { app: 'devdy' };
  if (typeof version === 'string') health.version = version;
  if (typeof api === 'number') health.api = api;
  if (Array.isArray(features)) health.features = features.filter((f): f is string => typeof f === 'string');
  return health;
}

export interface DevdyProject {
  id: string;
  name: string;
}

/** `code` of a 400 from `POST /v1/slack-threads`. */
export type SlackThreadErrorCode =
  | 'invalid_json'
  | 'invalid_link'
  | 'dm_unsupported'
  | 'invalid_project'
  | 'invalid_title';

export type SendOutcome =
  /**
   * 202: `created` = new thread, `existing` = already in Devdy (refreshed).
   * `errorCode: "no_token"`: saved, but Devdy has no Slack token to fetch it.
   */
  | { kind: 'created' | 'existing'; id: string; fetchStatus?: string; errorCode?: string }
  /** Devdy not running / Inbox API off / connection error / 503 "server stopping" → queue and retry later. */
  | { kind: 'unreachable'; message: string }
  /** Several Devdy apps answer /health and none is chosen → ask the user; retry afterwards. */
  | { kind: 'choose_instance'; message: string }
  /** No Inbox API token saved yet → ask the user to paste it; retry afterwards. */
  | { kind: 'token_missing'; message: string }
  /** 401: wrong or regenerated token → ask the user to paste it again; retry afterwards. */
  | { kind: 'unauthorized'; message: string }
  /** Devdy without "slack-thread-link" (or 404/415 from an older/newer build) → update Devdy; not queued. */
  | { kind: 'outdated'; status?: number; message: string }
  /** Refused (400 with `code`, 413, 500…) → resending the same link won't help; not queued. */
  | { kind: 'rejected'; status: number; code?: string; message: string };

/** Outcomes worth keeping in the queue for a later retry (Inbox API §9.3). */
export function isRetryable(o: SendOutcome): boolean {
  return (
    o.kind === 'unreachable' || o.kind === 'choose_instance' || o.kind === 'token_missing' || o.kind === 'unauthorized'
  );
}

export const isSent = (o: SendOutcome): boolean => o.kind === 'created' || o.kind === 'existing';

/** Base URL of the Devdy inbox on `port`. */
export const base = (port: number): string => `http://127.0.0.1:${port}`;

/** `error` and `code` of a Devdy JSON error body (`error` falls back to `HTTP <status>`). */
export async function readErrorBody(res: Response): Promise<{ error: string; code?: string }> {
  try {
    const j = (await res.json()) as { error?: unknown; code?: unknown };
    const error = typeof j?.error === 'string' && j.error ? j.error : `HTTP ${res.status}`;
    return typeof j?.code === 'string' && j.code ? { error, code: j.code } : { error };
  } catch {
    return { error: `HTTP ${res.status}` };
  }
}

/** The `error` of a Devdy JSON error body, or `HTTP <status>`. */
export async function readError(res: Response): Promise<string> {
  return (await readErrorBody(res)).error;
}

/** Health check of one port; null if it is not a Devdy inbox. */
export async function checkHealth(port: number, fetchFn: FetchFn = fetch): Promise<DevdyHealth | null> {
  try {
    const res = await fetchFn(`${base(port)}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    if (!res.ok) return null;
    return parseHealth(await res.json());
  } catch {
    return null;
  }
}

export interface DevdyInstance {
  port: number;
  health: DevdyHealth;
}

/** Every Devdy inbox answering on 47821…47830 (e.g. a production and a dev build). */
export async function findAllDevdy(fetchFn: FetchFn = fetch): Promise<DevdyInstance[]> {
  const ports = Array.from({ length: DEVDY_PORT_LAST - DEVDY_PORT_FIRST + 1 }, (_, i) => DEVDY_PORT_FIRST + i);
  const found = await Promise.all(ports.map(async (port) => ({ port, health: await checkHealth(port, fetchFn) })));
  return found.filter((f): f is DevdyInstance => f.health !== null);
}

export type ResolveResult =
  | { kind: 'ok'; instance: DevdyInstance }
  | { kind: 'none' }
  /** Several instances and the user has not picked one. */
  | { kind: 'ambiguous'; instances: DevdyInstance[] };

/**
 * Which Devdy to talk to. A port the user picked (`pinned`) is used exclusively;
 * otherwise the single running instance — never a guess between several.
 */
export async function resolveDevdy(
  settings: { port?: number; pinned?: boolean },
  fetchFn: FetchFn = fetch,
): Promise<ResolveResult> {
  if (settings.pinned && settings.port) {
    const health = await checkHealth(settings.port, fetchFn);
    return health ? { kind: 'ok', instance: { port: settings.port, health } } : { kind: 'none' };
  }
  return resolveFromInstances(await findAllDevdy(fetchFn), settings);
}

/** `resolveDevdy` from an already probed `findAllDevdy()` list (no extra requests). */
export function resolveFromInstances(
  all: DevdyInstance[],
  settings: { port?: number; pinned?: boolean },
): ResolveResult {
  if (settings.pinned && settings.port) {
    const pinned = all.find((i) => i.port === settings.port);
    return pinned ? { kind: 'ok', instance: pinned } : { kind: 'none' };
  }
  if (all.length === 0) return { kind: 'none' };
  if (all.length === 1) return { kind: 'ok', instance: all[0]! };
  return { kind: 'ambiguous', instances: all };
}

/** A port Devdy may listen on (47821…47830). */
export function isDevdyPort(port: unknown): port is number {
  return Number.isInteger(port) && (port as number) >= DEVDY_PORT_FIRST && (port as number) <= DEVDY_PORT_LAST;
}

export type ProjectsResult =
  | { ok: true; projects: DevdyProject[] }
  | { ok: false; kind: 'unauthorized' | 'unreachable' | 'error'; message: string };

export async function listProjects(port: number, token: string, fetchFn: FetchFn = fetch): Promise<ProjectsResult> {
  let res: Response;
  try {
    res = await fetchFn(`${base(port)}/v1/projects`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, kind: 'unreachable', message: 'Devdy is not reachable.' };
  }
  if (res.status === 401) return { ok: false, kind: 'unauthorized', message: await readError(res) };
  if (!res.ok) return { ok: false, kind: 'error', message: await readError(res) };
  const list = (await res.json()) as unknown;
  const projects = Array.isArray(list)
    ? list
        .filter((p): p is DevdyProject => typeof p?.id === 'string' && typeof p?.name === 'string')
        .map((p) => ({ id: p.id, name: p.name }))
    : [];
  return { ok: true, projects };
}

/**
 * Send one Slack thread link. Only `Authorization` and `Content-Type` are sent
 * (project/title would go in the JSON body; no `X-Devdy-*` headers).
 */
export async function postSlackThread(
  port: number,
  token: string,
  url: string,
  fetchFn: FetchFn = fetch,
): Promise<SendOutcome> {
  let res: Response;
  try {
    res = await fetchFn(`${base(port)}/v1/slack-threads`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { kind: 'unreachable', message: 'Devdy is not reachable.' };
  }
  return slackThreadOutcome(res);
}

/** Map a `POST /v1/slack-threads` response to an outcome. */
export async function slackThreadOutcome(res: Response): Promise<SendOutcome> {
  if (res.ok) {
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const out: SendOutcome = {
      kind: j.status === 'existing' ? 'existing' : 'created',
      id: typeof j.id === 'string' ? j.id : '',
    };
    if (typeof j.fetchStatus === 'string') out.fetchStatus = j.fetchStatus;
    if (typeof j.errorCode === 'string' && j.errorCode) out.errorCode = j.errorCode;
    return out;
  }
  const { error, code } = await readErrorBody(res);
  if (res.status === 401) return { kind: 'unauthorized', message: error };
  // "server stopping": the Inbox API was switched off mid-request, nothing was saved.
  if (res.status === 503) return { kind: 'unreachable', message: error };
  if (res.status === 404 || res.status === 415) return { kind: 'outdated', status: res.status, message: error };
  return code
    ? { kind: 'rejected', status: res.status, code, message: error }
    : { kind: 'rejected', status: res.status, message: error };
}

const REJECTED_BY_CODE: Record<SlackThreadErrorCode, string> = {
  invalid_link: 'Not a Slack thread link.',
  dm_unsupported: 'Direct messages (DMs) are not supported by Devdy.',
  invalid_project: 'Devdy does not know that project — reload the project list.',
  invalid_title: 'The title must be 1–200 characters.',
  invalid_json: 'Devdy could not read the request (invalid JSON).',
};

/** Saved by Devdy, but Devdy has no Slack token to fetch the thread. */
export const NO_SLACK_TOKEN_MESSAGE =
  'Saved, but Devdy has no Slack token: add the Slack MCP server (SLACK_MCP_XOXP_TOKEN) in Devdy, then Refresh.';

/** One-line user message for an outcome. */
export function describeOutcome(o: SendOutcome): string {
  switch (o.kind) {
    case 'created':
      return o.errorCode === 'no_token'
        ? NO_SLACK_TOKEN_MESSAGE
        : 'Sent — Devdy is fetching and translating the thread.';
    case 'existing':
      return o.errorCode === 'no_token' ? NO_SLACK_TOKEN_MESSAGE : 'Already in Devdy — refreshing.';
    case 'unreachable':
      return 'Devdy is not running or the Inbox API is off — queued.';
    case 'choose_instance':
      return 'Several Devdy apps are running — pick one in AI Trans → Devdy. The link is queued.';
    case 'token_missing':
      return 'Queued: set the Devdy token (Devdy → Settings → Inbox API) in AI Trans → Devdy and it will be sent.';
    case 'unauthorized':
      return 'Devdy rejected the token — paste it again in AI Trans → Devdy. The link is queued.';
    case 'outdated':
      return o.status === 415
        ? 'Devdy version mismatch — update Devdy to send Slack threads.'
        : 'Update Devdy to send Slack threads.';
    case 'rejected':
      // status 0: refused locally (queue full…) — the message says why.
      if (o.status === 0) return o.message;
      if (o.code && o.code in REJECTED_BY_CODE) return REJECTED_BY_CODE[o.code as SlackThreadErrorCode];
      if (o.status === 413) return 'The request is too large for Devdy.';
      return `Devdy could not take the link (${o.message}).`;
  }
}
