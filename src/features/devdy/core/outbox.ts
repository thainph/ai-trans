// Queue of Slack thread links for Devdy. A send is tried right away; when
// Devdy can't take it *for now* (not running / Inbox API off / 503 "server
// stopping", several apps and none chosen, token missing or rejected) the link
// is kept in a small JSON queue and retried with an exponential backoff.
// Anything else (4xx, 5xx storage errors, outdated Devdy) is reported and never
// queued. Resending the same link is safe (Devdy refreshes the thread), so the
// queue is deduplicated by URL. Dependencies are injected so the logic is
// unit-testable.

import {
  describeOutcome,
  isRetryable,
  isSent,
  type ResolveResult,
  type SendOutcome,
  supportsSlackThreadLink,
} from './client';

export interface QueuedLink {
  id: string;
  /** Canonical Slack thread permalink. */
  url: string;
  createdAt: string;
  /** Delivery attempts that reached Devdy and failed (retryable). */
  attempts: number;
  lastError?: string;
}

export interface OutboxState {
  /** Automatic retries stopped after a token problem, until a token is saved. */
  paused?: boolean;
  /** Index into RETRY_DELAYS_MIN of the next automatic retry. */
  backoff?: number;
  /** Last problem worth showing in the Devdy tab (dropped links, migration…). */
  notice?: string;
}

export interface DevdySettings {
  token?: string;
  port?: number;
  /** The user picked `port` among several running Devdy apps → use only that one. */
  pinned?: boolean;
}

export interface OutboxDeps {
  loadEntries(): Promise<QueuedLink[]>;
  saveEntries(entries: QueuedLink[]): Promise<void>;
  loadState(): Promise<OutboxState>;
  saveState(state: OutboxState): Promise<void>;
  loadSettings(): Promise<DevdySettings>;
  savePort(port: number): Promise<void>;
  resolveDevdy(settings: DevdySettings): Promise<ResolveResult>;
  postSlackThread(port: number, token: string, url: string): Promise<SendOutcome>;
  /** (Re)schedule the one-shot retry alarm in `minutes`, or cancel it (null). */
  scheduleRetry(minutes: number | null): Promise<void>;
  now?(): Date;
  newId?(): string;
}

export interface DeliveryResult {
  outcome: SendOutcome;
  message: string;
  /** The link is (still) in the queue and will be retried. */
  queued: boolean;
  /** Links waiting after this call. */
  pending: number;
}

export interface FlushResult {
  sent: number;
  pending: number;
  lastOutcome?: SendOutcome;
}

/** Automatic retry delays (minutes); the last one repeats. */
export const RETRY_DELAYS_MIN = [1, 2, 5, 15, 60] as const;
/** Queued links not delivered within this time are dropped. */
export const OUTBOX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Failed delivery attempts (Devdy reached) before a link is dropped. */
export const MAX_ATTEMPTS = 20;
/** Links kept in the queue; new ones are refused beyond that (queued ones are never evicted). */
export const MAX_ENTRIES = 50;

const errorText = (o: SendOutcome): string => ('message' in o ? o.message : '');
const isTokenProblem = (o: SendOutcome): boolean => o.kind === 'token_missing' || o.kind === 'unauthorized';

type Connection = { ok: true; port: number; token: string } | { ok: false; outcome: SendOutcome };

export class DevdyOutbox {
  /** Serializes every read-modify-write of the queue and every delivery. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: OutboxDeps) {}

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => {});
    return next;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /**
   * Send `url` now; queue it when Devdy can't take it yet. After a successful
   * send, links queued before are delivered too.
   */
  send(url: string): Promise<DeliveryResult> {
    return this.exclusive(async () => {
      const state = await this.deps.loadState();
      let list = this.prune(await this.deps.loadEntries(), state);
      const conn = await this.connect();
      const outcome = conn.ok ? await this.deps.postSlackThread(conn.port, conn.token, url) : conn.outcome;
      let result = outcome;
      let queued = false;
      let sentAny = false;

      if (isRetryable(outcome)) {
        const existing = list.find((e) => e.url === url);
        if (existing) {
          list = list.map((e) => (e === existing ? { ...e, lastError: errorText(outcome) } : e));
          queued = true;
        } else if (list.length >= MAX_ENTRIES) {
          result = {
            kind: 'rejected',
            status: 0,
            message: `Not queued: the Devdy queue is full (${list.length} links waiting). Start Devdy so they can be sent, then try again.`,
          };
        } else {
          list.push({
            id: this.deps.newId?.() ?? crypto.randomUUID(),
            url,
            createdAt: this.now().toISOString(),
            attempts: conn.ok && outcome.kind !== 'unauthorized' ? 1 : 0,
            lastError: errorText(outcome),
          });
          queued = true;
        }
        if (isTokenProblem(outcome)) state.paused = true;
      } else {
        // Sent, or refused for good: a queued copy of the same link has nothing left to do.
        // (An outdated Devdy says nothing about the link: a queued copy waits for the update.)
        if (outcome.kind !== 'outdated') list = list.filter((e) => e.url !== url);
        if (isSent(outcome)) {
          sentAny = true;
          state.paused = false;
          if (conn.ok && list.length) list = (await this.deliver(conn, list, state)).list;
        }
      }

      await this.deps.saveEntries(list);
      await this.finish(state, list.length, sentAny, false);
      return { outcome: result, message: describeOutcome(result), queued, pending: list.length };
    });
  }

  /**
   * Retry everything queued. `auto` (alarm / browser start): respects the token
   * pause and advances the backoff; otherwise (user action) always tries.
   */
  flush(opts: { auto?: boolean } = {}): Promise<FlushResult> {
    return this.exclusive(async () => {
      const auto = !!opts.auto;
      const state = await this.deps.loadState();
      let list = this.prune(await this.deps.loadEntries(), state);
      if (list.length === 0 || (auto && state.paused)) {
        await this.deps.saveEntries(list);
        await this.finish(state, list.length, false, auto);
        return { sent: 0, pending: list.length };
      }

      const conn = await this.connect();
      let sent = 0;
      let lastOutcome: SendOutcome | undefined;
      if (!conn.ok) {
        lastOutcome = conn.outcome;
        list = list.map((e) => ({ ...e, lastError: describeOutcome(conn.outcome) }));
        if (isTokenProblem(conn.outcome)) state.paused = true;
      } else {
        const r = await this.deliver(conn, list, state);
        list = r.list;
        sent = r.sent;
        lastOutcome = r.lastOutcome;
        if (sent) state.paused = false;
      }
      await this.deps.saveEntries(list);
      await this.finish(state, list.length, sent > 0, auto);
      return { sent, pending: list.length, lastOutcome };
    });
  }

  /** Queued links. Lock-free: never waits behind a send. */
  entries(): Promise<QueuedLink[]> {
    return this.deps.loadEntries();
  }

  /** Remove a queued link. */
  remove(id: string): Promise<void> {
    return this.exclusive(async () => {
      const entries = await this.deps.loadEntries();
      const left = entries.filter((e) => e.id !== id);
      await this.deps.saveEntries(left);
      if (left.length === 0) await this.deps.scheduleRetry(null);
    });
  }

  /** A token was saved: resume automatic retries. */
  resume(): Promise<void> {
    return this.exclusive(async () => {
      const state = await this.deps.loadState();
      if (state.paused) await this.deps.saveState({ ...state, paused: false, backoff: 0 });
    });
  }

  /** Show `text` in the Devdy tab until dismissed. */
  setNotice(text: string): Promise<void> {
    return this.exclusive(async () => {
      await this.deps.saveState({ ...(await this.deps.loadState()), notice: text });
    });
  }

  clearNotice(): Promise<void> {
    return this.exclusive(async () => {
      const state = await this.deps.loadState();
      if (state.notice) await this.deps.saveState({ ...state, notice: undefined });
    });
  }

  /**
   * Find the Devdy to send to. Reachability first (with Devdy down, a missing
   * token is not the problem yet), then the "slack-thread-link" feature, then the token.
   */
  private async connect(): Promise<Connection> {
    const settings = await this.deps.loadSettings();
    const found = await this.deps.resolveDevdy(settings);
    if (found.kind === 'none') {
      return { ok: false, outcome: { kind: 'unreachable', message: 'Devdy is not running or the Inbox API is off.' } };
    }
    if (found.kind === 'ambiguous') {
      const ports = found.instances.map((i) => i.port).join(', ');
      return {
        ok: false,
        outcome: { kind: 'choose_instance', message: `Several Devdy apps are running (ports ${ports}).` },
      };
    }
    const { port, health } = found.instance;
    if (port !== settings.port) await this.deps.savePort(port);
    if (!supportsSlackThreadLink(health)) {
      return {
        ok: false,
        outcome: { kind: 'outdated', message: `Devdy ${health.version ?? ''} does not support Slack thread links.` },
      };
    }
    if (!settings.token) {
      return {
        ok: false,
        outcome: { kind: 'token_missing', message: 'No Devdy token set. Paste it from Devdy → Settings → Inbox API.' },
      };
    }
    return { ok: true, port, token: settings.token };
  }

  /**
   * Deliver queued links oldest-first. Retryable problems concern Devdy as a
   * whole (down, stopping, bad token), and an outdated Devdy refuses every
   * link: both stop the round and keep the rest queued. Links refused for good
   * are dropped (with a notice).
   */
  private async deliver(
    conn: { port: number; token: string },
    list: QueuedLink[],
    state: OutboxState,
  ): Promise<{ list: QueuedLink[]; sent: number; lastOutcome?: SendOutcome }> {
    const kept: QueuedLink[] = [];
    const refused: string[] = [];
    let sent = 0;
    let lastOutcome: SendOutcome | undefined;
    let stop: SendOutcome | null = null;
    for (const entry of list) {
      if (stop) {
        kept.push({ ...entry, lastError: describeOutcome(stop) });
        continue;
      }
      const outcome = await this.deps.postSlackThread(conn.port, conn.token, entry.url);
      lastOutcome = outcome;
      if (isSent(outcome)) {
        sent++;
      } else if (isRetryable(outcome) || outcome.kind === 'outdated') {
        // A token problem says nothing about the link: it doesn't count as an attempt.
        const counts = outcome.kind === 'unreachable';
        kept.push({ ...entry, attempts: entry.attempts + (counts ? 1 : 0), lastError: describeOutcome(outcome) });
        if (isTokenProblem(outcome)) state.paused = true;
        stop = outcome;
      } else {
        refused.push(`${entry.url} (${describeOutcome(outcome)})`);
      }
    }
    if (refused.length) {
      state.notice = `Devdy refused ${refused.length} queued link${refused.length === 1 ? '' : 's'}: ${refused.join(', ')}`;
    }
    return { list: kept, sent, lastOutcome };
  }

  /** Drop links past the TTL / attempt limit (with a notice). */
  private prune(entries: QueuedLink[], state: OutboxState): QueuedLink[] {
    const now = this.now().getTime();
    const dropped = entries.filter((e) => now - Date.parse(e.createdAt) > OUTBOX_TTL_MS || e.attempts >= MAX_ATTEMPTS);
    if (dropped.length === 0) return entries;
    const last = dropped.at(-1)?.lastError;
    state.notice =
      `Dropped ${dropped.length} Slack link${dropped.length === 1 ? '' : 's'} that could not be delivered ` +
      `within 7 days / ${MAX_ATTEMPTS} attempts: ${dropped.map((e) => e.url).join(', ')}${last ? ` (last error: ${last})` : ''}`;
    return entries.filter((e) => !dropped.includes(e));
  }

  /** Save the state and (re)schedule the retry alarm with the backoff. */
  private async finish(state: OutboxState, queued: number, sentAny: boolean, auto: boolean): Promise<void> {
    const last = RETRY_DELAYS_MIN.length - 1;
    if (queued === 0 || state.paused) {
      state.backoff = 0;
      await this.deps.scheduleRetry(null);
    } else {
      let step = sentAny ? 0 : Math.min(state.backoff ?? 0, last);
      if (auto && !sentAny) step = Math.min(step + 1, last);
      state.backoff = step;
      await this.deps.scheduleRetry(RETRY_DELAYS_MIN[step]!);
    }
    await this.deps.saveState(state);
  }
}
