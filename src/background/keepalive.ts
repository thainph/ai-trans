// MV3 service workers are terminated after ~30s without extension API
// activity. Long waits (rate-limit backoff) are split into short chunks with
// an extension API call between them, which resets the idle timer.

export const KEEPALIVE_CHUNK_MS = 20_000;

export type Ping = () => Promise<unknown> | unknown;

export const chromePing: Ping = () => chrome.runtime.getPlatformInfo();

export async function keepAliveSleep(
  ms: number,
  ping: Ping = chromePing,
  chunkMs: number = KEEPALIVE_CHUNK_MS,
  onTick?: (remainingMs: number) => void,
): Promise<void> {
  let remaining = Math.max(0, ms);
  while (remaining > 0) {
    const step = Math.min(chunkMs, remaining);
    await new Promise<void>((r) => setTimeout(r, step));
    remaining -= step;
    await ping();
    if (remaining > 0) onTick?.(remaining);
  }
}
