// Outbox for Devdy exports: every export is stored first, then delivered.
// If Devdy is not running (or the token is wrong / Devdy errors), the entry
// stays queued and is retried with an exponential backoff; payloads Devdy
// refuses (400/413…) are kept as "failed" records the user can download or
// remove. The queue is bounded (age, attempts, total size). Dependencies are
// injected so the logic is unit-testable.

import {
  type CaptureKind,
  type CapturePayload,
  describeOutcome,
  isRetryable,
  type ResolveResult,
  type SendOutcome,
} from './client';

export interface OutboxEntry {
  id: string;
  /** Endpoint; entries queued before web pages existed have none → slack-threads. */
  kind?: CaptureKind;
  title: string;
  contentType: string;
  createdAt: string;
  /** Delivery attempts that reached Devdy and failed (retryable). */
  attempts: number;
  lastError?: string;
  /** Payload size in bytes (entries queued by older versions have none). */
  size?: number;
  /** Devdy refused the payload: kept (never retried) so the user can download it. */
  failed?: { status: number; message: string; at: string };
}

export interface OutboxState {
  /** Automatic retries stopped after a token problem, until a token is saved. */
  paused?: boolean;
  /** Index into RETRY_DELAYS_MIN of the next automatic retry. */
  backoff?: number;
  /** Last problem worth showing in the Devdy tab (dropped exports…). */
  notice?: string;
}

export interface DevdySettings {
  token?: string;
  port?: number;
  /** The user picked `port` among several running Devdy apps → use only that one. */
  pinned?: boolean;
}

export interface OutboxDeps {
  loadEntries(): Promise<OutboxEntry[]>;
  saveEntries(entries: OutboxEntry[]): Promise<void>;
  loadState(): Promise<OutboxState>;
  saveState(state: OutboxState): Promise<void>;
  loadSettings(): Promise<DevdySettings>;
  savePort(port: number): Promise<void>;
  putBlob(id: string, blob: Blob): Promise<void>;
  getBlob(id: string): Promise<Blob | undefined>;
  deleteBlob(id: string): Promise<void>;
  listBlobIds(): Promise<string[]>;
  resolveDevdy(settings: DevdySettings): Promise<ResolveResult>;
  postCapture(port: number, token: string, payload: CapturePayload): Promise<SendOutcome>;
  /** (Re)schedule the one-shot retry alarm in `minutes`, or cancel it (null). */
  scheduleRetry(minutes: number | null): Promise<void>;
  now?(): Date;
}

export interface DeliveryResult {
  outcome: SendOutcome;
  message: string;
  /** Entries still waiting after this call. */
  pending: number;
}

export interface FlushResult {
  sent: number;
  pending: number;
  lastOutcome?: SendOutcome;
}

/** Automatic retry delays (minutes); the last one repeats. */
export const RETRY_DELAYS_MIN = [1, 2, 5, 15, 60] as const;
/** Queued exports not delivered within this time are dropped. */
export const OUTBOX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Failed delivery attempts (Devdy reached) before an export is dropped. */
export const MAX_ATTEMPTS = 20;
/** Total payload bytes kept in the outbox (queued + failed). */
export const MAX_OUTBOX_BYTES = 300 * 1024 * 1024;
/** Failed records kept for download; older ones are removed. */
export const MAX_FAILED = 20;

const errorText = (o: SendOutcome): string => ('message' in o ? o.message : '');
export const isQueued = (e: OutboxEntry): boolean => !e.failed;
const isSent = (o: SendOutcome): boolean => o.kind === 'created' || o.kind === 'updated';
const formatMb = (n: number) => `${Math.round(n / (1024 * 1024))} MB`;

const NO_TOKEN: SendOutcome = {
  kind: 'no_token',
  message: 'No Devdy token set. Paste it from Devdy → Settings → Inbox API.',
};

export class DevdyOutbox {
  /** Serializes every read-modify-write of the entry list and every delivery. */
  private chain: Promise<unknown> = Promise.resolve();
  /** Blob ids being written outside the lock (offscreen store-zip) and not enqueued yet. */
  private readonly held = new Set<string>();

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
   * Protect blob `id` from the orphan cleanup while it is written before
   * `enqueue` (e.g. a zip stored by the offscreen document). Returns the release.
   */
  hold(id: string): () => void {
    this.held.add(id);
    return () => this.held.delete(id);
  }

  /** Store a new export, then try to deliver it (and anything queued before it). */
  enqueue(
    entry: Omit<OutboxEntry, 'createdAt' | 'attempts' | 'size' | 'failed'>,
    blob: Blob | null,
  ): Promise<DeliveryResult> {
    return this.exclusive(async () => {
      if (blob) await this.deps.putBlob(entry.id, blob);
      const size = blob?.size ?? (await this.deps.getBlob(entry.id))?.size ?? 0;
      let entries = await this.deps.loadEntries();

      // Make room: drop the oldest failed records first; never evict queued exports.
      const used = () => entries.reduce((sum, e) => sum + (e.size ?? 0), 0);
      while (used() + size > MAX_OUTBOX_BYTES && entries.some((e) => e.failed)) {
        const oldest = entries.find((e) => e.failed)!;
        entries = entries.filter((e) => e !== oldest);
        await this.deps.deleteBlob(oldest.id);
      }
      if (used() + size > MAX_OUTBOX_BYTES) {
        await this.deps.saveEntries(entries);
        await this.deps.deleteBlob(entry.id);
        this.held.delete(entry.id);
        const outcome: SendOutcome = {
          kind: 'rejected',
          status: 0,
          message: `Not queued: the Devdy queue is full (${formatMb(used())} waiting). Start Devdy so queued exports can be sent, then try again.`,
        };
        return { outcome, message: describeOutcome(outcome), pending: entries.filter(isQueued).length };
      }

      entries.push({ ...entry, createdAt: this.now().toISOString(), attempts: 0, size });
      await this.deps.saveEntries(entries);
      this.held.delete(entry.id);
      const results = await this.deliverAll(false);
      const outcome = results.get(entry.id) ?? { kind: 'unreachable' as const, message: 'Not sent yet.' };
      return { outcome, message: describeOutcome(outcome), pending: await this.queuedCount() };
    });
  }

  /**
   * Retry everything queued. `auto` (alarm / browser start): respects the token
   * pause and advances the backoff; otherwise (user action) always tries.
   */
  flush(opts: { auto?: boolean } = {}): Promise<FlushResult> {
    return this.exclusive(async () => {
      await this.removeOrphans();
      const results = await this.deliverAll(!!opts.auto);
      const sent = [...results.values()].filter(isSent).length;
      const last = [...results.values()].at(-1);
      return { sent, pending: await this.queuedCount(), lastOutcome: last };
    });
  }

  /** Current entries (queued and failed). Lock-free: never waits behind an upload. */
  entries(): Promise<OutboxEntry[]> {
    return this.deps.loadEntries();
  }

  /** Delete blobs no entry references (left behind by a crash between store-zip and enqueue). */
  cleanup(): Promise<number> {
    return this.exclusive(() => this.removeOrphans());
  }

  /** Remove a failed record (or a queued entry) and its payload. */
  remove(id: string): Promise<void> {
    return this.exclusive(async () => {
      const entries = await this.deps.loadEntries();
      await this.deps.saveEntries(entries.filter((e) => e.id !== id));
      await this.deps.deleteBlob(id);
    });
  }

  /** A token was saved: resume automatic retries. */
  resume(): Promise<void> {
    return this.exclusive(async () => {
      const state = await this.deps.loadState();
      if (state.paused) await this.deps.saveState({ ...state, paused: false, backoff: 0 });
    });
  }

  clearNotice(): Promise<void> {
    return this.exclusive(async () => {
      const state = await this.deps.loadState();
      if (state.notice) await this.deps.saveState({ ...state, notice: undefined });
    });
  }

  private async queuedCount(): Promise<number> {
    return (await this.deps.loadEntries()).filter(isQueued).length;
  }

  private async removeOrphans(): Promise<number> {
    const referenced = new Set((await this.deps.loadEntries()).map((e) => e.id));
    let removed = 0;
    for (const id of await this.deps.listBlobIds()) {
      if (referenced.has(id) || this.held.has(id)) continue;
      await this.deps.deleteBlob(id);
      removed++;
    }
    return removed;
  }

  /** Drop queued entries past the TTL / attempt limit and expired failed records. */
  private async prune(entries: OutboxEntry[], state: OutboxState): Promise<OutboxEntry[]> {
    const now = this.now().getTime();
    const expired = (e: OutboxEntry) => now - Date.parse(e.createdAt) > OUTBOX_TTL_MS;
    const dropped: OutboxEntry[] = [];
    const kept: OutboxEntry[] = [];
    for (const e of entries) {
      if (expired(e) || (isQueued(e) && e.attempts >= MAX_ATTEMPTS)) {
        await this.deps.deleteBlob(e.id);
        if (isQueued(e)) dropped.push(e);
      } else {
        kept.push(e);
      }
    }
    // Keep only the newest failed records.
    const failed = kept.filter((e) => e.failed);
    const tooMany = new Set(failed.slice(0, Math.max(0, failed.length - MAX_FAILED)));
    for (const e of tooMany) await this.deps.deleteBlob(e.id);
    if (dropped.length) {
      const titles = dropped.map((e) => `“${e.title}”`).join(', ');
      state.notice =
        `Dropped ${dropped.length} export${dropped.length === 1 ? '' : 's'} that could not be delivered ` +
        `within 7 days / ${MAX_ATTEMPTS} attempts: ${titles}${dropped.at(-1)?.lastError ? ` (last error: ${dropped.at(-1)!.lastError})` : ''}`;
    }
    return kept.length !== entries.length || tooMany.size ? kept.filter((e) => !tooMany.has(e)) : entries;
  }

  /**
   * Deliver queued entries oldest-first. Devdy down / no instance / token
   * problems stop the round (every entry would fail the same way); a server
   * error only concerns that entry, so the next ones are still tried.
   */
  private async deliverAll(auto: boolean): Promise<Map<string, SendOutcome>> {
    const results = new Map<string, SendOutcome>();
    const state = await this.deps.loadState();
    const loaded = await this.deps.loadEntries();
    let list = await this.prune(loaded, state);
    if (list !== loaded) await this.deps.saveEntries(list);

    const queued = list.filter(isQueued);
    if (queued.length === 0 || (auto && state.paused)) {
      await this.finish(state, queued.length, false, auto);
      return results;
    }

    const settings = await this.deps.loadSettings();
    let stopWith: SendOutcome | null = null;
    let port: number | undefined;

    // Reachability first: with Devdy down, a missing token is not the problem yet.
    const found = await this.deps.resolveDevdy(settings);
    if (found.kind === 'none') {
      stopWith = { kind: 'unreachable', message: 'Devdy is not running.' };
    } else if (found.kind === 'ambiguous') {
      const ports = found.instances.map((i) => i.port).join(', ');
      stopWith = { kind: 'choose_instance', message: `Several Devdy apps are running (ports ${ports}).` };
    } else {
      port = found.instance.port;
      if (port !== settings.port) await this.deps.savePort(port);
      if (!settings.token) stopWith = NO_TOKEN;
    }

    const update = (id: string, fn: (e: OutboxEntry) => OutboxEntry | null) => {
      list = list.flatMap((e) => {
        if (e.id !== id) return [e];
        const next = fn(e);
        return next ? [next] : [];
      });
    };

    let sentAny = false;
    for (const entry of queued) {
      if (stopWith) {
        results.set(entry.id, stopWith);
        update(entry.id, (e) => ({ ...e, lastError: errorText(stopWith!) }));
        continue;
      }
      const blob = await this.deps.getBlob(entry.id);
      if (!blob) {
        // Lost payload (e.g. storage cleared): nothing to resend.
        results.set(entry.id, { kind: 'rejected', status: 0, message: 'The queued export data is missing.' });
        update(entry.id, () => null);
        await this.deps.saveEntries(list);
        continue;
      }
      const outcome = await this.deps.postCapture(port!, settings.token!, {
        kind: entry.kind ?? 'slack-threads',
        body: blob,
        contentType: entry.contentType,
        idempotencyKey: entry.id,
      });
      results.set(entry.id, outcome);
      if (isSent(outcome)) {
        sentAny = true;
        // Persist right away: a service worker killed mid-loop must not resend it.
        update(entry.id, () => null);
        await this.deps.saveEntries(list);
        await this.deps.deleteBlob(entry.id);
      } else if (isRetryable(outcome)) {
        // A token problem says nothing about the payload: it doesn't count as an attempt.
        const counts = outcome.kind !== 'unauthorized';
        update(entry.id, (e) => ({
          ...e,
          attempts: counts ? e.attempts + 1 : e.attempts,
          lastError: errorText(outcome),
        }));
        if (outcome.kind !== 'server_error') stopWith = outcome; // Devdy gone / bad token: stop here
      } else {
        const message = describeOutcome(outcome);
        const status = outcome.kind === 'rejected' ? outcome.status : 0;
        update(entry.id, (e) => ({
          ...e,
          lastError: message,
          failed: { status, message, at: this.now().toISOString() },
        }));
        await this.deps.saveEntries(list);
      }
    }

    // Entries enqueued concurrently can't exist (exclusive), so this is the full list.
    await this.deps.saveEntries(list);
    if (stopWith?.kind === 'unauthorized' || stopWith?.kind === 'no_token') state.paused = true;
    else if (sentAny) state.paused = false;
    await this.finish(state, list.filter(isQueued).length, sentAny, auto);
    return results;
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
