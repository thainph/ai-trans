// Outbox for Devdy exports: every export is stored first, then delivered.
// If Devdy is not running (or the token is wrong / Devdy errors), the entry
// stays queued and is retried later; permanent rejections (400/413…) are
// dropped. Dependencies are injected so the logic is unit-testable.

import {
  type CaptureKind,
  type CapturePayload,
  describeOutcome,
  isRetryable,
  type ResolveResult,
  type SendOutcome,
} from './devdy-client';

export interface OutboxEntry {
  id: string;
  /** Endpoint; entries queued before web pages existed have none → slack-threads. */
  kind?: CaptureKind;
  title: string;
  contentType: string;
  createdAt: string;
  attempts: number;
  lastError?: string;
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
  loadSettings(): Promise<DevdySettings>;
  savePort(port: number): Promise<void>;
  putBlob(id: string, blob: Blob): Promise<void>;
  getBlob(id: string): Promise<Blob | undefined>;
  deleteBlob(id: string): Promise<void>;
  resolveDevdy(settings: DevdySettings): Promise<ResolveResult>;
  postCapture(port: number, token: string, payload: CapturePayload): Promise<SendOutcome>;
  /** Turn the periodic retry alarm on/off. */
  setRetryAlarm(on: boolean): Promise<void>;
  now?(): Date;
}

export interface DeliveryResult {
  outcome: SendOutcome;
  message: string;
  /** Entries still waiting after this call. */
  pending: number;
}

const errorText = (o: SendOutcome): string => ('message' in o ? o.message : '');

const NO_TOKEN: SendOutcome = {
  kind: 'no_token',
  message: 'No Devdy token set. Paste it from Devdy → Settings → Inbox API.',
};

export class DevdyOutbox {
  /** Serializes every read-modify-write of the entry list and every delivery. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: OutboxDeps) {}

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => {});
    return next;
  }

  /** Store a new export, then try to deliver it (and anything queued before it). */
  enqueue(
    entry: Omit<OutboxEntry, 'createdAt' | 'attempts'>,
    blob: Blob | null,
  ): Promise<DeliveryResult> {
    return this.exclusive(async () => {
      if (blob) await this.deps.putBlob(entry.id, blob);
      const entries = await this.deps.loadEntries();
      entries.push({ ...entry, createdAt: (this.deps.now?.() ?? new Date()).toISOString(), attempts: 0 });
      await this.deps.saveEntries(entries);
      const results = await this.deliverAll();
      const outcome = results.get(entry.id) ?? { kind: 'unreachable' as const, message: 'Not sent yet.' };
      return { outcome, message: describeOutcome(outcome), pending: (await this.deps.loadEntries()).length };
    });
  }

  /** Retry everything queued (alarm / startup / "Retry now"). */
  flush(): Promise<{ sent: number; pending: number; lastOutcome?: SendOutcome }> {
    return this.exclusive(async () => {
      const results = await this.deliverAll();
      const sent = [...results.values()].filter((o) => o.kind === 'created' || o.kind === 'updated').length;
      const last = [...results.values()].at(-1);
      return { sent, pending: (await this.deps.loadEntries()).length, lastOutcome: last };
    });
  }

  pending(): Promise<OutboxEntry[]> {
    return this.exclusive(() => this.deps.loadEntries());
  }

  /** Deliver queued entries oldest-first; stop at the first retryable failure. */
  private async deliverAll(): Promise<Map<string, SendOutcome>> {
    const results = new Map<string, SendOutcome>();
    let entries = await this.deps.loadEntries();
    if (entries.length === 0) {
      await this.deps.setRetryAlarm(false);
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

    const remaining: OutboxEntry[] = [];
    for (const entry of entries) {
      if (stopWith) {
        results.set(entry.id, stopWith);
        remaining.push({ ...entry, lastError: errorText(stopWith) });
        continue;
      }
      const blob = await this.deps.getBlob(entry.id);
      if (!blob) {
        // Lost payload (e.g. storage cleared): nothing to resend.
        results.set(entry.id, { kind: 'rejected', status: 0, message: 'The queued export data is missing.' });
        continue;
      }
      const outcome = await this.deps.postCapture(port!, settings.token!, {
        kind: entry.kind ?? 'slack-threads',
        body: blob,
        contentType: entry.contentType,
      });
      results.set(entry.id, outcome);
      if (isRetryable(outcome)) {
        remaining.push({ ...entry, attempts: entry.attempts + 1, lastError: errorText(outcome) });
        stopWith = outcome; // Devdy down / bad token: no point trying the rest now
      } else {
        await this.deps.deleteBlob(entry.id);
      }
    }

    // Entries enqueued concurrently can't exist (exclusive), so this is the full list.
    entries = remaining;
    await this.deps.saveEntries(entries);
    await this.deps.setRetryAlarm(entries.length > 0);
    return results;
  }
}
