import { afterEach, describe, expect, it, vi } from 'vitest';
import { keepAliveSleep } from '../src/background/keepalive';
import { makeDoneResponse } from '../src/background/respond';
import manifest from '../public/manifest.json';

describe('keepAliveSleep (finding #3)', () => {
  afterEach(() => vi.useRealTimers());

  it('splits long waits into <=20s chunks and pings the extension API after each', async () => {
    vi.useFakeTimers();
    const pings: number[] = [];
    const ticks: number[] = [];
    const start = Date.now(); // mocked by fake timers
    const p = keepAliveSleep(
      55_000,
      () => void pings.push(Date.now() - start),
      20_000,
      (left) => ticks.push(left),
    );
    await vi.advanceTimersByTimeAsync(55_000);
    await p;
    expect(pings).toEqual([20_000, 40_000, 55_000]);
    // Every gap between pings is below the 30s MV3 idle timeout.
    expect(ticks).toEqual([35_000, 15_000]);
  });

  it('keeps chunking a maximal 10-minute Retry-After wait (re-review #2)', async () => {
    vi.useFakeTimers();
    const start = Date.now();
    const pings: number[] = [];
    const p = keepAliveSleep(600_000, () => void pings.push(Date.now() - start));
    await vi.advanceTimersByTimeAsync(600_000);
    await p;
    expect(pings).toHaveLength(30);
    const gaps = pings.map((t, i) => t - (pings[i - 1] ?? 0));
    expect(Math.max(...gaps)).toBeLessThanOrEqual(20_000);
  });

  it('returns immediately for non-positive waits', async () => {
    const ping = vi.fn();
    await keepAliveSleep(0, ping);
    expect(ping).not.toHaveBeenCalled();
  });
});

describe('makeDoneResponse (finding #4)', () => {
  const result = { markdown: '# big doc', filename: 'a.md', messageCount: 3 };

  it('does not send the Markdown back for downloads', () => {
    const msg = makeDoneResponse('download', result);
    expect(msg).toEqual({ type: 'done', action: 'download', filename: 'a.md', messageCount: 3, warning: undefined });
    expect(JSON.stringify(msg)).not.toContain('big doc');
  });

  it('includes the Markdown for copy, plus any warning', () => {
    expect(makeDoneResponse('copy', result, 'partial')).toEqual({
      type: 'done',
      action: 'copy',
      markdown: '# big doc',
      filename: 'a.md',
      messageCount: 3,
      warning: 'partial',
    });
  });
});

describe('manifest (finding #7)', () => {
  // Context Kit: <all_urls> is needed by the translator content script and
  // Web → Markdown; Slack export still only targets app.slack.com tabs.
  it('requests exactly the permissions the three tools need', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.host_permissions).toEqual(['<all_urls>']);
    expect([...manifest.permissions].sort()).toEqual([
      'activeTab',
      'clipboardWrite',
      'declarativeNetRequest',
      'downloads',
      'offscreen',
      'scripting',
      'storage',
    ]);
    expect(manifest.background).toEqual({ service_worker: 'background.js', type: 'module' });
  });
});
