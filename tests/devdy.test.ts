import { describe, expect, it, vi } from 'vitest';
import {
  checkHealth,
  type DevdyHealth,
  describeOutcome,
  type FetchFn,
  findAllDevdy,
  isDevdyPort,
  isRetryable,
  listProjects,
  parseHealth,
  postSlackThread,
  resolveDevdy,
  resolveFromInstances,
  type SendOutcome,
  supportsSlackThreadLink,
  supportsTranslate,
} from '../src/features/devdy/core/client';
import { LEGACY_DB_NAME, LEGACY_OUTBOX_KEYS, migrateLegacyOutbox } from '../src/features/devdy/core/migration';
import {
  DevdyOutbox,
  MAX_ATTEMPTS,
  MAX_ENTRIES,
  OUTBOX_TTL_MS,
  type OutboxDeps,
  type OutboxState,
  type QueuedLink,
} from '../src/features/devdy/core/outbox';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Fake Devdy listening on `port` (all other ports refuse connections). */
function fakeDevdy(port: number, routes: Record<string, (init?: RequestInit) => Response>): FetchFn {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.port !== String(port)) throw new TypeError('Failed to fetch');
    const route = routes[`${init?.method ?? 'GET'} ${url.pathname}`];
    if (!route) return json(404, { error: 'not found' });
    return route(init);
  }) as FetchFn;
}

const HEALTH = { 'GET /health': () => json(200, { app: 'devdy', version: '0.8.0', api: 1 }) };

describe('devdy-client: discovery', () => {
  it('accepts only a Devdy /health answer', async () => {
    expect(await checkHealth(47821, fakeDevdy(47821, HEALTH))).toEqual({ app: 'devdy', version: '0.8.0', api: 1 });
    const other = fakeDevdy(47821, { 'GET /health': () => json(200, { app: 'something-else' }) });
    expect(await checkHealth(47821, other)).toBeNull();
    expect(await checkHealth(47822, fakeDevdy(47821, HEALTH))).toBeNull();
  });

  it('finds every running instance', async () => {
    const two = (async (input: RequestInfo | URL) => {
      const port = new URL(String(input)).port;
      if (port === '47821' || port === '47822') return json(200, { app: 'devdy', version: port });
      throw new TypeError('Failed to fetch');
    }) as FetchFn;
    expect((await findAllDevdy(two)).map((i) => i.port)).toEqual([47821, 47822]);
    expect(await findAllDevdy(fakeDevdy(1, HEALTH))).toEqual([]);
  });

  it('resolves: single instance → ok; several → ambiguous unless pinned; pinned down → none', async () => {
    const one = fakeDevdy(47825, HEALTH);
    expect(await resolveDevdy({}, one)).toMatchObject({ kind: 'ok', instance: { port: 47825 } });
    expect(await resolveDevdy({}, fakeDevdy(1, HEALTH))).toEqual({ kind: 'none' });

    const two = (async (input: RequestInfo | URL) => {
      const port = new URL(String(input)).port;
      if (port === '47821' || port === '47822') return json(200, { app: 'devdy' });
      throw new TypeError('Failed to fetch');
    }) as FetchFn;
    const amb = await resolveDevdy({ port: 47821 }, two); // remembered but not pinned
    expect(amb.kind).toBe('ambiguous');
    expect(await resolveDevdy({ port: 47822, pinned: true }, two)).toMatchObject({
      kind: 'ok',
      instance: { port: 47822 },
    });
    expect(await resolveDevdy({ port: 47823, pinned: true }, two)).toEqual({ kind: 'none' });
  });
});

describe('devdy-client: API calls', () => {
  it('lists projects with the bearer token', async () => {
    let auth = '';
    const f = fakeDevdy(47821, {
      'GET /v1/projects': (init) => {
        auth = new Headers(init?.headers).get('Authorization') ?? '';
        return json(200, [{ id: 'p1', name: 'AI Trans' }, { bogus: true }]);
      },
    });
    expect(await listProjects(47821, 'tok', f)).toEqual({ ok: true, projects: [{ id: 'p1', name: 'AI Trans' }] });
    expect(auth).toBe('Bearer tok');
    const denied = fakeDevdy(47821, { 'GET /v1/projects': () => json(401, { error: 'invalid token' }) });
    expect(await listProjects(47821, 'bad', denied)).toMatchObject({ ok: false, kind: 'unauthorized' });
  });

  it('posts only {url} as JSON with Authorization + Content-Type (no X-Devdy-*, no Idempotency-Key)', async () => {
    let seen: { method?: string; headers?: Record<string, string>; body?: unknown } = {};
    const f = fakeDevdy(47821, {
      'POST /v1/slack-threads': (init) => {
        const headers: Record<string, string> = {};
        new Headers(init?.headers).forEach((v, k) => {
          headers[k] = v;
        });
        seen = { method: init?.method, headers, body: JSON.parse(String(init?.body)) };
        return json(202, { id: 't1', status: 'created', fetchStatus: 'pending' });
      },
    });
    const out = await postSlackThread(47821, 'tok', LINK, f);
    expect(out).toEqual({ kind: 'created', id: 't1', fetchStatus: 'pending' });
    expect(seen).toEqual({
      method: 'POST',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      body: { url: LINK },
    });
  });

  it.each<[number, unknown, Partial<SendOutcome>]>([
    [202, { id: 't1', status: 'created', fetchStatus: 'pending' }, { kind: 'created', id: 't1' }],
    [
      202,
      { id: 't1', status: 'existing', fetchStatus: 'translating' },
      { kind: 'existing', fetchStatus: 'translating' },
    ],
    [
      202,
      { id: 't2', status: 'created', fetchStatus: 'error', errorCode: 'no_token' },
      { kind: 'created', errorCode: 'no_token' },
    ],
    [
      400,
      { error: 'invalid Slack thread link', code: 'invalid_link' },
      { kind: 'rejected', status: 400, code: 'invalid_link' },
    ],
    [
      400,
      { error: 'direct-message threads are not supported', code: 'dm_unsupported' },
      { kind: 'rejected', code: 'dm_unsupported' },
    ],
    [400, { error: 'unknown project id: x', code: 'invalid_project' }, { kind: 'rejected', code: 'invalid_project' }],
    [
      400,
      { error: 'title must be 1-200 characters', code: 'invalid_title' },
      { kind: 'rejected', code: 'invalid_title' },
    ],
    [400, { error: 'invalid JSON body', code: 'invalid_json' }, { kind: 'rejected', code: 'invalid_json' }],
    [401, { error: 'invalid or missing token' }, { kind: 'unauthorized' }],
    [404, { error: 'not found' }, { kind: 'outdated', status: 404 }],
    [413, { error: 'payload exceeds 16 KB' }, { kind: 'rejected', status: 413 }],
    [415, { error: 'Content-Type must be application/json' }, { kind: 'outdated', status: 415 }],
    [500, { error: 'storage error' }, { kind: 'rejected', status: 500 }],
    [503, { error: 'server stopping' }, { kind: 'unreachable', message: 'server stopping' }],
  ])('maps HTTP %i %j', async (status, body, expected) => {
    const f = fakeDevdy(47821, { 'POST /v1/slack-threads': () => json(status, body) });
    expect(await postSlackThread(47821, 't', LINK, f)).toMatchObject(expected);
  });

  it('treats a connection error as unreachable', async () => {
    expect(await postSlackThread(47821, 't', LINK, fakeDevdy(1, {}))).toMatchObject({ kind: 'unreachable' });
  });

  it('describes outcomes with the Inbox API wording', () => {
    const d = (o: SendOutcome) => describeOutcome(o);
    expect(d({ kind: 'created', id: 'x' })).toBe('Sent — Devdy is fetching and translating the thread.');
    expect(d({ kind: 'existing', id: 'x' })).toBe('Already in Devdy — refreshing.');
    expect(d({ kind: 'created', id: 'x', errorCode: 'no_token' })).toMatch(
      /^Saved, but Devdy has no Slack token: add the Slack MCP server \(SLACK_MCP_XOXP_TOKEN\) in Devdy, then Refresh/,
    );
    expect(d({ kind: 'existing', id: 'x', errorCode: 'no_token' })).toMatch(/no Slack token/);
    expect(d({ kind: 'unreachable', message: 'm' })).toBe('Devdy is not running or the Inbox API is off — queued.');
    expect(d({ kind: 'outdated', message: 'm' })).toBe('Update Devdy to send Slack threads.');
    expect(d({ kind: 'outdated', status: 415, message: 'm' })).toMatch(/version mismatch.*update Devdy/);
    expect(d({ kind: 'unauthorized', message: 'm' })).toMatch(/token/);
    expect(d({ kind: 'rejected', status: 400, code: 'invalid_link', message: 'm' })).toBe('Not a Slack thread link.');
    expect(d({ kind: 'rejected', status: 400, code: 'dm_unsupported', message: 'm' })).toMatch(/Direct messages/);
    expect(d({ kind: 'rejected', status: 400, code: 'invalid_project', message: 'm' })).toMatch(/project/);
    expect(d({ kind: 'rejected', status: 400, code: 'invalid_title', message: 'm' })).toMatch(/1–200/);
    expect(d({ kind: 'rejected', status: 500, message: 'storage error' })).toMatch(/storage error/);
  });

  it('retries only connection problems, instance choice and token problems (§9.3)', () => {
    const msg = (kind: string) => ({ kind, message: 'm' }) as SendOutcome;
    expect(['unreachable', 'choose_instance', 'token_missing', 'unauthorized'].every((k) => isRetryable(msg(k)))).toBe(
      true,
    );
    expect(isRetryable(msg('outdated'))).toBe(false);
    expect(isRetryable({ kind: 'rejected', status: 400, code: 'invalid_link', message: 'm' })).toBe(false);
    expect(isRetryable({ kind: 'rejected', status: 500, message: 'm' })).toBe(false);
    expect(isRetryable({ kind: 'created', id: 'x' })).toBe(false);
  });
});

describe('devdy-client: feature gating', () => {
  it('reads the features list and gates translate / slack-thread-link separately', () => {
    const h = parseHealth({ app: 'devdy', version: '0.8.0', api: 1, features: ['translate', 'slack-thread-link', 3] });
    expect(h).toEqual({ app: 'devdy', version: '0.8.0', api: 1, features: ['translate', 'slack-thread-link'] });
    expect(supportsSlackThreadLink(h)).toBe(true);
    expect(supportsTranslate(h)).toBe(true);
    const old: DevdyHealth = { app: 'devdy', version: '0.7.0', features: ['translate'] };
    expect(supportsSlackThreadLink(old)).toBe(false);
    expect(supportsSlackThreadLink({ app: 'devdy' })).toBe(false);
    expect(supportsSlackThreadLink(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------

const LINK_HEALTH: DevdyHealth = { app: 'devdy', version: '0.8.0', features: ['translate', 'slack-thread-link'] };
const OK = { kind: 'ok' as const, instance: { port: 47821, health: LINK_HEALTH } };
const DOWN = { kind: 'none' as const };

function memoryDeps(over: Partial<OutboxDeps> & { token?: string } = {}) {
  let entries: QueuedLink[] = [];
  let state: OutboxState = {};
  const alarm = { on: false, minutes: null as number | null };
  const saves: string[][] = [];
  const posted: string[] = [];
  let n = 0;
  const deps: OutboxDeps = {
    loadEntries: async () => entries.map((e) => ({ ...e })),
    saveEntries: async (e) => {
      entries = e.map((x) => ({ ...x }));
      saves.push(entries.map((x) => x.url));
    },
    loadState: async () => ({ ...state }),
    saveState: async (s) => {
      state = { ...s };
    },
    loadSettings: async () => ({ token: 'token' in over ? over.token : 'tok', port: 47821 }),
    savePort: async () => {},
    resolveDevdy: async () => OK,
    postSlackThread: async (_p, _t, url) => {
      posted.push(url);
      return { kind: 'created', id: 'srv' };
    },
    scheduleRetry: async (minutes) => {
      alarm.on = minutes !== null;
      alarm.minutes = minutes;
    },
    now: () => new Date('2026-10-16T00:00:00Z'),
    newId: () => `id${++n}`,
    ...over,
  };
  return {
    deps,
    alarm,
    posted,
    saves,
    entries: () => entries,
    setEntries: (e: QueuedLink[]) => {
      entries = e;
    },
    state: () => state,
  };
}

const LINK = 'https://acme.slack.com/archives/C0DEV1234/p1700000000000100';
const link = (i: number) => `https://acme.slack.com/archives/C0DEV1234/p17000000000001${String(i).padStart(2, '0')}`;

describe('DevdyOutbox: send', () => {
  it('sends right away and queues nothing', async () => {
    const m = memoryDeps();
    const r = await new DevdyOutbox(m.deps).send(LINK);
    expect(r).toMatchObject({ outcome: { kind: 'created' }, queued: false, pending: 0 });
    expect(r.message).toMatch(/^Sent/);
    expect(m.posted).toEqual([LINK]);
    expect(m.alarm.on).toBe(false);
  });

  it('does not send to a Devdy without "slack-thread-link" and does not queue', async () => {
    const m = memoryDeps({
      resolveDevdy: async () => ({
        kind: 'ok',
        instance: { port: 47821, health: { app: 'devdy', features: ['translate'] } },
      }),
    });
    const r = await new DevdyOutbox(m.deps).send(LINK);
    expect(r).toMatchObject({ outcome: { kind: 'outdated' }, queued: false, pending: 0 });
    expect(r.message).toBe('Update Devdy to send Slack threads.');
    expect(m.posted).toEqual([]);
  });

  it('queues while Devdy is down (deduplicated by URL) and flushes oldest-first once it is back', async () => {
    let up = false;
    const m = memoryDeps({ resolveDevdy: async () => (up ? OK : DOWN) });
    const box = new DevdyOutbox(m.deps);
    const r1 = await box.send(link(1));
    await box.send(link(2));
    const again = await box.send(link(1));
    expect(r1).toMatchObject({ outcome: { kind: 'unreachable' }, queued: true, pending: 1 });
    expect(r1.message).toBe('Devdy is not running or the Inbox API is off — queued.');
    expect(again).toMatchObject({ queued: true, pending: 2 });
    expect(m.entries().map((e) => e.url)).toEqual([link(1), link(2)]);
    expect(m.entries()[0]).toMatchObject({ id: 'id1', createdAt: '2026-10-16T00:00:00.000Z', attempts: 0 });
    expect(m.alarm.on).toBe(true);

    up = true;
    expect(await box.flush()).toMatchObject({ sent: 2, pending: 0 });
    expect(m.posted).toEqual([link(1), link(2)]);
    expect(m.alarm.on).toBe(false);
  });

  it('queues on 503 "server stopping" (counted as an attempt)', async () => {
    const m = memoryDeps({ postSlackThread: async () => ({ kind: 'unreachable', message: 'server stopping' }) });
    const r = await new DevdyOutbox(m.deps).send(LINK);
    expect(r.queued).toBe(true);
    expect(m.entries()).toMatchObject([{ url: LINK, attempts: 1, lastError: 'server stopping' }]);
  });

  it.each<[string, SendOutcome]>([
    ['400 invalid_link', { kind: 'rejected', status: 400, code: 'invalid_link', message: 'bad' }],
    ['400 dm_unsupported', { kind: 'rejected', status: 400, code: 'dm_unsupported', message: 'dm' }],
    ['413', { kind: 'rejected', status: 413, message: 'too big' }],
    ['500', { kind: 'rejected', status: 500, message: 'storage error' }],
    ['415', { kind: 'outdated', status: 415, message: 'old' }],
    ['404', { kind: 'outdated', status: 404, message: 'not found' }],
  ])('never queues %s', async (_label, outcome) => {
    const m = memoryDeps({ postSlackThread: async () => outcome });
    const r = await new DevdyOutbox(m.deps).send(LINK);
    expect(r).toMatchObject({ outcome, queued: false, pending: 0 });
    expect(m.entries()).toEqual([]);
  });

  it('a refused link also removes its queued copy', async () => {
    const m = memoryDeps({ resolveDevdy: async () => DOWN });
    const box = new DevdyOutbox(m.deps);
    await box.send(LINK);
    m.deps.resolveDevdy = async () => OK;
    m.deps.postSlackThread = async () => ({ kind: 'rejected', status: 400, code: 'invalid_link', message: 'bad' });
    expect((await box.send(LINK)).pending).toBe(0);
  });

  it('keeps the link on a missing or rejected token and pauses automatic retries', async () => {
    const noToken = memoryDeps({ token: undefined });
    const r = await new DevdyOutbox(noToken.deps).send(LINK);
    expect(r).toMatchObject({ outcome: { kind: 'token_missing' }, queued: true });
    expect(noToken.state().paused).toBe(true);

    // Devdy down AND no token → "not running", not a token problem.
    const both = memoryDeps({ token: undefined, resolveDevdy: async () => DOWN });
    expect((await new DevdyOutbox(both.deps).send(LINK)).outcome.kind).toBe('unreachable');

    const bad = memoryDeps({
      postSlackThread: async () => ({ kind: 'unauthorized', message: 'invalid or missing token' }),
    });
    const r2 = await new DevdyOutbox(bad.deps).send(LINK);
    expect(r2).toMatchObject({ outcome: { kind: 'unauthorized' }, queued: true });
    expect(bad.entries()[0]!.attempts).toBe(0); // a rejected token says nothing about the link
    expect(bad.state().paused).toBe(true);
    expect(bad.alarm.on).toBe(false);
  });

  it('waits for a choice when several Devdy apps run', async () => {
    const m = memoryDeps({
      resolveDevdy: async () => ({ kind: 'ambiguous', instances: [OK.instance, { ...OK.instance, port: 47822 }] }),
    });
    const r = await new DevdyOutbox(m.deps).send(LINK);
    expect(r).toMatchObject({ outcome: { kind: 'choose_instance' }, queued: true });
    expect(r.message).toMatch(/pick one/);
    expect(m.posted).toEqual([]);
  });

  it('after a successful send, delivers the links queued before', async () => {
    const m = memoryDeps({ resolveDevdy: async () => DOWN });
    const box = new DevdyOutbox(m.deps);
    await box.send(link(1));
    m.deps.resolveDevdy = async () => OK;
    const r = await box.send(link(2));
    expect(r).toMatchObject({ pending: 0 });
    expect(m.posted).toEqual([link(2), link(1)]);
  });

  it('refuses new links when the queue is full (queued ones are never evicted)', async () => {
    const m = memoryDeps({ resolveDevdy: async () => DOWN });
    m.setEntries(
      Array.from({ length: MAX_ENTRIES }, (_, i) => ({
        id: `q${i}`,
        url: link(i),
        createdAt: '2026-10-16T00:00:00Z',
        attempts: 0,
      })),
    );
    const r = await new DevdyOutbox(m.deps).send(link(99));
    expect(r).toMatchObject({ outcome: { kind: 'rejected', status: 0 }, queued: false, pending: MAX_ENTRIES });
    expect(r.message).toMatch(/queue is full/);
  });

  it('serializes concurrent sends (no lost links)', async () => {
    const m = memoryDeps({ resolveDevdy: async () => DOWN });
    const box = new DevdyOutbox(m.deps);
    await Promise.all([1, 2, 3, 4].map((i) => box.send(link(i))));
    expect(m.entries().map((e) => e.url)).toEqual([link(1), link(2), link(3), link(4)]);
  });
});

describe('DevdyOutbox: flush and bounds', () => {
  const queued = (url: string, over: Partial<QueuedLink> = {}): QueuedLink => ({
    id: url.slice(-3),
    url,
    createdAt: '2026-10-16T00:00:00Z',
    attempts: 0,
    ...over,
  });

  it('stops the round at the first connection problem and counts the attempt', async () => {
    const m = memoryDeps({
      postSlackThread: async () => ({ kind: 'unreachable', message: 'Devdy is not reachable.' }),
    });
    m.setEntries([queued(link(1)), queued(link(2))]);
    let calls = 0;
    const post = m.deps.postSlackThread;
    m.deps.postSlackThread = (...a) => {
      calls++;
      return post(...a);
    };
    const r = await new DevdyOutbox(m.deps).flush();
    expect(calls).toBe(1);
    expect(r).toMatchObject({ sent: 0, pending: 2 });
    expect(m.entries().map((e) => e.attempts)).toEqual([1, 0]);
  });

  it('drops links Devdy refuses for good (with a notice) and keeps going', async () => {
    const m = memoryDeps({
      postSlackThread: async (_p, _t, url) =>
        url === link(1)
          ? { kind: 'rejected', status: 400, code: 'dm_unsupported', message: 'dm' }
          : { kind: 'existing', id: 'srv' },
    });
    m.setEntries([queued(link(1)), queued(link(2))]);
    const r = await new DevdyOutbox(m.deps).flush();
    expect(r).toMatchObject({ sent: 1, pending: 0 });
    expect(m.state().notice).toMatch(/Devdy refused 1 queued link: .*p1700000000000101 \(Direct messages/);
  });

  it('keeps queued links when the running Devdy is outdated', async () => {
    const m = memoryDeps({
      resolveDevdy: async () => ({ kind: 'ok', instance: { port: 47821, health: { app: 'devdy' } } }),
    });
    m.setEntries([queued(link(1))]);
    const r = await new DevdyOutbox(m.deps).flush();
    expect(r).toMatchObject({ sent: 0, pending: 1, lastOutcome: { kind: 'outdated' } });
    expect(m.entries()[0]!.lastError).toBe('Update Devdy to send Slack threads.');
    expect(m.posted).toEqual([]);
  });

  it('drops links past the TTL or the attempt limit and reports it', async () => {
    const m = memoryDeps({ resolveDevdy: async () => DOWN });
    const now = new Date('2026-10-16T00:00:00Z').getTime();
    m.setEntries([
      queued(link(1), { createdAt: new Date(now - OUTBOX_TTL_MS - 1).toISOString() }),
      queued(link(2), { attempts: MAX_ATTEMPTS }),
      queued(link(3), { attempts: 1 }),
    ]);
    const r = await new DevdyOutbox(m.deps).flush({ auto: true });
    expect(r.pending).toBe(1);
    expect(m.entries().map((e) => e.url)).toEqual([link(3)]);
    expect(m.state().notice).toMatch(/Dropped 2 Slack links.*p1700000000000101.*p1700000000000102/);
  });

  it('backs off 1 → 2 → 5 → 15 → 60 min on automatic retries and resets on success', async () => {
    let up = false;
    const m = memoryDeps({ resolveDevdy: async () => (up ? OK : DOWN) });
    const box = new DevdyOutbox(m.deps);
    await box.send(link(1));
    const delays = [m.alarm.minutes];
    for (let i = 0; i < 5; i++) {
      await box.flush({ auto: true });
      delays.push(m.alarm.minutes);
    }
    expect(delays).toEqual([1, 2, 5, 15, 60, 60]);
    await box.flush(); // a user action does not advance the backoff
    expect(m.alarm.minutes).toBe(60);

    up = true;
    await box.flush({ auto: true });
    expect(m.alarm.on).toBe(false);
    expect(m.state().backoff).toBe(0);
  });

  it('pauses on a rejected token until resumed; manual retries meanwhile count no attempt', async () => {
    let calls = 0;
    const m = memoryDeps({
      postSlackThread: async () => {
        calls++;
        return { kind: 'unauthorized', message: 'invalid or missing token' };
      },
    });
    const box = new DevdyOutbox(m.deps);
    await box.send(LINK);
    expect(m.state().paused).toBe(true);
    await box.flush({ auto: true }); // alarm / browser start: skipped while paused
    expect(calls).toBe(1);
    await box.flush(); // "Retry now"
    expect(calls).toBe(2);
    expect(m.entries()[0]!.attempts).toBe(0);

    m.deps.postSlackThread = async () => ({ kind: 'created', id: 'srv' });
    await box.resume(); // token saved
    expect((await box.flush()).sent).toBe(1);
    expect(m.state().paused).toBe(false);
  });

  it('removes a queued link and clears the alarm when the queue is empty', async () => {
    const m = memoryDeps({ resolveDevdy: async () => DOWN });
    const box = new DevdyOutbox(m.deps);
    await box.send(LINK);
    expect(m.alarm.on).toBe(true);
    await box.remove(m.entries()[0]!.id);
    expect(m.entries()).toEqual([]);
    expect(m.alarm.on).toBe(false);
  });

  it('entries() does not wait behind a send in progress', async () => {
    let finish: (() => void) | undefined;
    const m = memoryDeps({
      postSlackThread: () =>
        new Promise((resolve) => {
          finish = () => resolve({ kind: 'created', id: 'srv' });
        }),
    });
    m.setEntries([queued(link(1))]);
    const box = new DevdyOutbox(m.deps);
    const sending = box.flush();
    await vi.waitFor(() => expect(finish).toBeDefined());
    expect((await box.entries()).map((e) => e.url)).toEqual([link(1)]);
    finish!();
    await sending;
  });
});

describe('migration of the blob outbox (≤ 2.1)', () => {
  function migrationDeps(stored: Record<string, unknown>) {
    const removed: string[] = [];
    const deleted: string[] = [];
    const notices: string[] = [];
    return {
      removed,
      deleted,
      notices,
      deps: {
        getLocal: async (keys: readonly string[]) =>
          Object.fromEntries(keys.filter((k) => k in stored).map((k) => [k, stored[k]])),
        removeLocal: async (keys: readonly string[]) => void removed.push(...keys),
        deleteDatabase: async (name: string) => void deleted.push(name),
        setNotice: async (text: string) => void notices.push(text),
      },
    };
  }

  it('drops old entries, deletes the IndexedDB database and tells the user once', async () => {
    const m = migrationDeps({
      devdyOutbox: [
        { id: 'a', title: 'a.md', contentType: 'text/markdown' },
        { id: 'b', title: 'b.zip' },
      ],
      devdyOutboxState: { paused: true },
    });
    expect(await migrateLegacyOutbox(m.deps)).toBe(2);
    expect(m.removed).toEqual([...LEGACY_OUTBOX_KEYS]);
    expect(m.deleted).toEqual([LEGACY_DB_NAME]);
    expect(m.notices).toHaveLength(1);
    expect(m.notices[0]).toMatch(/^2 exports queued by the previous version were dropped: .*Slack thread links only/);
  });

  it('says nothing when there was nothing to drop (fresh install / already migrated)', async () => {
    const empty = migrationDeps({});
    expect(await migrateLegacyOutbox(empty.deps)).toBe(0);
    expect(empty.removed).toEqual([]);
    expect(empty.deleted).toEqual([LEGACY_DB_NAME]); // harmless when it doesn't exist
    expect(empty.notices).toEqual([]);

    const stateOnly = migrationDeps({ devdyOutbox: [], devdyOutboxState: {} });
    expect(await migrateLegacyOutbox(stateOnly.deps)).toBe(0);
    expect(stateOnly.removed).toEqual([...LEGACY_OUTBOX_KEYS]);
    expect(stateOnly.notices).toEqual([]);
  });

  it('a failing database deletion does not block the rest', async () => {
    const m = migrationDeps({ devdyOutbox: [{ id: 'a' }] });
    m.deps.deleteDatabase = async () => {
      throw new Error('blocked');
    };
    expect(await migrateLegacyOutbox(m.deps)).toBe(1);
    expect(m.notices).toHaveLength(1);
  });
});

describe('devdy-client: resolveFromInstances / isDevdyPort', () => {
  const inst = (port: number) => ({ port, health: { app: 'devdy' as const } });
  it('derives the resolved instance from one probe', () => {
    expect(resolveFromInstances([], {})).toEqual({ kind: 'none' });
    expect(resolveFromInstances([inst(47821)], {})).toMatchObject({ kind: 'ok', instance: { port: 47821 } });
    expect(resolveFromInstances([inst(47821), inst(47822)], {}).kind).toBe('ambiguous');
    expect(resolveFromInstances([inst(47821), inst(47822)], { port: 47822, pinned: true })).toMatchObject({
      kind: 'ok',
      instance: { port: 47822 },
    });
    expect(resolveFromInstances([inst(47821)], { port: 47823, pinned: true })).toEqual({ kind: 'none' });
  });
  it('accepts only 47821…47830', () => {
    expect(isDevdyPort(47821)).toBe(true);
    expect(isDevdyPort(47830)).toBe(true);
    expect(isDevdyPort(47831)).toBe(false);
    expect(isDevdyPort(80)).toBe(false);
    expect(isDevdyPort(47821.5)).toBe(false);
    expect(isDevdyPort('47821')).toBe(false);
  });
});
