// Pure helpers of full-page translation: which texts to send, how to batch
// them, a text → translation cache and a request rate limiter.

/** Text that doesn't need translation: numbers, URLs, no letters at all. */
export function needsTranslation(text: string): boolean {
  if (/^\d[\d\s.,:%/\-+()]*$/.test(text)) return false; // numbers only
  if (/^https?:\/\/\S+$/.test(text)) return false; // URLs
  if (/^[^a-zA-ZÀ-ɏЀ-ӿ؀-ۿऀ-ॿ฀-๿぀-ヿ一-鿿가-힯]+$/.test(text)) return false; // no letters at all
  return true;
}

/** Group texts into batches of at most `maxChars` characters and `maxItems` items. */
export function createTextBatches(texts: string[], maxChars = 3000, maxItems = 60): string[][] {
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
