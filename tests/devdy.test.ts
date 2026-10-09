import { describe, expect, it, vi } from 'vitest';
import {
  type FetchFn,
  type SendOutcome,
  checkHealth,
  describeOutcome,
  findAllDevdy,
  isRetryable,
  listProjects,
  postCapture,
  resolveDevdy,
} from '../src/core/devdy-client';
import { DevdyOutbox, type OutboxDeps, type OutboxEntry } from '../src/core/devdy-outbox';

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
    const out = await postCapture(47821, 'tok', { body, contentType: 'text/markdown; charset=utf-8', projectId: 'p1' }, f);
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
    const out = await postCapture(47821, 't', { body: big, contentType: 'application/zip' }, fetchSpy as unknown as FetchFn);
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
  const blobs = new Map<string, Blob>();
  const alarm = { on: false };
  const posted: string[] = [];
  const kinds: string[] = [];
  const deps: OutboxDeps = {
    loadEntries: async () => entries.map((e) => ({ ...e })),
    saveEntries: async (e) => {
      entries = e.map((x) => ({ ...x }));
    },
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
    setRetryAlarm: async (on) => {
      alarm.on = on;
    },
    now: () => new Date('2026-10-08T00:00:00Z'),
    ...over,
  };
  return { deps, blobs, alarm, posted, kinds, entries: () => entries };
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

  it('drops permanently rejected payloads', async () => {
    const m = memoryDeps({ postCapture: async () => ({ kind: 'rejected', status: 400, message: 'zip has two .md' }) });
    const r = await new DevdyOutbox(m.deps).enqueue({ id: 'a', title: 'A', contentType: 'application/zip' }, md('A'));
    expect(r.outcome).toMatchObject({ kind: 'rejected', status: 400 });
    expect(r.pending).toBe(0);
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
    await Promise.all(
      ['a', 'b', 'c', 'd'].map((id) => box.enqueue({ id, title: id, contentType: 'x' }, md(id))),
    );
    expect(m.entries().map((e) => e.id)).toEqual(['a', 'b', 'c', 'd']);
  });
});
