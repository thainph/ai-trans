// Devdy translation (`POST /v1/translate`, contract: devdy docs/inbox-api.md §6.5).
//
//   body {"text","targetLang"} (≤ 64 KB; text ≤ 8000 chars after trim, non-empty)
//   JSON: 200 {"text","targetLang"}
//   SSE (Accept: text/event-stream): `chunk {"delta"}`… then exactly one of
//        `done {"text","targetLang"}` (authoritative full text) or `error {"error"}`
//   Errors before the stream starts are JSON {"error"} with a status code.
//
// Engine, model and style come from Devdy's settings. Translations are
// serialized (FIFO) on one engine session shared with the app; aborting frees
// the concurrency slot but the engine still finishes that turn. Pure apart from
// the injectable `fetch` → unit-tested. Service-worker only (CORS / PNA).

import { base, type FetchFn, readError } from './client';

/** Longest `text` Devdy accepts (Unicode characters after trim). */
export const DEVDY_TRANSLATE_MAX_CHARS = 8000;
/** Devdy gives up after 90 s; we wait a little longer for its own error. */
export const JSON_TIMEOUT_MS = 120_000;
/** SSE: no byte (keep-alive comments included, every 15 s) for this long → give up. */
const STREAM_IDLE_TIMEOUT_MS = 100_000;

export type DevdyTranslateErrorCode =
  /** Connection refused: Devdy not running or its Inbox API turned off. */
  | 'unreachable'
  /** Several Devdy apps answer and none is pinned in the Devdy tab. */
  | 'choose_instance'
  /** /health has no "translate" (or "grammar") feature (older Devdy). */
  | 'unsupported'
  | 'no_token'
  /** 401 */
  | 'unauthorized'
  /** 413 */
  | 'too_long'
  /** 429: 4 translations / grammar checks already in flight. */
  | 'busy'
  /** 503 `translation engine unavailable: …` / `grammar engine unavailable: …` */
  | 'engine_unavailable'
  /** 503 `server stopping` (Inbox API turned off mid-request). */
  | 'stopping'
  /** 502 / SSE error: the engine failed (grammar: also `invalid grammar result`). */
  | 'engine_error'
  /** 504 / SSE `timeout` / no data for too long. */
  | 'timeout'
  /** 400 / 415: a bug on our side. */
  | 'bad_request'
  /** The stream ended without `done` / `error`, or the connection dropped mid-way. */
  | 'interrupted'
  /** Unexpected response shape. */
  | 'protocol'
  /** Aborted by the caller. */
  | 'cancelled';

/** What a Devdy engine request was for (only changes the user-facing wording). */
export type DevdyTask = 'translate' | 'grammar';

/** Error of a Devdy translation / grammar check; `message` is the user-facing text. */
export class DevdyTranslateError extends Error {
  constructor(
    readonly code: DevdyTranslateErrorCode,
    /** Devdy's own message (English, for logs), if any. */
    readonly detail = '',
    /** HTTP status when the error came from a response. */
    readonly status?: number,
    readonly task: DevdyTask = 'translate',
  ) {
    super(describeTranslateError(code, detail, task));
    this.name = 'DevdyTranslateError';
  }
}

/** Errors the user fixes in AI Trans → Devdy (token / instance choice). */
export function needsDevdySettings(code: DevdyTranslateErrorCode): boolean {
  return code === 'no_token' || code === 'unauthorized' || code === 'choose_instance';
}

/** Error code for a pre-stream error response (branch on the status, not the message). */
export function codeForStatus(status: number, message: string): DevdyTranslateErrorCode {
  switch (status) {
    case 400:
    case 415:
      return 'bad_request';
    case 401:
      return 'unauthorized';
    case 413:
      return 'too_long';
    case 429:
      return 'busy';
    case 502:
      return 'engine_error';
    case 503:
      return /^server stopping/i.test(message) ? 'stopping' : 'engine_unavailable';
    case 504:
      return 'timeout';
    default:
      return status >= 500 ? 'engine_error' : 'protocol';
  }
}

/** Error code of an SSE `error` event. */
export function codeForStreamError(message: string): DevdyTranslateErrorCode {
  if (message === 'timeout') return 'timeout';
  if (/^server stopping/i.test(message)) return 'stopping';
  return 'engine_error';
}

/** Engine messages can be stack traces: keep the first line, bounded. */
function shortDetail(detail: string, max = 200): string {
  const line = detail.trim().split('\n')[0]!.trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** One-line user message per error code. */
export function describeTranslateError(
  code: DevdyTranslateErrorCode,
  detail = '',
  task: DevdyTask = 'translate',
): string {
  const d = shortDetail(detail);
  const work = task === 'grammar' ? 'grammar check' : 'translation';
  switch (code) {
    case 'unreachable':
      return 'Devdy is not running or its Inbox API is turned off (Devdy → Settings → Inbox API).';
    case 'choose_instance':
      return 'Several Devdy apps are running — pick one in AI Trans → Devdy.';
    case 'unsupported':
      return task === 'grammar'
        ? 'This Devdy version cannot check grammar. Update Devdy to a build with the grammar feature.'
        : 'This Devdy version cannot translate. Update Devdy to a build with the translate feature.';
    case 'no_token':
      return 'No Devdy token set. Paste it in AI Trans → Devdy (from Devdy → Settings → Inbox API).';
    case 'unauthorized':
      return 'Devdy rejected the token. Paste the token from Devdy → Settings → Inbox API in AI Trans → Devdy.';
    case 'too_long':
      return `The text is too long for Devdy (max ${DEVDY_TRANSLATE_MAX_CHARS.toLocaleString('en-US')} characters). Select a shorter passage.`;
    case 'busy':
      return task === 'grammar'
        ? 'Devdy is busy with other translations or grammar checks. Try again in a moment.'
        : 'Devdy is busy with other translations. Try again in a moment.';
    case 'engine_unavailable':
      return `Devdy's translation engine is unavailable${d ? ` (${d.replace(/^(translation|grammar) engine unavailable:\s*/i, '')})` : ''}. Check the translation settings in Devdy (Claude/Codex sign-in, Node/CLI path).`;
    case 'stopping':
      return 'Devdy’s Inbox API was turned off. Turn it back on in Devdy → Settings → Inbox API.';
    case 'engine_error':
      return d ? `Devdy ${work} failed: ${d}` : `Devdy ${work} failed.`;
    case 'timeout':
      return `Devdy did not finish the ${work} in time. Try again.`;
    case 'bad_request':
      return `Devdy rejected the request${d ? ` (${d})` : ''}.`;
    case 'interrupted':
      return `The connection to Devdy closed before the ${work} finished. Try again.`;
    case 'protocol':
      return `Unexpected response from Devdy${d ? ` (${d})` : ''}.`;
    case 'cancelled':
      return 'Cancelled';
  }
}

// --- SSE ---

export interface SseEvent {
  /** `event:` field; "message" when absent. */
  event: string;
  /** `data:` lines joined with "\n". */
  data: string;
}

/**
 * Incremental Server-Sent Events parser (WHATWG event-stream format): feed it
 * decoded text as it arrives, in chunks of any size. Handles LF, CRLF and CR
 * line ends (also split across chunks), multi-line `data`, `:` comments
 * (keep-alives) and fields without a space after the colon. `id` / `retry`
 * are ignored. Events without data are not dispatched.
 */
export class SseParser {
  private buffer = '';
  /** The previous chunk ended with "\r": a leading "\n" of the next one belongs to it. */
  private skipLf = false;
  private event = '';
  private data: string[] = [];

  push(chunk: string): SseEvent[] {
    let text = chunk;
    if (this.skipLf && text.startsWith('\n')) text = text.slice(1);
    this.skipLf = false;
    this.buffer += text;
    const out: SseEvent[] = [];
    for (;;) {
      const m = /\r\n|\r|\n/.exec(this.buffer);
      if (!m) break;
      // A trailing "\r" may be the first half of "\r\n".
      if (m[0] === '\r' && m.index === this.buffer.length - 1) {
        this.skipLf = true;
      }
      const line = this.buffer.slice(0, m.index);
      this.buffer = this.buffer.slice(m.index + m[0].length);
      const ev = this.line(line);
      if (ev) out.push(ev);
    }
    return out;
  }

  /**
   * End of stream. The spec drops an event that has no terminating blank line;
   * we dispatch it anyway so a final `done` is never lost.
   */
  end(): SseEvent[] {
    const out: SseEvent[] = [];
    if (this.buffer) {
      const ev = this.line(this.buffer);
      this.buffer = '';
      if (ev) out.push(ev);
    }
    const last = this.dispatch();
    if (last) out.push(last);
    return out;
  }

  private line(line: string): SseEvent | null {
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.event = value;
    else if (field === 'data') this.data.push(value);
    return null;
  }

  private dispatch(): SseEvent | null {
    const ev = this.data.length > 0 ? { event: this.event || 'message', data: this.data.join('\n') } : null;
    this.event = '';
    this.data = [];
    return ev;
  }
}

// --- Requests ---

export interface TranslateInput {
  text: string;
  /** Devdy code (vi, en, ja…) or a language name; null → Devdy's default target. */
  targetLang: string | null;
}

export interface TranslateResult {
  text: string;
  /** Target as resolved by Devdy (not normalized). */
  targetLang?: string;
}

export interface TranslateOptions {
  signal?: AbortSignal;
  fetchFn?: FetchFn;
}

function parseResult(j: unknown): TranslateResult | null {
  if (!j || typeof j !== 'object') return null;
  const { text, targetLang } = j as Record<string, unknown>;
  if (typeof text !== 'string') return null;
  return typeof targetLang === 'string' ? { text, targetLang } : { text };
}

/** Text Devdy would refuse before calling the engine (empty / too long). */
export function checkTranslateText(text: string, task: DevdyTask = 'translate'): DevdyTranslateError | null {
  const trimmed = text.trim();
  if (!trimmed) return new DevdyTranslateError('bad_request', 'text is empty', undefined, task);
  if ([...trimmed].length > DEVDY_TRANSLATE_MAX_CHARS) return new DevdyTranslateError('too_long', '', undefined, task);
  return null;
}

/** A signal aborted by `signal` or by `timeout.abort()` (whichever comes first). */
export function linkedController(signal?: AbortSignal): AbortController {
  const ctrl = new AbortController();
  if (signal?.aborted) ctrl.abort(signal.reason);
  else signal?.addEventListener('abort', () => ctrl.abort(signal.reason), { once: true });
  return ctrl;
}

export interface EngineRequest {
  task: DevdyTask;
  /** `/v1/translate` or `/v1/grammar`. */
  path: string;
  body: { text: string } & Record<string, unknown>;
  accept: string;
  /** Aborted by the caller or by our timeout. */
  signal: AbortSignal;
  /** The caller's own signal (tells a cancel from a timeout). */
  callerSignal: AbortSignal | undefined;
  fetchFn: FetchFn;
}

/** POST a text to one of Devdy's engine endpoints; non-2xx answers become DevdyTranslateError. */
export async function postEngine(port: number, token: string, req: EngineRequest): Promise<Response> {
  // Call fetch unbound: `req.fetchFn(…)` would run it with `this = req` → "Illegal invocation" in Chrome.
  const { task, signal, callerSignal, fetchFn } = req;
  const refused = checkTranslateText(req.body.text, task);
  if (refused) throw refused;
  let res: Response;
  try {
    res = await fetchFn(`${base(port)}${req.path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: req.accept },
      body: JSON.stringify(req.body),
      signal,
    });
  } catch (err) {
    if (callerSignal?.aborted) throw new DevdyTranslateError('cancelled', '', undefined, task);
    if (signal.aborted) throw new DevdyTranslateError('timeout', '', undefined, task);
    throw new DevdyTranslateError('unreachable', err instanceof Error ? err.message : String(err), undefined, task);
  }
  if (!res.ok) {
    const message = await readError(res);
    throw new DevdyTranslateError(codeForStatus(res.status, message), message, res.status, task);
  }
  return res;
}

function post(
  port: number,
  token: string,
  input: TranslateInput,
  accept: string,
  signal: AbortSignal,
  callerSignal: AbortSignal | undefined,
  fetchFn: FetchFn,
): Promise<Response> {
  return postEngine(port, token, {
    task: 'translate',
    path: '/v1/translate',
    body: { text: input.text, targetLang: input.targetLang },
    accept,
    signal,
    callerSignal,
    fetchFn,
  });
}

/** Translate in one response (JSON mode). */
export async function translateJson(
  port: number,
  token: string,
  input: TranslateInput,
  { signal, fetchFn = fetch }: TranslateOptions = {},
): Promise<TranslateResult> {
  const ctrl = linkedController(signal);
  const timer = setTimeout(() => ctrl.abort(new DOMException('Timeout', 'TimeoutError')), JSON_TIMEOUT_MS);
  try {
    const res = await post(port, token, input, 'application/json', ctrl.signal, signal, fetchFn);
    let j: unknown;
    try {
      j = await res.json();
    } catch {
      if (signal?.aborted) throw new DevdyTranslateError('cancelled');
      if (ctrl.signal.aborted) throw new DevdyTranslateError('timeout');
      throw new DevdyTranslateError('protocol', 'invalid JSON');
    }
    const result = parseResult(j);
    if (!result) throw new DevdyTranslateError('protocol', 'no text in the response');
    return result;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Translate with Server-Sent Events: `onDelta` gets each chunk as it arrives
 * (display only); resolves with the authoritative text of the `done` event.
 * EventSource can't send POST / Authorization, so the stream is read from fetch.
 */
export async function translateStream(
  port: number,
  token: string,
  input: TranslateInput,
  {
    signal,
    fetchFn = fetch,
    onDelta,
    idleTimeoutMs = STREAM_IDLE_TIMEOUT_MS,
  }: TranslateOptions & { onDelta?: (delta: string) => void; idleTimeoutMs?: number } = {},
): Promise<TranslateResult> {
  const ctrl = linkedController(signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => ctrl.abort(new DOMException('Timeout', 'TimeoutError')), idleTimeoutMs);
  };
  arm();
  try {
    const res = await post(port, token, input, 'text/event-stream', ctrl.signal, signal, fetchFn);
    const type = res.headers.get('content-type') ?? '';
    if (!type.includes('text/event-stream')) {
      // A server that ignores Accept and answers JSON is still fine.
      const result = parseResult(await res.json().catch(() => null));
      if (!result) throw new DevdyTranslateError('protocol', `unexpected content type ${type || '(none)'}`);
      return result;
    }
    if (!res.body) throw new DevdyTranslateError('protocol', 'empty body');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    const handle = (events: SseEvent[]): TranslateResult | null => {
      for (const ev of events) {
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(ev.data) as Record<string, unknown>;
        } catch {
          throw new DevdyTranslateError('protocol', `invalid ${ev.event} event`);
        }
        if (ev.event === 'chunk') {
          if (typeof payload.delta === 'string' && payload.delta) onDelta?.(payload.delta);
        } else if (ev.event === 'done') {
          const result = parseResult(payload);
          if (!result) throw new DevdyTranslateError('protocol', 'no text in the done event');
          return result;
        } else if (ev.event === 'error') {
          const message = typeof payload.error === 'string' ? payload.error : '';
          throw new DevdyTranslateError(codeForStreamError(message), message);
        }
      }
      return null;
    };

    try {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch {
          if (signal?.aborted) throw new DevdyTranslateError('cancelled');
          if (ctrl.signal.aborted) throw new DevdyTranslateError('timeout');
          throw new DevdyTranslateError('interrupted');
        }
        arm();
        if (chunk.done) {
          const result = handle(parser.end());
          if (result) return result;
          throw new DevdyTranslateError('interrupted');
        }
        const result = handle(parser.push(decoder.decode(chunk.value, { stream: true })));
        if (result) return result;
      }
    } finally {
      // Exactly one terminal event: stop reading (frees the connection) once we have it.
      reader.cancel().catch(() => undefined);
    }
  } finally {
    clearTimeout(timer);
  }
}
