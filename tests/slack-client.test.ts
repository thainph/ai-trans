import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type PageCallResult,
  type PageRequest,
  type PageResponse,
  SlackExportError,
  MAX_RETRY_AFTER_MS,
  backoffMs,
  formatWait,
  collectReferences,
  describeSlackError,
  fetchThread,
  pageSlackApi,
} from '../src/core/slack-client';
import type { SlackMessage, SlackRepliesResponse } from '../src/types/slack';
import fixture from './fixtures/replies.json';

const replies = fixture as unknown as SlackRepliesResponse;
const TEAM = { id: 'T01', name: 'Papay', domain: 'papay', url: 'https://papay.slack.com/' };
const LINK = { workspaceDomain: 'papay', channelId: 'C0DEPLOY', threadTs: '1700000000.123456' };

type Handler = (req: PageRequest) => PageCallResult;

function fakeRunner(handler: Handler) {
  const requests: PageRequest[] = [];
  const run = vi.fn(async (req: PageRequest): Promise<PageResponse> => {
    requests.push(req);
    return { ok: true, team: TEAM, result: handler(req) };
  });
  return { run, requests };
}

const ok = (data: Record<string, unknown>): PageCallResult => ({ ok: true, data: { ok: true, ...data } });
const userInfo = (id: string, display: string): PageCallResult =>
  ok({ user: { id, name: id.toLowerCase(), profile: { display_name: display, real_name: `${display} Real` } } });
const channelInfo = (id: string, name: string): PageCallResult => ok({ channel: { id, name } });
const repliesPage = (messages: SlackMessage[], next_cursor = '', has_more = !!next_cursor): PageCallResult =>
  ok({ messages, has_more, response_metadata: { next_cursor } });
const noSleep = async () => {};

/** Generic handler: replies come from `pages` (keyed by cursor), lookups always succeed. */
function threadHandler(pages: Record<string, PageCallResult>): Handler {
  return (req) => {
    if (req.method === 'conversations.replies') return pages[req.params.cursor ?? ''] ?? { ok: false, error: 'bad_cursor' };
    if (req.method === 'conversations.info') return channelInfo(req.params.channel!, 'chan');
    if (req.method === 'users.info') return userInfo(req.params.user!, 'User');
    return { ok: false, error: 'unknown_method' };
  };
}

const msg = (ts: string): SlackMessage => ({ ts, thread_ts: '1700000000.000001', user: 'U1', text: ts });

describe('collectReferences', () => {
  it('collects authors and mentions from blocks, text and attachments', () => {
    const refs = collectReferences(replies.messages ?? []);
    expect([...refs.users].sort()).toEqual(['U01ALICE', 'U02BOB', 'U03CAROL', 'U05BOTUSER']);
    expect([...refs.channels]).toEqual(['C0GENERAL']);
  });
});

describe('fetchThread', () => {
  it('paginates, dedupes, resolves names and builds thread data', async () => {
    const all = replies.messages ?? [];
    const names: Record<string, string> = { U01ALICE: 'Alice', U02BOB: 'Bob', U05BOTUSER: 'Release App' };
    const { run, requests } = fakeRunner((req) => {
      if (req.method === 'conversations.replies') {
        // Slack may repeat the parent on later pages.
        return req.params.cursor ? repliesPage([all[0]!, ...all.slice(3)]) : repliesPage(all.slice(0, 3), 'CUR2');
      }
      if (req.method === 'conversations.info') {
        const id = req.params.channel!;
        return channelInfo(id, id === 'C0DEPLOY' ? 'dev-deploy' : 'general');
      }
      if (req.method === 'users.info') {
        const id = req.params.user!;
        if (id === 'U03CAROL') return { ok: false, error: 'user_not_found', data: { ok: false, error: 'user_not_found' } };
        return userInfo(id, names[id] ?? id);
      }
      return { ok: false, error: 'unknown_method' };
    });

    const progress: string[] = [];
    const { data, warning } = await fetchThread(run, LINK, { onProgress: (t) => progress.push(t) });

    expect(warning).toBeUndefined();
    expect(data.truncated).toBe(false);
    expect(data.messages.map((m) => m.ts)).toEqual(all.map((m) => m.ts));
    expect(data.channel).toEqual({ id: 'C0DEPLOY', name: 'dev-deploy', isIm: false, imUserId: undefined });
    expect(data.channels).toEqual({ C0GENERAL: 'general' });
    expect(data.users).toMatchObject({ U01ALICE: 'Alice', U02BOB: 'Bob', U05BOTUSER: 'Release App' });
    expect(data.users.U03CAROL).toBeUndefined();
    expect(data.workspace).toEqual({ name: 'Papay', domain: 'papay' });
    expect(data.threadUrl).toBe('https://papay.slack.com/archives/C0DEPLOY/p1700000000123456');

    // One API call per page request (finding #3).
    expect(requests.every((r) => typeof r.method === 'string' && !('calls' in r))).toBe(true);
    expect(requests[0]!.domain).toBe('papay');
    expect(requests[1]!.params.cursor).toBe('CUR2');
    expect(progress).toContain('Fetching… 3 messages');
    expect(progress).toContain('Fetching… 5 messages');
  });

  it('restarts from the parent when the link points at a reply', async () => {
    const parent: SlackMessage = { ts: '1700000000.000001', thread_ts: '1700000000.000001', user: 'U1', text: 'parent' };
    const reply: SlackMessage = { ts: '1700000050.000002', thread_ts: '1700000000.000001', user: 'U1', text: 'reply' };
    const { run, requests } = fakeRunner((req) => {
      if (req.method === 'conversations.replies') {
        return req.params.ts === reply.ts ? repliesPage([reply]) : repliesPage([parent, reply]);
      }
      if (req.method === 'users.info') return userInfo('U1', 'One');
      return channelInfo('C1', 'c');
    });
    const { data } = await fetchThread(run, { channelId: 'C1', threadTs: reply.ts });
    expect(requests[1]!.params.ts).toBe(parent.ts);
    expect(data.messages).toHaveLength(2);
    expect(data.threadUrl).toBe('https://papay.slack.com/archives/C1/p1700000000000001');
  });

  describe('pagination (findings #2, #8)', () => {
    it('follows next_cursor even when has_more is false', async () => {
      const { run } = fakeRunner(
        threadHandler({ '': repliesPage([msg('1700000000.000001')], 'C2', false), C2: repliesPage([msg('1700000001.000001')]) }),
      );
      const { data, warning } = await fetchThread(run, { channelId: 'C1', threadTs: '1700000000.000001' });
      expect(data.messages).toHaveLength(2);
      expect(warning).toBeUndefined();
    });

    it('has no small hard cap: pages beyond the old 100-page limit are fetched', async () => {
      const pages: Record<string, PageCallResult> = {};
      const N = 150;
      for (let i = 0; i < N; i++) {
        pages[i === 0 ? '' : `c${i}`] = repliesPage([msg(`${1700000000 + i}.000001`)], i < N - 1 ? `c${i + 1}` : '');
      }
      const { run } = fakeRunner(threadHandler(pages));
      const { data, warning } = await fetchThread(run, { channelId: 'C1', threadTs: '1700000000.000001' });
      expect(data.messages).toHaveLength(N);
      expect(warning).toBeUndefined();
    });

    it('flags truncation with a warning when the safety cap is reached', async () => {
      const { run } = fakeRunner(
        threadHandler({
          '': repliesPage([msg('1700000000.000001')], 'c1'),
          c1: repliesPage([msg('1700000001.000001')], 'c2'),
          c2: repliesPage([msg('1700000002.000001')]),
        }),
      );
      const { data, warning } = await fetchThread(run, { channelId: 'C1', threadTs: '1700000000.000001' }, { maxPages: 2 });
      expect(data.messages).toHaveLength(2);
      expect(data.truncated).toBe(true);
      expect(warning).toMatch(/Stopped after 2 pages \(2 messages\).*incomplete/);
    });

    it('warns when has_more is true but no cursor is returned', async () => {
      const { run } = fakeRunner(threadHandler({ '': repliesPage([msg('1700000000.000001')], '', true) }));
      const { data, warning } = await fetchThread(run, { channelId: 'C1', threadTs: '1700000000.000001' });
      expect(data.truncated).toBe(true);
      expect(warning).toMatch(/no cursor/);
    });

    it('stops (with a warning) on a repeated cursor instead of looping forever', async () => {
      const { run, requests } = fakeRunner(
        threadHandler({ '': repliesPage([msg('1700000000.000001')], 'same'), same: repliesPage([msg('1700000001.000001')], 'same') }),
      );
      const { warning } = await fetchThread(run, { channelId: 'C1', threadTs: '1700000000.000001' });
      expect(requests.filter((r) => r.method === 'conversations.replies')).toHaveLength(2);
      expect(warning).toMatch(/repeated page cursor/);
    });
  });

  describe('rate limiting in the extension', () => {
    /** Fake clock: sleep() advances time; overlapping sleeps behave like real timers. */
    function fakeClock() {
      let t = 0;
      const waits: number[] = [];
      return {
        waits,
        now: () => t,
        sleep: async (ms: number) => {
          waits.push(ms);
          const end = t + ms;
          await Promise.resolve();
          t = Math.max(t, end);
        },
      };
    }
    const LINK1 = { channelId: 'C1', threadTs: '1700000000.000001' };

    it('retries ratelimited calls, honoring Retry-After then jittered exponential backoff', async () => {
      let replyCalls = 0;
      const base = threadHandler({ '': repliesPage([msg('1700000000.000001')]) });
      const { run } = fakeRunner((req) => {
        if (req.method === 'conversations.replies' && replyCalls++ < 2) {
          return replyCalls === 1 ? { ok: false, error: 'ratelimited', httpStatus: 429, retryAfterSec: 7 } : { ok: false, error: 'ratelimited' };
        }
        return base(req);
      });
      const clock = fakeClock();
      const progress: string[] = [];
      const { data } = await fetchThread(run, LINK1, { ...clock, random: () => 0, onProgress: (t) => progress.push(t) });
      expect(data.messages).toHaveLength(1);
      expect(clock.waits).toEqual([7000, 1000]); // Retry-After (+0 jitter), then 2s step * 50% (random=0)
      expect(progress).toContain('Rate limited by Slack — retrying in 7s…');
    });

    it('gives up after maxRetries with a readable error', async () => {
      const { run } = fakeRunner(() => ({ ok: false, error: 'ratelimited' }));
      const clock = fakeClock();
      await expect(fetchThread(run, { channelId: 'C1', threadTs: '1' }, { ...clock, maxRetries: 3 })).rejects.toMatchObject({
        code: 'ratelimited',
        message: expect.stringContaining('rate limiting'),
      });
      expect(clock.waits).toHaveLength(3);
    });

    describe('backoffMs (re-review #2, #3)', () => {
      it('honors a valid Retry-After fully, beyond the 60s exponential cap', () => {
        expect(backoffMs(0, 120, () => 0)).toBe(120_000);
        expect(backoffMs(4, 600, () => 0)).toBe(MAX_RETRY_AFTER_MS);
        expect(backoffMs(0, 90, () => 0.999)).toBe(90_499); // only adds jitter, never shortens
      });

      it('fails with a readable error when Retry-After exceeds 10 minutes', () => {
        expect(() => backoffMs(0, 601)).toThrow(SlackExportError);
        expect(() => backoffMs(0, 3600)).toThrow(/asked to wait 60 minutes/);
      });

      it('caps exponential backoff at 60s only when Retry-After is missing or invalid', () => {
        for (const ra of [undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
          expect(backoffMs(0, ra, () => 1)).toBe(1000);
          expect(backoffMs(3, ra, () => 1)).toBe(8000);
          expect(backoffMs(10, ra, () => 1)).toBe(60_000);
        }
      });

      it('adds jitter (50%-100% of the step) to exponential backoff', () => {
        expect(backoffMs(3, undefined, () => 0)).toBe(4000);
        expect(backoffMs(3, undefined, () => 0.5)).toBe(6000);
        const samples = new Set(Array.from({ length: 50 }, () => backoffMs(5)));
        expect(samples.size).toBeGreaterThan(1);
        for (const s of samples) expect(s >= 16_000 && s <= 32_000).toBe(true);
      });

      it('formats long waits in minutes', () => {
        expect(formatWait(7000)).toBe('7s');
        expect(formatWait(600_000)).toBe('10m 0s');
      });
    });

    it('surfaces an over-long Retry-After from fetchThread as a readable error', async () => {
      const { run } = fakeRunner(() => ({ ok: false, error: 'ratelimited', httpStatus: 429, retryAfterSec: 1800 }));
      const clock = fakeClock();
      await expect(fetchThread(run, LINK1, clock)).rejects.toMatchObject({
        code: 'ratelimited',
        message: expect.stringContaining('asked to wait 30 minutes'),
      });
      expect(clock.waits).toEqual([]);
    });

    it('a 429 on one lookup pauses the whole users.info pool (shared gate)', async () => {
      const users = Array.from({ length: 8 }, (_, i) => `U${i}`);
      const messages = users.map((u, i) => ({ ts: `${1700000000 + i}.000001`, user: u, text: 'x' }));
      const clock = fakeClock();
      const calls: { method: string; user?: string; at: number }[] = [];
      let limited = false;
      const { run } = fakeRunner((req) => {
        calls.push({ method: req.method, user: req.params.user, at: clock.now() });
        if (req.method === 'conversations.replies') return repliesPage(messages);
        if (req.method === 'users.info' && req.params.user === 'U2' && !limited) {
          limited = true;
          return { ok: false, error: 'ratelimited', httpStatus: 429, retryAfterSec: 30 };
        }
        if (req.method === 'users.info') return userInfo(req.params.user!, req.params.user!);
        return channelInfo(req.params.channel!, 'c');
      });
      const { data } = await fetchThread(run, LINK1, { ...clock, random: () => 0, concurrency: 4 });

      expect(Object.keys(data.users).sort()).toEqual(users);
      const limitedAt = calls.findIndex((c) => c.user === 'U2');
      // Every lookup started after the 429 waited for the shared 30s pause.
      const after = calls.slice(limitedAt + 1).filter((c) => c.method === 'users.info');
      expect(after.length).toBeGreaterThan(0);
      for (const c of after) expect(c.at).toBeGreaterThanOrEqual(30_000);
      // No caller retried before the gate opened (no lockstep re-hits at t < 30s).
      expect(calls.filter((c) => c.user === 'U2')).toHaveLength(2);
    });
  });

  it('maps Slack API errors to readable messages', async () => {
    const { run } = fakeRunner(() => ({ ok: false, error: 'channel_not_found', data: { ok: false, error: 'channel_not_found' } }));
    await expect(fetchThread(run, { channelId: 'C1', threadTs: '1700000000.000001' }, { sleep: noSleep })).rejects.toMatchObject({
      name: 'SlackExportError',
      code: 'channel_not_found',
      message: expect.stringContaining('Channel not found'),
    });
  });

  it('maps page-level errors (not logged in)', async () => {
    const run = async (): Promise<PageResponse> => ({ ok: false, error: 'no_local_config' });
    const err = await fetchThread(run, { channelId: 'C1', threadTs: '1700000000.000001' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SlackExportError);
    expect((err as Error).message).toContain('Please open app.slack.com and log in');
  });

  it('describes unknown and team errors', () => {
    expect(describeSlackError('weird_thing')).toBe('Slack API error: weird_thing');
    expect(describeSlackError('team_not_found', 'a, b')).toContain('Logged-in workspaces: a, b');
    expect(describeSlackError('invalid_auth')).toContain('log in again');
  });
});

describe('pageSlackApi (page context)', () => {
  const store: Record<string, string> = {};
  let fetchMock: ReturnType<typeof vi.fn>;

  const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

  const setTeams = (teams: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    store.localConfig_v2 = JSON.stringify({ teams, ...extra });
  };

  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    setTeams(
      {
        T01: { id: 'T01', name: 'Papay', domain: 'papay', url: 'https://papay.slack.com/', token: 'xoxc-secret-1' },
        T02: { id: 'T02', name: 'Other', domain: 'other', url: 'https://other.slack.com/', token: 'xoxc-secret-2' },
      },
      { lastActiveTeamId: 'T02' },
    );
    vi.stubGlobal('window', { localStorage: { getItem: (k: string) => store[k] ?? null } });
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const call = (extra: Partial<PageRequest> = {}) => pageSlackApi({ method: 'auth.test', params: {}, ...extra });
  const fetchedUrls = () => fetchMock.mock.calls.map((c) => String(c[0]));

  it('selects the team by domain, posts FormData with the token, and never returns the token', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, channel: { id: 'C1', name: 'x' } }));
    const res = await call({ method: 'conversations.info', params: { channel: 'C1' }, domain: 'papay' });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.team).toEqual({ id: 'T01', name: 'Papay', domain: 'papay', url: 'https://papay.slack.com/', guessed: false });
    expect(res.result).toMatchObject({ ok: true, data: { channel: { name: 'x' } } });
    expect(JSON.stringify(res)).not.toContain('xoxc');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://papay.slack.com/api/conversations.info');
    expect(init.credentials).toBe('include');
    const body = init.body as FormData;
    expect(body.get('token')).toBe('xoxc-secret-1');
    expect(body.get('channel')).toBe('C1');
  });

  it('is self-contained: works after toString() serialization like chrome.scripting does', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    const revived = new Function(`return (${pageSlackApi.toString()});`)() as typeof pageSlackApi;
    const res = await revived({ domain: 'papay', method: 'auth.test', params: {} });
    expect(res.ok && res.result.ok).toBe(true);
  });

  it('selects the team by team id', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    const res = await call({ teamId: 'T02' });
    expect(res.ok && res.team.id).toBe('T02');
  });

  it('falls back to lastActiveTeamId (flagged as guessed) when nothing matches', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    const res = await call({ domain: 'acme.enterprise' });
    expect(res.ok && res.team).toMatchObject({ id: 'T02', guessed: true });
  });

  it('reports a missing session', async () => {
    delete store.localConfig_v2;
    expect(await call()).toEqual({ ok: false, error: 'no_local_config' });
    setTeams({});
    expect(await call()).toEqual({ ok: false, error: 'no_teams' });
  });

  describe('token destination validation (findings #1, #6)', () => {
    const allowedOrigin = (u: string) => {
      const h = new URL(u).hostname;
      return new URL(u).protocol === 'https:' && (h === 'app.slack.com' || h.endsWith('.slack.com'));
    };

    it.each([
      ['look-alike host', 'https://evil.slack.com.attacker.tld/', 'evil.attacker.tld/'],
      ['http scheme', 'http://papay.slack.com/', 'x/../../evil'],
      ['userinfo trick', 'https://papay.slack.com@attacker.tld/', 'attacker.tld#'],
      ['custom port', 'https://papay.slack.com:8443/', 'a.b:8443'],
      ['non-slack host', 'https://attacker.tld/', ''],
      ['garbage', 'not a url', 'evil.com/'],
    ])('never sends the token outside *.slack.com (%s)', async (_label, url, domain) => {
      setTeams({ T9: { id: 'T9', name: 'X', domain, url, token: 'xoxc-secret-9' } });
      fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
      const res = await call();
      expect(res.ok).toBe(true);
      expect(fetchedUrls().length).toBeGreaterThan(0);
      for (const u of fetchedUrls()) expect(allowedOrigin(u)).toBe(true);
      expect(fetchedUrls()[0]).toBe('https://app.slack.com/api/auth.test');
      expect(res.ok && res.team.url).toBeUndefined();
    });

    it('uses only the origin of team.url (path, query and hash dropped)', async () => {
      setTeams({ T1: { id: 'T1', domain: 'papay', url: 'https://app.slack.com/client/T1?x=1#y', token: 'xoxc-1' } });
      fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
      const res = await call();
      expect(fetchedUrls()[0]).toBe('https://app.slack.com/api/auth.test');
      expect(res.ok && res.team.url).toBe('https://app.slack.com/');
    });

    it('builds the base from a validated domain when url is missing or invalid', async () => {
      setTeams({ T1: { id: 'T1', domain: 'papay-dev', url: 'https://evil.tld/', token: 'xoxc-1' } });
      fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
      await call();
      expect(fetchedUrls()[0]).toBe('https://papay-dev.slack.com/api/auth.test');
    });

    it('accepts Enterprise Grid multi-label domains (re-review #1)', async () => {
      setTeams({ T1: { id: 'T1', domain: 'acme.enterprise', url: 'https://evil.tld/', token: 'xoxc-1' } });
      fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
      const res = await call({ domain: 'acme.enterprise' });
      expect(fetchedUrls()[0]).toBe('https://acme.enterprise.slack.com/api/auth.test');
      expect(res.ok && res.team.url).toBe('https://acme.enterprise.slack.com/');
    });

    it('a syntactically valid multi-label domain can only ever resolve under .slack.com', async () => {
      setTeams({ T1: { id: 'T1', domain: 'evil.attacker.tld', url: 'https://evil.tld/', token: 'xoxc-1' } });
      fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
      await call();
      expect(fetchedUrls()[0]).toBe('https://evil.attacker.tld.slack.com/api/auth.test');
      expect(new URL(fetchedUrls()[0]!).hostname.endsWith('.slack.com')).toBe(true);
    });

    it.each(['acme..enterprise', '.acme', 'acme.', 'acme.enterprise/x', 'acme.enterprise:443', 'evil.com#', 'a b', 'x@evil.com'])(
      'still rejects malformed domain %j (falls back to app.slack.com)',
      async (domain) => {
        setTeams({ T1: { id: 'T1', domain, url: 'https://evil.tld/', token: 'xoxc-1' } });
        fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
        await call();
        expect(fetchedUrls()[0]).toBe('https://app.slack.com/api/auth.test');
      },
    );

    it('url-encodes the method name', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
      await call({ domain: 'papay', method: '../../x?y' });
      expect(fetchedUrls()[0]).toBe('https://papay.slack.com/api/..%2F..%2Fx%3Fy');
    });
  });

  it('falls back to app.slack.com on network errors', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(jsonResponse({ ok: true }));
    const res = await call({ domain: 'papay' });
    expect(res.ok && res.result.ok).toBe(true);
    expect(fetchedUrls()[1]).toBe('https://app.slack.com/api/auth.test');
  });

  it('returns immediately on HTTP 429 with retryAfterSec, without sleeping (finding #3)', async () => {
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    fetchMock.mockResolvedValue(jsonResponse({ ok: false, error: 'ratelimited' }, 429, { 'Retry-After': '30' }));
    const res = await call({ domain: 'papay' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(timeoutSpy).not.toHaveBeenCalled();
    expect(res.ok && res.result).toEqual({ ok: false, error: 'ratelimited', httpStatus: 429, retryAfterSec: 30 });
    timeoutSpy.mockRestore();
  });

  it('reports ratelimited JSON errors as-is', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: false, error: 'ratelimited' }));
    const res = await call({ domain: 'papay' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.ok && res.result).toMatchObject({ ok: false, error: 'ratelimited' });
  });

  it('returns ok:false results for API errors', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: false, error: 'thread_not_found' }));
    const res = await call({ domain: 'papay' });
    expect(res.ok && res.result).toMatchObject({ ok: false, error: 'thread_not_found' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
