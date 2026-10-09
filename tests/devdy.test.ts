import { describe, expect, it, vi } from 'vitest';
import {
  checkHealth,
  describeOutcome,
  type FetchFn,
  findAllDevdy,
  isDevdyPort,
  isRetryable,
  listProjects,
  postCapture,
  resolveDevdy,
  resolveFromInstances,
  type SendOutcome,
} from '../src/features/devdy/core/client';
import {
  DevdyOutbox,
  MAX_ATTEMPTS,
  MAX_OUTBOX_BYTES,
  OUTBOX_TTL_MS,
  type OutboxDeps,
  type OutboxEntry,
  type OutboxState,
} from '../src/features/devdy/core/outbox';
import { isExtensionSender, isSlackContentSender } from '../src/features/devdy/core/sender';

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
        return json(200, [{ id: 'p1', name: 'Context Kit' }, { bogus: true }]);
      },
    });
    expect(await listProjects(47821, 'tok', f)).toEqual({ ok: true, projects: [{ id: 'p1', name: 'Context Kit' }] });
    expect(auth).toBe('Bearer tok');
    const denied = fakeDevdy(47821, { 'GET /v1/projects': () => json(401, { error: 'invalid token' }) });
    expect(await listProjects(47821, 'bad', denied)).toMatchObject({ ok: false, kind: 'unauthorized' });
  });

  it('posts the payload with content type and project header', async () => {
    let seen: { ct?: string | null; project?: string | null; body?: string } = {};
    const f = fakeDevdy(47821, {
      'POST /v1/slack-threads': (init) => {
        const h = new Headers(init?.headers);
        seen = { ct: h.get('Content-Type'), project: h.get('X-Devdy-Project-Id') };
        return json(201, { id: 't1', status: 'created' });
      },
    });
    const body = new Blob(['# hi'], { type: 'text/markdown' });
    const out = await postCapture(
      47821,
      'tok',
      { body, contentType: 'text/markdown; charset=utf-8', projectId: 'p1' },
      f,
    );
    expect(out).toEqual({ kind: 'created', id: 't1' });
    expect(seen).toEqual({ ct: 'text/markdown; charset=utf-8', project: 'p1' });
  });

  it.each([
    [200, { id: 't1', status: 'updated' }, 'updated'],
    [401, { error: 'invalid or missing token' }, 'unauthorized'],
    [400, { error: 'invalid front matter' }, 'rejected'],
    [413, { error: 'payload exceeds 50 MB' }, 'rejected'],
    [500, { error: 'storage error' }, 'server_error'],
  ])('maps HTTP %i to %s', async (status, body, kind) => {
    const f = fakeDevdy(47821, { 'POST /v1/slack-threads': () => json(status, body) });
    const out = await postCapture(47821, 't', { body: new Blob(['x']), contentType: 'text/plain' }, f);
    expect(out.kind).toBe(kind);
  });

  it('treats a network error as unreachable and refuses >50 MB locally', async () => {
    const down = fakeDevdy(1, {});
    expect((await postCapture(47821, 't', { body: new Blob(['x']), contentType: 'text/plain' }, down)).kind).toBe(
      'unreachable',
    );
    const big = { size: 51 * 1024 * 1024 } as Blob;
    const fetchSpy = vi.fn();
    const out = await postCapture(
      47821,
      't',
      { body: big, contentType: 'application/zip' },
      fetchSpy as unknown as FetchFn,
    );
    expect(out).toMatchObject({ kind: 'rejected', status: 413 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('classifies retryable outcomes and describes them', () => {
    const o = (kind: SendOutcome['kind']): SendOutcome =>
      kind === 'created' || kind === 'updated'
        ? { kind, id: 'x' }
        : kind === 'rejected'
          ? { kind, status: 400, message: 'bad' }
          : { kind, message: 'm' };
    expect(['unreachable', 'no_token', 'unauthorized', 'server_error'].every((k) => isRetryable(o(k as never)))).toBe(
      true,
    );
    expect(['created', 'updated', 'rejected'].some((k) => isRetryable(o(k as never)))).toBe(false);
    expect(describeOutcome(o('unreachable'))).toMatch(/queued/);
    expect(describeOutcome(o('unauthorized'))).toMatch(/token/);
  });
});

// ---------------------------------------------------------------------------

function memoryDeps(over: Partial<OutboxDeps> & { token?: string } = {}) {
  let entries: OutboxEntry[] = [];
  let state: OutboxState = {};
  const blobs = new Map<string, Blob>();
  const alarm = { on: false, minutes: null as number | null };
  const saves: string[][] = [];
  const posted: string[] = [];
  const kinds: string[] = [];
  const deps: OutboxDeps = {
    loadEntries: async () => entries.map((e) => ({ ...e })),
    saveEntries: async (e) => {
      entries = e.map((x) => ({ ...x }));
      saves.push(entries.map((x) => x.id));
    },
    loadState: async () => ({ ...state }),
    saveState: async (s) => {
      state = { ...s };
    },
    listBlobIds: async () => [...blobs.keys()],
    loadSettings: async () => ({ token: 'token' in over ? over.token : 'tok', port: 47821 }),
    savePort: async () => {},
    putBlob: async (id, b) => void blobs.set(id, b),
    getBlob: async (id) => blobs.get(id),
    deleteBlob: async (id) => void blobs.delete(id),
    resolveDevdy: async () => ({ kind: 'ok', instance: { port: 47821, health: { app: 'devdy' } } }),
    postCapture: async (_p, _t, payload) => {
      kinds.push(payload.kind ?? 'slack-threads');
      posted.push(await payload.body.text());
      return { kind: 'created', id: 'srv' };
    },
    scheduleRetry: async (minutes) => {
      alarm.on = minutes !== null;
      alarm.minutes = minutes;
    },
    now: () => new Date('2026-10-08T00:00:00Z'),
    ...over,
  };
  return {
    deps,
    blobs,
    alarm,
    posted,
    kinds,
    saves,
    entries: () => entries,
    setEntries: (e: OutboxEntry[]) => {
      entries = e;
    },
    state: () => state,
  };
}

const md = (s: string) => new Blob([s], { type: 'text/markdown' });

describe('DevdyOutbox', () => {
  it('posts each entry to its endpoint (legacy entries default to slack-threads)', async () => {
    const m = memoryDeps({ resolveDevdy: async () => ({ kind: 'none' }) });
    const box = new DevdyOutbox(m.deps);
    await box.enqueue({ id: 'old', title: 'legacy', contentType: 'x' }, md('old'));
    await box.enqueue({ id: 'w', kind: 'web-pages', title: 'web', contentType: 'x' }, md('w'));
    m.deps.resolveDevdy = async () => ({ kind: 'ok', instance: { port: 47821, health: { app: 'devdy' } } });
    await box.flush();
    expect(m.kinds).toEqual(['slack-threads', 'web-pages']);
  });

  it('waits for a choice when several Devdy apps run', async () => {
    const m = memoryDeps({
      resolveDevdy: async () => ({
        kind: 'ambiguous',
        instances: [
          { port: 47821, health: { app: 'devdy' } },
          { port: 47822, health: { app: 'devdy' } },
        ],
      }),
    });
    const r = await new DevdyOutbox(m.deps).enqueue({ id: 'a', title: 'A', contentType: 'x' }, md('A'));
    expect(r.outcome).toMatchObject({ kind: 'choose_instance' });
    expect(r.message).toMatch(/pick one/);
    expect(r.pending).toBe(1);
    expect(m.posted).toEqual([]);
  });

  it('delivers immediately and leaves nothing queued', async () => {
    const m = memoryDeps();
    const r = await new DevdyOutbox(m.deps).enqueue({ id: 'a', title: 'A', contentType: 'text/markdown' }, md('# A'));
    expect(r.outcome).toEqual({ kind: 'created', id: 'srv' });
    expect(r.pending).toBe(0);
    expect(m.posted).toEqual(['# A']);
    expect(m.blobs.size).toBe(0);
    expect(m.alarm.on).toBe(false);
  });

  it('queues while Devdy is down and flushes oldest-first once it is back', async () => {
    let up = false;
    const m = memoryDeps({
      resolveDevdy: async () =>
        up ? { kind: 'ok', instance: { port: 47821, health: { app: 'devdy' } } } : { kind: 'none' },
    });
    const box = new DevdyOutbox(m.deps);

    const r1 = await box.enqueue({ id: 'a', title: 'A', contentType: 'text/markdown' }, md('A'));
    const r2 = await box.enqueue({ id: 'b', title: 'B', contentType: 'text/markdown' }, md('B'));
    expect(r1.outcome.kind).toBe('unreachable');
    expect(r2.pending).toBe(2);
    expect(m.alarm.on).toBe(true);
    expect(m.entries().map((e) => e.lastError)).toEqual(['Devdy is not running.', 'Devdy is not running.']);

    up = true;
    const f = await box.flush();
    expect(f).toMatchObject({ sent: 2, pending: 0 });
    expect(m.posted).toEqual(['A', 'B']);
    expect(m.alarm.on).toBe(false);
  });

  it('keeps entries on a bad/missing token and stops at the first retryable failure', async () => {
    const noToken = memoryDeps({ token: undefined });
    const r = await new DevdyOutbox(noToken.deps).enqueue({ id: 'a', title: 'A', contentType: 'x' }, md('A'));
    expect(r.outcome.kind).toBe('no_token');
    expect(r.message).toMatch(/Queued: set the Devdy token/);
    expect(r.pending).toBe(1);

    // Devdy down AND no token → report "not running", not a token problem.
    const both = memoryDeps({ token: undefined, resolveDevdy: async () => ({ kind: 'none' }) });
    const r2 = await new DevdyOutbox(both.deps).enqueue({ id: 'a', title: 'A', contentType: 'x' }, md('A'));
    expect(r2.outcome.kind).toBe('unreachable');

    let calls = 0;
    const bad = memoryDeps({
      postCapture: async () => {
        calls++;
        return { kind: 'unauthorized', message: 'invalid token' };
      },
    });
    const box = new DevdyOutbox(bad.deps);
    await box.enqueue({ id: 'a', title: 'A', contentType: 'x' }, md('A'));
    await box.enqueue({ id: 'b', title: 'B', contentType: 'x' }, md('B'));
    expect(bad.entries()).toHaveLength(2);
    expect(bad.entries()[0]!.attempts).toBe(2); // tried on each enqueue
    expect(calls).toBe(2); // 'b' was never posted after 'a' failed
  });

  it('keeps permanently rejected payloads as failed records (not retried, downloadable)', async () => {
    let calls = 0;
    const m = memoryDeps({
      postCapture: async () => {
        calls++;
        return { kind: 'rejected', status: 413, message: 'payload exceeds 50 MB' };
      },
    });
    const box = new DevdyOutbox(m.deps);
    const r = await box.enqueue({ id: 'a', title: 'A', contentType: 'application/zip' }, md('A'));
    expect(r.outcome).toMatchObject({ kind: 'rejected', status: 413 });
    expect(r.message).toMatch(/kept in Context Kit → Devdy/);
    expect(r.pending).toBe(0);
    expect(m.blobs.has('a')).toBe(true);
    expect(m.entries()[0]!.failed).toMatchObject({ status: 413 });
    expect(m.alarm.on).toBe(false);

    await box.flush();
    expect(calls).toBe(1); // never retried
    await box.remove('a');
    expect(m.entries()).toEqual([]);
    expect(m.blobs.size).toBe(0);
  });

  it('uses a blob stored beforehand (zip written by the offscreen document)', async () => {
    const m = memoryDeps();
    m.blobs.set('z', new Blob(['ZIP']));
    const r = await new DevdyOutbox(m.deps).enqueue({ id: 'z', title: 'Z', contentType: 'application/zip' }, null);
    expect(r.outcome.kind).toBe('created');
    expect(m.posted).toEqual(['ZIP']);
  });

  it('serializes concurrent enqueues (no lost entries)', async () => {
    const m = memoryDeps({ resolveDevdy: async () => ({ kind: 'none' }) });
    const box = new DevdyOutbox(m.deps);
    await Promise.all(['a', 'b', 'c', 'd'].map((id) => box.enqueue({ id, title: id, contentType: 'x' }, md(id))));
    expect(m.entries().map((e) => e.id)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('DevdyOutbox: durability and bounds', () => {
  const ok = { kind: 'ok' as const, instance: { port: 47821, health: { app: 'devdy' as const } } };

  it('persists the list after each successful delivery and sends an Idempotency-Key', async () => {
    const keys: (string | undefined)[] = [];
    const m = memoryDeps({ resolveDevdy: async () => ({ kind: 'none' }) });
    const box = new DevdyOutbox(m.deps);
    for (const id of ['a', 'b', 'c']) await box.enqueue({ id, title: id, contentType: 'x' }, md(id));
    m.saves.length = 0;
    m.deps.resolveDevdy = async () => ok;
    m.deps.postCapture = async (_p, _t, payload) => {
      keys.push(payload.idempotencyKey);
      // A crash right after this post must not resend the entries already delivered.
      return { kind: 'created', id: 'srv' };
    };
    await box.flush();
    expect(keys).toEqual(['a', 'b', 'c']);
    expect(m.saves.slice(0, 3)).toEqual([['b', 'c'], ['c'], []]);
  });

  it('the entry list is saved before the next post (simulated SW kill)', async () => {
    const m = memoryDeps({ resolveDevdy: async () => ({ kind: 'none' }) });
    const box = new DevdyOutbox(m.deps);
    await box.enqueue({ id: 'a', title: 'a', contentType: 'x' }, md('a'));
    await box.enqueue({ id: 'b', title: 'b', contentType: 'x' }, md('b'));
    m.deps.resolveDevdy = async () => ok;
    let seenBeforeSecond: string[] = [];
    let n = 0;
    m.deps.postCapture = async () => {
      if (n++ === 1) seenBeforeSecond = m.entries().map((e) => e.id);
      return { kind: 'created', id: 'srv' };
    };
    await box.flush();
    expect(seenBeforeSecond).toEqual(['b']);
  });

  it('drops queued entries past the TTL or the attempt limit, deletes their blobs and reports it', async () => {
    const m = memoryDeps({ resolveDevdy: async () => ({ kind: 'none' }) });
    const now = new Date('2026-10-08T00:00:00Z').getTime();
    m.setEntries([
      {
        id: 'old',
        title: 'Old',
        contentType: 'x',
        createdAt: new Date(now - OUTBOX_TTL_MS - 1).toISOString(),
        attempts: 0,
      },
      { id: 'tired', title: 'Tired', contentType: 'x', createdAt: new Date(now).toISOString(), attempts: MAX_ATTEMPTS },
      { id: 'fresh', title: 'Fresh', contentType: 'x', createdAt: new Date(now).toISOString(), attempts: 1 },
    ]);
    for (const id of ['old', 'tired', 'fresh']) m.blobs.set(id, md(id));
    const r = await new DevdyOutbox(m.deps).flush({ auto: true });
    expect(r.pending).toBe(1);
    expect(m.entries().map((e) => e.id)).toEqual(['fresh']);
    expect([...m.blobs.keys()]).toEqual(['fresh']);
    expect(m.state().notice).toMatch(/Dropped 2 exports.*“Old”, “Tired”/);
  });

  it('refuses a new export when the queue is full (failed records are evicted first)', async () => {
    const m = memoryDeps({ resolveDevdy: async () => ({ kind: 'none' }) });
    const big = MAX_OUTBOX_BYTES - 10;
    m.setEntries([
      {
        id: 'f',
        title: 'F',
        contentType: 'x',
        createdAt: '2026-10-08T00:00:00Z',
        attempts: 0,
        size: 50,
        failed: { status: 413, message: 'too big', at: '2026-10-08T00:00:00Z' },
      },
      { id: 'q', title: 'Q', contentType: 'x', createdAt: '2026-10-08T00:00:00Z', attempts: 0, size: big },
    ]);
    m.blobs.set('f', md('f'));
    m.blobs.set('q', md('q'));
    const box = new DevdyOutbox(m.deps);
    const r = await box.enqueue({ id: 'n', title: 'N', contentType: 'x' }, new Blob(['x'.repeat(20)]));
    expect(r.outcome).toMatchObject({ kind: 'rejected', status: 0 });
    expect(r.message).toMatch(/queue is full/);
    expect(m.entries().map((e) => e.id)).toEqual(['q']); // failed record evicted, queued one kept
    expect([...m.blobs.keys()]).toEqual(['q']);

    const small = await box.enqueue({ id: 's', title: 'S', contentType: 'x' }, new Blob(['12345']));
    expect(small.outcome.kind).toBe('unreachable');
    expect(m.entries().map((e) => e.id)).toEqual(['q', 's']);
  });

  it('backs off 1 → 2 → 5 → 15 → 60 min on automatic retries and resets on success', async () => {
    let up = false;
    const m = memoryDeps({ resolveDevdy: async () => (up ? ok : { kind: 'none' }) });
    const box = new DevdyOutbox(m.deps);
    await box.enqueue({ id: 'a', title: 'a', contentType: 'x' }, md('a'));
    const delays = [m.alarm.minutes];
    for (let i = 0; i < 5; i++) {
      await box.flush({ auto: true });
      delays.push(m.alarm.minutes);
    }
    expect(delays).toEqual([1, 2, 5, 15, 60, 60]);

    // A user action (enqueue / Retry now) does not advance the backoff.
    await box.flush();
    expect(m.alarm.minutes).toBe(60);

    await box.enqueue({ id: 'b', title: 'b', contentType: 'x' }, md('b'));
    up = true;
    await box.flush({ auto: true });
    expect(m.alarm.on).toBe(false);
    expect(m.state().backoff).toBe(0);
  });

  it('pauses automatic retries on a rejected token until resumed', async () => {
    let calls = 0;
    const m = memoryDeps({
      postCapture: async () => {
        calls++;
        return { kind: 'unauthorized', message: 'invalid token' };
      },
    });
    const box = new DevdyOutbox(m.deps);
    await box.enqueue({ id: 'a', title: 'a', contentType: 'x' }, md('a'));
    expect(calls).toBe(1);
    expect(m.state().paused).toBe(true);
    expect(m.alarm.on).toBe(false);

    await box.flush({ auto: true }); // alarm / browser start: skipped while paused
    expect(calls).toBe(1);

    m.deps.postCapture = async () => {
      calls++;
      return { kind: 'created', id: 'srv' };
    };
    await box.resume(); // token saved
    const r = await box.flush();
    expect(r.sent).toBe(1);
    expect(m.state().paused).toBe(false);
  });

  it('removes orphan blobs but never a held (being written) one', async () => {
    const m = memoryDeps({ resolveDevdy: async () => ({ kind: 'none' }) });
    const box = new DevdyOutbox(m.deps);
    await box.enqueue({ id: 'kept', title: 'k', contentType: 'x' }, md('k'));
    m.blobs.set('orphan', md('o'));
    const release = box.hold('writing');
    m.blobs.set('writing', md('w'));
    expect(await box.cleanup()).toBe(1);
    expect([...m.blobs.keys()].sort()).toEqual(['kept', 'writing']);

    // Enqueued afterwards: referenced by the outbox → kept even once released.
    await box.enqueue({ id: 'writing', title: 'w', contentType: 'x' }, null);
    release();
    await box.flush();
    expect([...m.blobs.keys()].sort()).toEqual(['kept', 'writing']);

    // Released without enqueue (export failed) → cleaned on the next flush.
    box.hold('lost')();
    m.blobs.set('lost', md('l'));
    await box.flush();
    expect(m.blobs.has('lost')).toBe(false);
  });

  it('entries() does not wait behind an upload in progress', async () => {
    let finish: (() => void) | undefined;
    const m = memoryDeps({
      postCapture: () =>
        new Promise((resolve) => {
          finish = () => resolve({ kind: 'created', id: 'srv' });
        }),
    });
    const box = new DevdyOutbox(m.deps);
    const sending = box.enqueue({ id: 'a', title: 'a', contentType: 'x' }, md('a'));
    await vi.waitFor(() => expect(finish).toBeDefined());
    expect((await box.entries()).map((e) => e.id)).toEqual(['a']);
    finish!();
    await sending;
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

describe('message sender checks', () => {
  const ID = 'abc';
  const BASE = 'chrome-extension://abc/';
  it('accepts only extension pages / the service worker for privileged commands', () => {
    expect(isExtensionSender({ id: ID, url: `${BASE}src/features/devdy/popup/popup.html` }, ID, BASE)).toBe(true);
    expect(isExtensionSender({ id: ID, url: `${BASE}background.js` }, ID, BASE)).toBe(true);
    expect(isExtensionSender({ id: ID, url: 'https://evil.example/', tab: {} }, ID, BASE)).toBe(false);
    expect(isExtensionSender({ id: 'other', url: `${BASE}x.html` }, ID, BASE)).toBe(false);
    expect(isExtensionSender({ id: ID }, ID, BASE)).toBe(false);
  });
  it('accepts quick send only from app.slack.com', () => {
    expect(isSlackContentSender({ id: ID, url: 'https://app.slack.com/client/T1/C1' }, ID)).toBe(true);
    expect(isSlackContentSender({ id: ID, url: 'https://app.slack.com.evil.example/' }, ID)).toBe(false);
    expect(isSlackContentSender({ id: ID, url: 'https://example.com/' }, ID)).toBe(false);
  });
});
