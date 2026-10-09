// Client for Devdy's local Inbox API (contract: devdy docs/slack-thread-inbox-api.md).
//
//   GET  /health            → {"app":"devdy","version":"…","api":1}   (no token)
//   GET  /v1/projects       → [{"id","name"}]                         (Bearer token)
//   POST /v1/slack-threads  → 201 {"id","status":"created"} | 200 {"id","status":"updated"}
//   POST /v1/web-pages      → same (web page / selection captures)
//
// Loopback only, on the first free port in 47821…47830. Must be called from an
// extension context (service worker / offscreen): Devdy only accepts a
// chrome-extension:// Origin. `fetch` is injectable for tests.

export const DEVDY_PORT_FIRST = 47821;
export const DEVDY_PORT_LAST = 47830;
/** Devdy rejects bodies over 50 MB (413). */
export const DEVDY_MAX_BODY_BYTES = 50 * 1024 * 1024;
/** Devdy accepts at most 200 zip entries (the .md + 199 attachments). */
export const DEVDY_MAX_ATTACHMENTS = 199;

const HEALTH_TIMEOUT_MS = 800;
const REQUEST_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 5 * 60_000;

export type FetchFn = typeof fetch;

/** Inbox endpoint (`/v1/<kind>`). */
export type CaptureKind = 'slack-threads' | 'web-pages';

export interface DevdyHealth {
  app: 'devdy';
  version?: string;
  api?: number;
}

export interface DevdyProject {
  id: string;
  name: string;
}

export type SendOutcome =
  | { kind: 'created' | 'updated'; id: string }
  /** Devdy not running / port not found / network error → queue and retry later. */
  | { kind: 'unreachable'; message: string }
  /** Several Devdy apps answer /health and none is chosen → ask the user; retry afterwards. */
  | { kind: 'choose_instance'; message: string }
  /** No token saved yet → ask the user to paste it; retry afterwards. */
  | { kind: 'no_token'; message: string }
  /** Wrong or regenerated token → ask the user to paste it again; retry afterwards. */
  | { kind: 'unauthorized'; message: string }
  /** Devdy storage error → retry later. */
  | { kind: 'server_error'; message: string }
  /** Payload rejected (400/403/413/415…) → retrying the same payload won't help. */
  | { kind: 'rejected'; status: number; message: string };

/** Outcomes worth keeping in the outbox for a later retry. */
export function isRetryable(o: SendOutcome): boolean {
  return (
    o.kind === 'unreachable' ||
    o.kind === 'choose_instance' ||
    o.kind === 'no_token' ||
    o.kind === 'unauthorized' ||
    o.kind === 'server_error'
  );
}

const base = (port: number) => `http://127.0.0.1:${port}`;

async function readError(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: unknown };
    if (typeof j?.error === 'string' && j.error) return j.error;
  } catch {
    // not JSON
  }
  return `HTTP ${res.status}`;
}

/** Health check of one port; null if it is not a Devdy inbox. */
export async function checkHealth(port: number, fetchFn: FetchFn = fetch): Promise<DevdyHealth | null> {
  try {
    const res = await fetchFn(`${base(port)}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const j = (await res.json()) as Partial<DevdyHealth>;
    return j?.app === 'devdy' ? (j as DevdyHealth) : null;
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

export interface CapturePayload {
  /** Endpoint; defaults to slack-threads. */
  kind?: CaptureKind;
  body: Blob;
  /** "application/zip" or "text/markdown; charset=utf-8". */
  contentType: string;
  projectId?: string;
  /** Sent as `Idempotency-Key` (the outbox entry id) so a resend after a crash can be deduplicated. */
  idempotencyKey?: string;
}

export async function postCapture(
  port: number,
  token: string,
  payload: CapturePayload,
  fetchFn: FetchFn = fetch,
): Promise<SendOutcome> {
  const kind = payload.kind ?? 'slack-threads';
  if (payload.body.size > DEVDY_MAX_BODY_BYTES) {
    return { kind: 'rejected', status: 413, message: 'The export is larger than Devdy’s 50 MB limit.' };
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': payload.contentType,
  };
  if (payload.projectId) headers['X-Devdy-Project-Id'] = payload.projectId;
  if (payload.idempotencyKey) headers['Idempotency-Key'] = payload.idempotencyKey;

  let res: Response;
  try {
    res = await fetchFn(`${base(port)}/v1/${kind}`, {
      method: 'POST',
      headers,
      body: payload.body,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
  } catch {
    return { kind: 'unreachable', message: 'Devdy is not reachable.' };
  }

  if (res.status === 200 || res.status === 201) {
    const j = (await res.json().catch(() => ({}))) as { id?: unknown; status?: unknown };
    return { kind: j.status === 'updated' || res.status === 200 ? 'updated' : 'created', id: String(j.id ?? '') };
  }
  const message = await readError(res);
  if (res.status === 401) return { kind: 'unauthorized', message };
  if (res.status >= 500) return { kind: 'server_error', message };
  return { kind: 'rejected', status: res.status, message };
}

/** One-line user message for an outcome. */
export function describeOutcome(o: SendOutcome): string {
  switch (o.kind) {
    case 'created':
      return 'Sent to Devdy.';
    case 'updated':
      return 'Updated the existing item in Devdy.';
    case 'choose_instance':
      return 'Several Devdy apps are running — pick one in AI Trans → Devdy. The export is queued.';
    case 'unreachable':
      return 'Devdy is not running — queued, it will be sent automatically when Devdy is available.';
    case 'no_token':
      return 'Queued: set the Devdy token (Devdy → Settings → Inbox API) and it will be sent.';
    case 'unauthorized':
      return 'Devdy rejected the token. Paste the token from Devdy → Settings → Inbox API again.';
    case 'server_error':
      return `Devdy could not save it (${o.message}) — queued for retry.`;
    case 'rejected':
      // status 0: refused locally (queue full, data missing…) — the message says why.
      if (o.status === 0) return o.message;
      return o.status === 413
        ? 'The export is too large for Devdy (max 50 MB zipped / 200 MB unzipped). It is kept in AI Trans → Devdy, where you can download it.'
        : `Devdy rejected the export (${o.message}). It is kept in AI Trans → Devdy.`;
  }
}
