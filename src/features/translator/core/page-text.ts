// Pure helpers of full-page translation: which texts to send, how to batch
// them, a text → translation cache, retry bookkeeping, the originals kept for
// revert and a request rate limiter.

import { MAX_BATCH_ITEMS, MAX_TEXT_CHARS } from '../shared/messages';

/** Longest text node sent for translation; longer ones are left as they are. */
export const MAX_ITEM_CHARS = 4000;
/** Default batch bounds: always within the service worker's request limits. */
export const BATCH_CHARS = 3000;
export const BATCH_ITEMS = 60;

/** Can this (trimmed) text be sent? One item must never exceed a request's limit. */
export function fitsInRequest(text: string): boolean {
  return text.length <= Math.min(MAX_ITEM_CHARS, MAX_TEXT_CHARS);
}

/** Text that doesn't need translation: numbers, URLs, no letters at all. */
export function needsTranslation(text: string): boolean {
  if (/^\d[\d\s.,:%/\-+()]*$/.test(text)) return false; // numbers only
  if (/^https?:\/\/\S+$/.test(text)) return false; // URLs
  if (/^[^a-zA-ZÀ-ɏЀ-ӿ؀-ۿऀ-ॿ฀-๿぀-ヿ一-鿿가-힯]+$/.test(text)) return false; // no letters at all
  return true;
}

/**
 * Group texts into batches of at most `maxChars` characters and `maxItems`
 * items (a single longer text gets a batch of its own).
 */
export function createTextBatches(
  texts: string[],
  maxChars = BATCH_CHARS,
  maxItems = Math.min(BATCH_ITEMS, MAX_BATCH_ITEMS),
): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let currentLen = 0;
  for (const text of texts) {
    if (current.length > 0 && (currentLen + text.length > maxChars || current.length >= maxItems)) {
      batches.push(current);
      current = [];
      currentLen = 0;
    }
    current.push(text);
    currentLen += text.length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** Replace the trimmed content of `original` by `translated`, keeping its outer whitespace. */
export function withOuterWhitespace(original: string, translated: string): string {
  const lead = original.match(/^\s*/)![0];
  const trail = original.slice(lead.length).match(/\s*$/)![0];
  return lead + translated + trail;
}

/**
 * Source text → translation, for one language pair/style at a time (switching
 * scope clears it). Identical strings on a page are translated once.
 */
export class TranslationCache {
  private scope = '';
  private readonly map = new Map<string, string>();

  constructor(private readonly maxEntries = 5000) {}

  /** Select the scope (e.g. `source|target|style`); a new scope starts empty. */
  use(scope: string): void {
    if (scope === this.scope) return;
    this.scope = scope;
    this.map.clear();
  }

  get(text: string): string | undefined {
    return this.map.get(text);
  }

  set(text: string, translation: string): void {
    if (!this.map.has(text) && this.map.size >= this.maxEntries) {
      // Evict the oldest entry (Map keeps insertion order).
      this.map.delete(this.map.keys().next().value!);
    }
    this.map.set(text, translation);
  }

  /** Texts not cached yet, without duplicates, in first-seen order. */
  missing(texts: Iterable<string>): string[] {
    const out = new Set<string>();
    for (const t of texts) if (!this.map.has(t)) out.add(t);
    return [...out];
  }
}

/**
 * Retries of texts the model gave no usable translation for: each text is
 * retried at most `maxRetries` times, then left untranslated.
 */
export class RetryBudget {
  private readonly failures = new Map<string, number>();

  constructor(private readonly maxRetries = 2) {}

  /** Record a failure; true when the text may be retried. */
  fail(text: string): boolean {
    const n = (this.failures.get(text) ?? 0) + 1;
    this.failures.set(text, n);
    return n <= this.maxRetries;
  }

  /** Out of retries: don't send it again. */
  exhausted(text: string): boolean {
    return (this.failures.get(text) ?? 0) > this.maxRetries;
  }

  clear(): void {
    this.failures.clear();
  }
}

/**
 * Originals of translated nodes, for revert. Nodes are held weakly: nodes an
 * SPA drops can be garbage-collected, while detached nodes it keeps (and may
 * re-attach later) are still restored on revert. `prune()` forgets collected ones.
 */
export class WeakOriginals<T extends object> {
  private readonly originals = new WeakMap<T, string>();
  private refs = new Set<WeakRef<T>>();

  get size(): number {
    return this.refs.size;
  }

  has(node: T): boolean {
    return this.originals.has(node);
  }

  set(node: T, original: string): void {
    if (this.originals.has(node)) return;
    this.originals.set(node, original);
    this.refs.add(new WeakRef(node));
  }

  /** Drop entries whose node was garbage-collected. */
  prune(): void {
    for (const ref of this.refs) if (!ref.deref()) this.refs.delete(ref);
  }

  /** Call `restore` for every live node with its original, then forget everything. */
  restoreAll(restore: (node: T, original: string) => void): void {
    for (const ref of this.refs) {
      const node = ref.deref();
      if (node) restore(node, this.originals.get(node)!);
    }
    this.clear();
  }

  clear(): void {
    for (const ref of this.refs) {
      const node = ref.deref();
      if (node) this.originals.delete(node);
    }
    this.refs = new Set();
  }
}

/** Sliding-window limiter: at most `max` acquisitions per `windowMs`. */
export class RateLimiter {
  private readonly stamps: number[] = [];

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  tryAcquire(): boolean {
    this.prune();
    if (this.stamps.length >= this.max) return false;
    this.stamps.push(this.now());
    return true;
  }

  /** Milliseconds until the next acquisition can succeed (0 = now). */
  waitMs(): number {
    this.prune();
    if (this.stamps.length < this.max) return 0;
    return this.stamps[0]! + this.windowMs - this.now();
  }

  private prune(): void {
    const cutoff = this.now() - this.windowMs;
    while (this.stamps.length > 0 && this.stamps[0]! <= cutoff) this.stamps.shift();
  }
}
