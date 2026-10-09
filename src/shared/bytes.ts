// Byte sizes: formatting and a shared download budget.

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Shared byte budget for parallel downloads. Each download reserves its
 * maximum size *before* fetching, so concurrent fetches can never overshoot
 * the total; `settle()` returns the unused part once the real size is known.
 * When the budget is short, `reserve()` waits for in-flight downloads to
 * settle before giving up or granting a smaller amount.
 */
export class ByteBudget {
  private used = 0;
  private reserved = 0;
  private inFlight = 0;
  private waiters: (() => void)[] = [];

  constructor(readonly total: number) {}

  get remaining(): number {
    return Math.max(0, this.total - this.used - this.reserved);
  }

  /**
   * Reserve up to `want` bytes. `exact`: the file needs all of it (known size)
   * → null when it can't fit; otherwise grant what is left (> 0) or null.
   */
  async reserve(want: number, exact: boolean): Promise<number | null> {
    while (this.remaining < want && this.inFlight > 0) {
      await new Promise<void>((r) => this.waiters.push(r));
    }
    const grant = Math.min(want, this.remaining);
    if (grant <= 0 || (exact && grant < want)) return null;
    this.reserved += grant;
    this.inFlight++;
    return grant;
  }

  /** Release a reservation, keeping `actual` bytes (0 when the download failed). */
  settle(reserved: number, actual: number): void {
    this.reserved -= reserved;
    this.used += Math.min(actual, reserved);
    this.inFlight--;
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }
}
