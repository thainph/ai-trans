import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  authorName,
  buildThreadMarkdown,
  formatLocalIso,
  makeTitle,
  sanitizeFilenamePart,
  type ThreadData,
} from '../src/features/slack/core/md-builder';
import type { SlackMessage, SlackRepliesResponse } from '../src/features/slack/core/types';
import { yamlScalar } from '../src/shared/yaml';
import fixture from './fixtures/replies.json';

const replies = fixture as unknown as SlackRepliesResponse;

function threadData(overrides: Partial<ThreadData> = {}): ThreadData {
  return {
    workspace: { name: 'Papay', domain: 'papay' },
    channel: { id: 'C0DEPLOY', name: 'dev-deploy' },
    threadUrl: 'https://papay.slack.com/archives/C0DEPLOY/p1700000000123456',
    messages: replies.messages ?? [],
    users: { U01ALICE: 'Alice', U02BOB: 'Bob', U03CAROL: 'Carol Tanaka', U05BOTUSER: 'Release App' },
    channels: { C0GENERAL: 'general' },
    ...overrides,
  };
}

// 2026-10-07 16:20:05 in Asia/Tokyo (tests run with TZ=Asia/Tokyo)
const NOW = new Date('2026-10-07T07:20:05Z');
const ALL = { includeReactions: true, includeFiles: true };

describe('buildThreadMarkdown', () => {
  it('runs with TZ=Asia/Tokyo', () => {
    expect(formatLocalIso(NOW)).toBe('2026-10-07T16:20:05+09:00');
  });

  it('builds the full document from a realistic replies fixture', () => {
    const { markdown, filename, messageCount } = buildThreadMarkdown(threadData(), ALL, NOW);
    expect(messageCount).toBe(5);
    expect(filename).toBe('slack-thread-dev-deploy-20231115-0713.md');
    expect(markdown).toBe(`---
title: "Deploy plan for v2.3 🚀"
workspace: Papay
channel: "#dev-deploy"
thread_url: https://papay.slack.com/archives/C0DEPLOY/p1700000000123456
thread_ts: "1700000000.123456"
exported_at: 2026-10-07T16:20:05+09:00
messages: 5
participants: [Alice, Bob, Deploy Bot, Carol Tanaka, Release App]
---

# Thread: Deploy plan for v2.3 🚀

### Alice — 2023-11-15 07:13 _(edited)_

Deploy plan for **v2.3** 🚀
cc @Bob see [runbook](https://docs.example.com/deploy?a=1&b=2)
Steps:

1. Freeze \`main\`
2. Run migrations
    - *users table*
3. ~~Old step~~

\`\`\`
npm run migrate -- --env=prod
echo "done"
\`\`\`

> Remember: no deploys on Friday

Reactions: 👍 3, 🎉 1, :party-parrot: 1

---

### Bob — 2023-11-15 07:18

Attached the checklist @here — also posted in #general

📎 deploy-checklist.pdf — https://papay.slack.com/files/U02BOB/F01/deploy-checklist.pdf

---

### Deploy Bot — 2023-11-15 07:23

**Build** [#42](https://ci.example.com/build/42) passed ✅ for @Alice

> **[Coverage report](https://ci.example.com/cov/42)**
> Coverage **91%**

---

### Carol Tanaka — 2023-11-15 07:28

Thanks @Alice! ~~old~~ *new* <tag> \`code_x\` :custom_emoji:
> quoted line

---

### Release App — 2023-11-15 07:33

**Release v2.3**

Shipped by @Bob ✨
`);
  });

  it('omits reactions and files when disabled', () => {
    const { markdown } = buildThreadMarkdown(threadData(), { includeReactions: false, includeFiles: false }, NOW);
    expect(markdown).not.toContain('Reactions:');
    expect(markdown).not.toContain('📎');
  });

  it('falls back to user_profile and ids when users are unresolved', () => {
    const { markdown } = buildThreadMarkdown(threadData({ users: {} }), ALL, NOW);
    expect(markdown).toContain('### alice.d — ');
    expect(markdown).toContain('### U02BOB — ');
    expect(markdown).toContain('participants: [alice.d, U02BOB, Deploy Bot, U03CAROL, U05BOTUSER]');
  });

  it('labels DMs with the other user and quotes YAML when needed', () => {
    const { markdown, filename } = buildThreadMarkdown(
      threadData({
        workspace: { name: 'Acme: Inc' },
        channel: { id: 'D01', isIm: true, imUserId: 'U02BOB' },
        messages: [{ ts: '1700000000.000100', user: 'U02BOB', text: '' }],
      }),
      ALL,
      NOW,
    );
    expect(markdown).toContain('workspace: "Acme: Inc"');
    expect(markdown).toContain('channel: "@Bob"');
    expect(markdown).toContain('# Thread: (no text)');
    expect(filename).toBe('slack-thread-Bob-20231115-0713.md');
  });
});

describe('truncation notice (finding #2)', () => {
  it('marks partial exports in frontmatter and body', () => {
    const { markdown } = buildThreadMarkdown(threadData({ truncated: true }), ALL, NOW);
    expect(markdown).toContain(
      'participants: [Alice, Bob, Deploy Bot, Carol Tanaka, Release App]\ntruncated: true\n---',
    );
    expect(markdown).toContain('# Thread: Deploy plan for v2.3 🚀\n\n> ⚠️ This export may be incomplete');
  });

  it('omits the flag for complete exports', () => {
    const { markdown } = buildThreadMarkdown(threadData({ truncated: false }), ALL, NOW);
    expect(markdown).not.toContain('truncated');
    expect(markdown).not.toContain('⚠️');
  });
});

describe('YAML frontmatter escaping (finding #9)', () => {
  const frontmatterOf = (markdown: string) => {
    const m = /^---\n([\s\S]*?)\n---\n/.exec(markdown);
    if (!m) throw new Error('no frontmatter');
    return parseYaml(m[1]!) as Record<string, unknown>;
  };

  const tricky = [
    "O'Brien",
    'Say "hi"',
    'Team: Ops',
    '[bot]',
    '{json}',
    '- dash lead',
    '#hash',
    '@mention',
    '&anchor',
    '*alias',
    '!tag',
    '|pipe',
    '>fold',
    '%pct',
    '`tick',
    '? q',
    'a, b',
    'trailing ',
    ' leading',
    'yes',
    'No',
    'y',
    'null',
    '~',
    '123',
    '1e3',
    '0x1F',
    '.inf',
    '2024-01-01',
    'back\\slash',
    'tab\there',
    'new\nline',
    '田中: 太郎',
    'Alice Doe',
    '',
  ];

  it('round-trips tricky participant, workspace and channel names through a YAML parser', () => {
    const users: Record<string, string> = {};
    const messages = tricky.map((name, i) => {
      users[`U${i}`] = name;
      return { ts: `${1700000000 + i}.000001`, user: `U${i}`, text: 'x' };
    });
    // Empty names fall back to the id; keep the expectation aligned with authorName().
    const expectedParticipants = tricky.map((name, i) => name || `U${i}`);

    for (const ws of tricky.filter(Boolean)) {
      const { markdown } = buildThreadMarkdown(
        threadData({ workspace: { name: ws }, channel: { id: 'C1', name: `${ws}"]` }, messages, users }),
        ALL,
        NOW,
      );
      const fm = frontmatterOf(markdown);
      expect(fm.workspace).toBe(ws);
      expect(fm.channel).toBe(`#${ws}"]`);
      expect(fm.participants).toEqual(expectedParticipants);
      expect(fm.messages).toBe(tricky.length);
      expect(fm.thread_url).toBe('https://papay.slack.com/archives/C0DEPLOY/p1700000000123456');
    }
  });

  it('quotes an unusual thread_url', () => {
    const { markdown } = buildThreadMarkdown(threadData({ threadUrl: 'https://x.slack.com/a #b' }), ALL, NOW);
    expect(frontmatterOf(markdown).thread_url).toBe('https://x.slack.com/a #b');
  });
});

describe('helpers', () => {
  it('authorName prefers bot username for bot_message', () => {
    const m: SlackMessage = { ts: '1', subtype: 'bot_message', bot_id: 'B1', bot_profile: { name: 'CI' } };
    expect(authorName(m, {})).toBe('CI');
    expect(authorName({ ts: '1', bot_id: 'B9' }, {})).toBe('bot B9');
  });

  it('makeTitle uses the first meaningful line and truncates to ~80 chars', () => {
    expect(makeTitle('**Hello** [world](https://x)\nsecond')).toBe('Hello world');
    expect(makeTitle('```\ncode\n```')).toBe('code');
    const long = 'あ'.repeat(100);
    const t = makeTitle(long);
    expect(Array.from(t)).toHaveLength(80);
    expect(t.endsWith('…')).toBe(true);
  });

  it('sanitizes filename parts, keeping unicode letters', () => {
    expect(sanitizeFilenamePart('#dev/deploy: prod?')).toBe('dev-deploy-prod');
    expect(sanitizeFilenamePart('#開発-チーム')).toBe('開発-チーム');
    expect(sanitizeFilenamePart('#../..')).toBe('channel');
  });

  it('yamlScalar quotes only when needed', () => {
    expect(yamlScalar('Alice Doe')).toBe('Alice Doe');
    expect(yamlScalar('田中 太郎')).toBe('田中 太郎');
    expect(yamlScalar('a, b')).toBe('"a, b"');
    expect(yamlScalar('yes')).toBe('"yes"');
    expect(yamlScalar('123')).toBe('"123"');
    expect(yamlScalar('[x]')).toBe('"[x]"');
    expect(yamlScalar('y')).toBe('"y"');
    expect(yamlScalar('1e3')).toBe('"1e3"');
    expect(yamlScalar('3 Musketeers')).toBe('"3 Musketeers"');
  });
});
