import { describe, expect, it } from 'vitest';
import {
  buildThreadLink,
  isCanonicalThreadLink,
  normalizeThreadLink,
  workspaceHost,
  workspaceHostFromLocalConfig,
} from '../src/features/slack/core/thread-link';

describe('buildThreadLink', () => {
  it('builds the root message permalink', () => {
    expect(buildThreadLink({ host: 'malme.slack.com', channelId: 'C0B83GHDTFG', ts: '1789877283.026359' })).toEqual({
      ok: true,
      url: 'https://malme.slack.com/archives/C0B83GHDTFG/p1789877283026359',
    });
    // threadTs equal to ts = the root itself
    expect(
      buildThreadLink({
        host: 'malme.slack.com',
        channelId: 'C0B83GHDTFG',
        ts: '1789877283.026359',
        threadTs: '1789877283.026359',
      }),
    ).toEqual({ ok: true, url: 'https://malme.slack.com/archives/C0B83GHDTFG/p1789877283026359' });
  });

  it('adds thread_ts and cid for a reply', () => {
    expect(
      buildThreadLink({
        host: 'malme.slack.com',
        channelId: 'G0PRIVATE1',
        ts: '1789877300.000200',
        threadTs: '1789877283.026359',
      }),
    ).toEqual({
      ok: true,
      url: 'https://malme.slack.com/archives/G0PRIVATE1/p1789877300000200?thread_ts=1789877283.026359&cid=G0PRIVATE1',
    });
  });

  it('accepts enterprise hosts', () => {
    expect(
      buildThreadLink({ host: 'acme.enterprise.slack.com', channelId: 'C0DEV12345', ts: '1700000000.000100' }),
    ).toEqual({
      ok: true,
      url: 'https://acme.enterprise.slack.com/archives/C0DEV12345/p1700000000000100',
    });
  });

  it('rejects DM channels before anything else', () => {
    expect(buildThreadLink({ host: '', channelId: 'D0DIRECT01', ts: 'x' })).toMatchObject({ ok: false, error: 'dm' });
  });

  it('rejects non-workspace hosts, short channel ids and bad timestamps', () => {
    const ts = '1700000000.000100';
    expect(buildThreadLink({ host: 'app.slack.com', channelId: 'C0DEV12345', ts })).toMatchObject({
      error: 'no_workspace',
    });
    expect(buildThreadLink({ host: 'evil.example.com', channelId: 'C0DEV12345', ts })).toMatchObject({
      error: 'no_workspace',
    });
    expect(buildThreadLink({ host: 'a.b.slack.com', channelId: 'C0DEV12345', ts })).toMatchObject({
      error: 'no_workspace',
    });
    expect(buildThreadLink({ host: 'acme.slack.com', channelId: 'C0SHORT', ts })).toMatchObject({ error: 'invalid' });
    expect(buildThreadLink({ host: 'acme.slack.com', channelId: 'C0DEV12345', ts: '170000000.000100' })).toMatchObject({
      error: 'invalid',
    });
    expect(buildThreadLink({ host: 'acme.slack.com', channelId: 'C0DEV12345', ts, threadTs: 'nope' })).toMatchObject({
      error: 'invalid',
    });
  });
});

describe('normalizeThreadLink', () => {
  it('canonicalizes Slack "Copy link" permalinks (root and reply)', () => {
    expect(normalizeThreadLink(' <https://Acme.slack.com/archives/C0DEV12345/p1700000000000100#x> ')).toEqual({
      ok: true,
      url: 'https://acme.slack.com/archives/C0DEV12345/p1700000000000100',
    });
    expect(
      normalizeThreadLink(
        'https://acme.slack.com/archives/C0DEV12345/p1700000100000200?thread_ts=1700000000.000100&cid=C0DEV12345&utm=1',
      ),
    ).toEqual({
      ok: true,
      url: 'https://acme.slack.com/archives/C0DEV12345/p1700000100000200?thread_ts=1700000000.000100&cid=C0DEV12345',
    });
  });

  it('rejects DMs, client URLs and non-message links', () => {
    expect(normalizeThreadLink('https://acme.slack.com/archives/D0DIRECT01/p1700000000000100')).toMatchObject({
      ok: false,
      error: 'dm',
    });
    expect(normalizeThreadLink('https://app.slack.com/client/T0TEAM/C0DEV12345')).toMatchObject({ error: 'invalid' });
    expect(normalizeThreadLink('https://acme.slack.com/archives/C0DEV12345')).toMatchObject({ error: 'invalid' });
    expect(normalizeThreadLink('not a url')).toMatchObject({ error: 'invalid' });
  });

  it('isCanonicalThreadLink accepts only what the builder produces', () => {
    expect(isCanonicalThreadLink('https://acme.slack.com/archives/C0DEV12345/p1700000000000100')).toBe(true);
    expect(isCanonicalThreadLink('https://acme.slack.com/archives/C0DEV12345/p1700000000000100?x=1')).toBe(false);
    expect(isCanonicalThreadLink('https://acme.slack.com/archives/D0DIRECT01/p1700000000000100')).toBe(false);
    expect(isCanonicalThreadLink(42)).toBe(false);
  });
});

describe('workspace host', () => {
  it('accepts <ws>.slack.com and <ws>.enterprise.slack.com only', () => {
    expect(workspaceHost('https://acme.slack.com/')).toBe('acme.slack.com');
    expect(workspaceHost('ACME-dev.enterprise.slack.com')).toBe('acme-dev.enterprise.slack.com');
    expect(workspaceHost('https://app.slack.com/')).toBeNull();
    expect(workspaceHost('http://acme.slack.com/')).toBeNull();
    expect(workspaceHost('https://acme.slack.com:8443/')).toBeNull();
    expect(workspaceHost('acme.slack.com.evil.com')).toBeNull();
  });

  it('reads the team url/domain from localConfig_v2 (never needs the token)', () => {
    const cfg = JSON.stringify({
      teams: {
        T1: { id: 'T1', url: 'https://acme.slack.com/', domain: 'acme', token: 'xoxc-secret' },
        T2: { id: 'T2', enterprise_id: 'E9', domain: 'bigco.enterprise' },
      },
      lastActiveTeamId: 'T1',
    });
    expect(workspaceHostFromLocalConfig(cfg, 'T1')).toBe('acme.slack.com');
    expect(workspaceHostFromLocalConfig(cfg, 'E9')).toBe('bigco.enterprise.slack.com');
    expect(workspaceHostFromLocalConfig(cfg)).toBe('acme.slack.com'); // last active
    expect(workspaceHostFromLocalConfig(cfg, 'T404')).toBeNull(); // never guess another workspace
    expect(workspaceHostFromLocalConfig('{bad json', 'T1')).toBeNull();
    expect(workspaceHostFromLocalConfig(null)).toBeNull();
  });
});
