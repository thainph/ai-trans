// Devdy translation service: which Devdy to call (cached for a while, probed
// again after a connection error), token / feature checks and retries of 429.
// Dependencies are injected → unit-tested; wired in background/translate.ts.

import { type DevdyInstance, type ResolveResult, supportsTranslate } from './client';
import type { DevdySettings } from './outbox';
import { DevdyTranslateError, type TranslateInput, type TranslateOptions, type TranslateResult } from './translate';

/** A resolved Devdy is reused this long before /health is probed again. */
export const INSTANCE_TTL_MS = 30_000;
/** 429 (4 translations in flight): retries and the pause before each one. */
export const BUSY_RETRIES = 3;
export const BUSY_RETRY_DELAY_MS = 1500;

export interface DevdyTranslatorDeps {
  loadSettings(): Promise<DevdySettings>;
  resolveDevdy(settings: DevdySettings): Promise<ResolveResult>;
  /** Remember the port of the single running Devdy (like the outbox does). */
  savePort(port: number): Promise<void>;
  translateJson(port: number, token: string, input: TranslateInput, opts: TranslateOptions): Promise<TranslateResult>;
  translateStream(
    port: number,
    token: string,
    input: TranslateInput,
    opts: TranslateOptions & { onDelta?: (delta: string) => void },
  ): Promise<TranslateResult>;
  /** Abort-aware pause (resolves early / rejects when `signal` aborts). */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  now?: () => number;
}

export interface DevdyTranslateRequest extends TranslateInput {
  signal?: AbortSignal;
  /** Stream (SSE) and report each chunk; without it the JSON mode is used. */
  onDelta?: (delta: string) => void;
}

export type DevdyTranslateState =
  | 'not_running'
  | 'choose_instance'
  | 'unsupported'
  | 'no_token'
  | 'unauthorized'
  | 'ready';

/** Translation readiness, for the Translate tab. */
export interface DevdyTranslateStatus {
  state: DevdyTranslateState;
  port?: number;
  version?: string;
}

export class DevdyTranslator {
  private cached: { instance: DevdyInstance; key: string; at: number } | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: DevdyTranslatorDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Forget the resolved Devdy (next call probes /health again). */
  invalidate(): void {
    this.cached = null;
  }

  /** The Devdy to translate with, or why there is none. */
  private async instance(settings: DevdySettings, fresh: boolean): Promise<DevdyInstance> {
    const key = `${settings.pinned ? 'pin' : 'auto'}:${settings.port ?? ''}`;
    const c = this.cached;
    if (!fresh && c && c.key === key && this.now() - c.at < INSTANCE_TTL_MS) return c.instance;
    this.cached = null;
    const resolved = await this.deps.resolveDevdy(settings);
    if (resolved.kind === 'none') throw new DevdyTranslateError('unreachable');
    if (resolved.kind === 'ambiguous') throw new DevdyTranslateError('choose_instance');
    const { instance } = resolved;
    if (!settings.pinned && instance.port !== settings.port) await this.deps.savePort(instance.port).catch(() => {});
    this.cached = { instance, key, at: this.now() };
    return instance;
  }

  /**
   * Translate one text (≤ 8000 chars). A connection error probes the ports
   * again and retries once (Devdy may have restarted on another port); 429 is
   * retried up to BUSY_RETRIES times after a short pause.
   */
  async translate(req: DevdyTranslateRequest): Promise<TranslateResult> {
    const settings = await this.deps.loadSettings();
    let fresh = false;
    let busy = 0;
    for (;;) {
      if (req.signal?.aborted) throw new DevdyTranslateError('cancelled');
      const instance = await this.instance(settings, fresh);
      if (!supportsTranslate(instance.health)) {
        // Maybe Devdy was updated since it was cached: check once more.
        if (!fresh) {
          fresh = true;
          continue;
        }
        throw new DevdyTranslateError('unsupported');
      }
      if (!settings.token) throw new DevdyTranslateError('no_token');
      const input = { text: req.text, targetLang: req.targetLang };
      try {
        return req.onDelta
          ? await this.deps.translateStream(instance.port, settings.token, input, {
              signal: req.signal,
              onDelta: req.onDelta,
            })
          : await this.deps.translateJson(instance.port, settings.token, input, { signal: req.signal });
      } catch (err) {
        if (!(err instanceof DevdyTranslateError)) throw err;
        if (err.code === 'unreachable' && !fresh) {
          fresh = true;
          continue;
        }
        if (err.code === 'unreachable') this.invalidate();
        if (err.code === 'busy' && busy < BUSY_RETRIES) {
          busy++;
          await this.deps.sleep(BUSY_RETRY_DELAY_MS, req.signal);
          continue;
        }
        throw err;
      }
    }
  }

  /** Readiness for the Translate tab (always probes; checks the token with `checkToken`). */
  async status(checkToken: (port: number, token: string) => Promise<boolean | null>): Promise<DevdyTranslateStatus> {
    const settings = await this.deps.loadSettings();
    let instance: DevdyInstance;
    try {
      instance = await this.instance(settings, true);
    } catch (err) {
      const code = err instanceof DevdyTranslateError ? err.code : 'unreachable';
      return { state: code === 'choose_instance' ? 'choose_instance' : 'not_running' };
    }
    const base = { port: instance.port, version: instance.health.version };
    if (!supportsTranslate(instance.health)) return { ...base, state: 'unsupported' };
    if (!settings.token) return { ...base, state: 'no_token' };
    const valid = await checkToken(instance.port, settings.token);
    return { ...base, state: valid === false ? 'unauthorized' : 'ready' };
  }
}
