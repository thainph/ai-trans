// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEVDY_ICON_ATTR } from '../src/features/slack/content/devdy-icon';
import {
  FALLBACK_HIGHLIGHT_ATTR,
  findHighlighted,
  findMenu,
  findMessageElement,
  INJECTED_ATTR,
  injectMenuItem,
  messageTs,
  threadLinkFor,
  workspaceHostFromPage,
} from '../src/features/slack/content/message-dom';
import { toastForDelivery } from '../src/features/slack/core/quick-send';

// Fixtures approximate Slack's web client markup (data-qa hooks + c-* classes).
const CHANNEL_URL = 'https://app.slack.com/client/T0TEAM/C0DEV1234';
const THREAD_URL = 'https://app.slack.com/client/T0TEAM/C0DEV1234/thread/C0DEV1234-1700000000.000100';

const channelMessage = `
  <div class="c-virtual_list__item" data-qa="virtual-list-item" data-item-key="1700000000.000100">
    <div class="c-message_kit__background" data-qa="message_container">
      <a class="c-timestamp" data-ts="1700000000.000100"
         href="https://acme.slack.com/archives/C0DEV1234/p1700000000000100"><span>9:00 AM</span></a>
      <div class="c-message_kit__blocks"><span id="body1">Deploy failed on staging</span></div>
      <div class="c-message_actions__container">
        <button id="more1" data-qa="more_message_actions" aria-label="More actions">⋮</button>
      </div>
    </div>
  </div>`;

const noPermalinkMessage = `
  <div data-qa-channel-id="C0OTHER99">
    <div class="c-virtual_list__item" data-item-key="1700000500.000900">
      <div class="c-message_kit__background"><span id="body2">no timestamp link here</span></div>
    </div>
  </div>`;

const threadPane = `
  <div data-qa="threads_flexpane">
    <div class="c-virtual_list__item" data-item-key="1700000100.000200">
      <div class="c-message_kit__background"><span id="reply">reply text</span></div>
    </div>
  </div>`;

const slackMenu = (withCopyLink = true) => `
  <div class="ReactModalPortal">
    <div role="menu" class="c-menu" data-qa="menu">
      <div class="c-menu__items">
        <div role="presentation" class="c-menu_item__li">
          <button role="menuitem" id="mi-1" class="c-menu_item__button" data-qa="menu_item_button">
            <span class="c-menu_item__icon">↩</span><span class="c-menu_item__label">Reply in thread</span>
            <span class="c-menu_item__shortcut">T</span>
          </button>
        </div>
        ${
          withCopyLink
            ? `<div role="presentation" class="c-menu_item__li">
                 <button role="menuitem" id="mi-2" class="c-menu_item__button" data-qa="copy_link">
                   <span class="c-menu_item__label">Copy link</span><span class="c-menu_item__shortcut">L</span>
                 </button>
               </div>`
            : ''
        }
        <div role="presentation" class="c-menu_item__li">
          <button role="menuitem" id="mi-3" class="c-menu_item__button" aria-disabled="true">
            <span class="c-menu_item__label">Delete message…</span>
          </button>
        </div>
      </div>
    </div>
  </div>`;

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('findMessageElement / messageTs', () => {
  it('finds the message from any node inside it, incl. the hover toolbar', () => {
    document.body.innerHTML = channelMessage;
    const msg = findMessageElement(document.getElementById('body1'));
    expect(msg?.getAttribute('data-qa')).toBe('message_container');
    expect(findMessageElement(document.getElementById('more1'))).toBe(msg);
    expect(messageTs(msg!)).toBe('1700000000.000100');
  });

  it('returns null outside messages', () => {
    document.body.innerHTML = `<div id="sidebar"><span id="x">#general</span></div>`;
    expect(findMessageElement(document.getElementById('x'))).toBeNull();
    expect(findMessageElement(null)).toBeNull();
  });
});

describe('threadLinkFor', () => {
  const hosts = (teamId: string | undefined) => (teamId === 'T0TEAM' ? 'acme.slack.com' : null);

  it('uses the timestamp permalink', () => {
    document.body.innerHTML = channelMessage;
    const msg = findMessageElement(document.getElementById('body1'))!;
    expect(threadLinkFor(msg, CHANNEL_URL, hosts)).toEqual({
      ok: true,
      url: 'https://acme.slack.com/archives/C0DEV1234/p1700000000000100',
    });
  });

  it('keeps thread_ts/cid of a reply permalink (normalized)', () => {
    document.body.innerHTML = channelMessage
      .replaceAll('1700000000.000100', '1700000100.000200')
      .replace('p1700000000000100"', 'p1700000100000200?thread_ts=1700000000.000100&amp;cid=C0DEV1234&amp;foo=bar"');
    const msg = findMessageElement(document.getElementById('body1'))!;
    expect(threadLinkFor(msg, CHANNEL_URL, hosts)).toEqual({
      ok: true,
      url: 'https://acme.slack.com/archives/C0DEV1234/p1700000100000200?thread_ts=1700000000.000100&cid=C0DEV1234',
    });
  });

  it('ignores another Slack permalink pasted in the message body', () => {
    document.body.innerHTML = `
      <div class="c-virtual_list__item" data-qa="virtual-list-item" data-item-key="1700000300.000300">
        <div class="c-message_kit__background" data-qa="message_container">
          <div class="c-message_kit__blocks"><div class="p-rich_text_section">see
            <a id="pasted" href="https://acme.slack.com/archives/C0OTHER99/p1690000000000001">this</a></div></div>
          <a class="c-timestamp" href="https://acme.slack.com/archives/C0DEV1234/p1700000300000300">9:05</a>
        </div>
      </div>`;
    const msg = findMessageElement(document.getElementById('pasted'))!;
    expect(messageTs(msg)).toBe('1700000300.000300');
    expect(threadLinkFor(msg, CHANNEL_URL, hosts)).toEqual({
      ok: true,
      url: 'https://acme.slack.com/archives/C0DEV1234/p1700000300000300',
    });
  });

  it('ignores the "View message" link of a shared-message unfurl', () => {
    document.body.innerHTML = `
      <div class="c-virtual_list__item" data-qa="virtual-list-item" data-item-key="1700000400.000400">
        <div class="c-message_kit__background" data-qa="message_container">
          <div class="c-message_kit__attachments"><div class="c-message_attachment">
            <a class="c-timestamp" href="https://other.slack.com/archives/C0SHARED1/p1680000000000002">Shared</a>
            <a id="view" href="https://other.slack.com/archives/C0SHARED1/p1680000000000002">View message</a>
          </div></div>
        </div>
      </div>`;
    const msg = findMessageElement(document.getElementById('view'))!;
    // No own timestamp anchor: built from the ts + channel + workspace host, never the unfurl's link.
    expect(threadLinkFor(msg, CHANNEL_URL, hosts)).toEqual({
      ok: true,
      url: 'https://acme.slack.com/archives/C0DEV1234/p1700000400000400',
    });
  });

  it('a continuation message without a header timestamp is built from its ts', () => {
    document.body.innerHTML = `
      <div class="c-virtual_list__item" data-qa="virtual-list-item" id="message-list_1700000500.000500">
        <div class="c-message_kit__background c-message_kit__message--continuation">
          <div class="c-message_kit__blocks"><span id="cont">follow-up
            <a href="https://acme.slack.com/archives/C0DEV1234/p1700000000000100">earlier</a></span></div>
        </div>
      </div>`;
    const msg = findMessageElement(document.getElementById('cont'))!;
    expect(messageTs(msg)).toBe('1700000500.000500');
    expect(threadLinkFor(msg, CHANNEL_URL, hosts)).toEqual({
      ok: true,
      url: 'https://acme.slack.com/archives/C0DEV1234/p1700000500000500',
    });
  });

  it('skips a timestamp anchor whose ts does not match the message', () => {
    document.body.innerHTML = channelMessage.replace('p1700000000000100"', 'p1690000000000009"');
    const msg = findMessageElement(document.getElementById('body1'))!;
    expect(threadLinkFor(msg, CHANNEL_URL, hosts)).toEqual({
      ok: true,
      url: 'https://acme.slack.com/archives/C0DEV1234/p1700000000000100',
    });
  });

  it('builds the root permalink from ts + channel id + workspace host when there is no permalink', () => {
    document.body.innerHTML = noPermalinkMessage;
    const msg = findMessageElement(document.getElementById('body2'))!;
    expect(threadLinkFor(msg, CHANNEL_URL, hosts)).toEqual({
      ok: true,
      url: 'https://acme.slack.com/archives/C0OTHER99/p1700000500000900',
    });
  });

  it('a reply in the open thread pane gets thread_ts (root) and cid', () => {
    document.body.innerHTML = threadPane;
    const msg = findMessageElement(document.getElementById('reply'))!;
    expect(threadLinkFor(msg, THREAD_URL, hosts)).toEqual({
      ok: true,
      url: 'https://acme.slack.com/archives/C0DEV1234/p1700000100000200?thread_ts=1700000000.000100&cid=C0DEV1234',
    });
  });

  it('rejects DM channels early', () => {
    document.body.innerHTML = noPermalinkMessage.replace('C0OTHER99', 'D0DIRECT9');
    const msg = findMessageElement(document.getElementById('body2'))!;
    expect(threadLinkFor(msg, CHANNEL_URL, hosts)).toMatchObject({ ok: false, error: 'dm' });
    document.body.innerHTML = channelMessage.replace(/C0DEV1234/g, 'D0DIRECT9');
    const msg2 = findMessageElement(document.getElementById('body1'))!;
    expect(threadLinkFor(msg2, CHANNEL_URL, hosts)).toMatchObject({ ok: false, error: 'dm' });
  });

  it('reports a missing workspace host, and null when nothing usable is found', () => {
    document.body.innerHTML = noPermalinkMessage;
    const msg = findMessageElement(document.getElementById('body2'))!;
    expect(threadLinkFor(msg, CHANNEL_URL, () => null)).toMatchObject({ ok: false, error: 'no_workspace' });
    expect(threadLinkFor(msg, 'https://example.com/', hosts)).toBeNull();
  });
});

describe('workspaceHostFromPage', () => {
  it('reads the host from timestamp permalinks, skipping message content', () => {
    document.body.innerHTML = `
      <div class="c-message_attachment"><a class="c-timestamp" href="https://other.slack.com/archives/C0SHARED1/p1680000000000002">x</a></div>
      <a class="c-timestamp" href="https://acme.enterprise.slack.com/archives/C0DEV1234/p1700000000000100">9:00</a>`;
    expect(workspaceHostFromPage(document, CHANNEL_URL)).toBe('acme.enterprise.slack.com');
    expect(workspaceHostFromPage(document, 'https://acme.slack.com/archives/C0DEV1234')).toBe('acme.slack.com');
    document.body.innerHTML = '<p>nothing</p>';
    expect(workspaceHostFromPage(document, CHANNEL_URL)).toBeNull();
  });
});

describe('injectMenuItem', () => {
  it('clones a Slack row and places it right after "Copy link"', () => {
    document.body.innerHTML = slackMenu();
    const menu = findMenu(document.body)!;
    const onSelect = vi.fn();
    const row = injectMenuItem(menu, 'Send to Devdy', onSelect)!;

    const labels = [...menu.querySelectorAll('.c-menu_item__label')].map((l) => l.textContent);
    expect(labels).toEqual(['Reply in thread', 'Copy link', 'Send to Devdy', 'Delete message…']);
    // Looks like Slack's rows, but is clean: no ids, no shortcut, not disabled.
    expect(row.classList.contains('c-menu_item__li')).toBe(true);
    expect(row.querySelector('[id]')).toBeNull();
    expect(row.querySelector('.c-menu_item__shortcut')).toBeNull();
    expect(row.querySelector('[aria-disabled]')).toBeNull();
    expect(row.querySelector('button')?.getAttribute('data-qa')).toBe('context-kit-send-to-devdy');
    expect(row.hasAttribute(INJECTED_ATTR)).toBe(true);

    row.querySelector('button')!.click();
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('does not inject twice and appends at the end without "Copy link"', () => {
    document.body.innerHTML = slackMenu(false);
    const menu = findMenu(document.body)!;
    expect(injectMenuItem(menu, 'Send to Devdy', () => {})).not.toBeNull();
    expect(injectMenuItem(menu, 'Send to Devdy', () => {})).toBeNull();
    expect(menu.querySelectorAll(`[${INJECTED_ATTR}]`)).toHaveLength(1);
    const last = [...menu.querySelectorAll('.c-menu_item__label')].at(-1);
    expect(last?.textContent).toBe('Send to Devdy');
  });

  it('activates with the keyboard', () => {
    document.body.innerHTML = slackMenu();
    const onSelect = vi.fn();
    const row = injectMenuItem(findMenu(document.body)!, 'Send to Devdy', onSelect)!;
    row.querySelector('button')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('works with a plain ARIA menu (no Slack classes)', () => {
    document.body.innerHTML = `<ul role="menu"><li role="menuitem">Mark unread</li><li role="menuitem">Copy link</li></ul>`;
    const menu = findMenu(document.body)!;
    injectMenuItem(menu, 'Send to Devdy', () => {});
    expect([...menu.children].map((c) => c.textContent)).toEqual(['Mark unread', 'Copy link', 'Send to Devdy']);
  });

  it('leaves menus without items alone', () => {
    document.body.innerHTML = `<div role="menu"><p>Loading…</p></div>`;
    expect(injectMenuItem(findMenu(document.body)!, 'Send to Devdy', () => {})).toBeNull();
  });
});

describe('icon of the injected row', () => {
  const menuWith = (rowInner: string) => `
    <div role="menu" class="c-menu" data-qa="menu">
      <div role="presentation" class="c-menu_item__li">
        <button role="menuitem" class="c-menu_item__button" data-qa="menu_item_button">${rowInner}</button>
      </div>
    </div>`;
  const svgIcon = (d: string) =>
    `<svg data-qa="${d}" viewBox="0 0 20 20" width="20" height="20" fill="currentColor"><path d="M${d}"/></svg>`;

  const variants: Record<string, string> = {
    'an svg icon in the icon slot': `<div class="c-menu_item__icon" data-qa="menu_item_icon">${svgIcon('1 1h2')}</div>
       <span class="c-menu_item__label">Reply in thread</span>`,
    'an icon-font span': `<span class="c-menu_item__icon"><i class="c-icon c-icon--reply" type="reply" aria-hidden="true"></i></span>
       <span class="c-menu_item__label">Reply in thread</span>`,
    'a text glyph in the icon slot': `<span class="c-menu_item__icon">↩</span><span class="c-menu_item__label">Reply</span>`,
    'an img icon': `<img class="c-emoji" src="https://a.slack-edge.com/x.png" alt=":+1:" width="18" height="18">
       <span class="c-menu_item__label">React</span>`,
    'a bare c-icon outside any slot': `<span class="c-icon c-icon--bookmark" type="bookmark" aria-hidden="true"></span>
       <span class="c-menu_item__label">Save for later</span>`,
    'two icons (leading + trailing)': `<div class="c-menu_item__icon">${svgIcon('2 2h2')}</div>
       <span class="c-menu_item__label">Remind me</span>${svgIcon('3 3h3')}`,
    'no icon at all': `<span class="c-menu_item__label">Copy link</span>`,
  };

  for (const [name, inner] of Object.entries(variants)) {
    it(`always shows exactly our ➤ icon (template row with ${name})`, () => {
      document.body.innerHTML = menuWith(inner);
      const row = injectMenuItem(findMenu(document.body)!, 'Send to Devdy', () => {})!;
      const icons = row.querySelectorAll('svg, img, i, .c-icon, [class*="c-icon--"]');
      expect(icons).toHaveLength(1);
      const icon = icons[0]!;
      expect(icon.hasAttribute(DEVDY_ICON_ATTR)).toBe(true);
      expect(icon.getAttribute('aria-hidden')).toBe('true');
      expect(icon.getAttribute('stroke')).toBe('currentColor');
      expect(icon.querySelector('polygon')?.getAttribute('points')).toBe('22 2 15 22 11 13 2 9 22 2');
      expect(row.textContent?.trim()).toBe('Send to Devdy');
      expect(row.querySelector('.c-menu_item__label')?.textContent).toBe('Send to Devdy');
      // The icon comes before the label, whatever the template looked like.
      const label = row.querySelector('.c-menu_item__label')!;
      expect(icon.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  }

  it("reuses Slack's icon slot and matches the template icon size", () => {
    document.body.innerHTML = menuWith(variants['an svg icon in the icon slot']!);
    const row = injectMenuItem(findMenu(document.body)!, 'Send to Devdy', () => {})!;
    const slot = row.querySelector('.c-menu_item__icon')!;
    expect(slot.children).toHaveLength(1);
    expect(slot.firstElementChild?.hasAttribute(DEVDY_ICON_ATTR)).toBe(true);
    expect(slot.firstElementChild?.getAttribute('width')).toBe('20');
  });

  it('adds the icon before the label when the template has no icon slot', () => {
    document.body.innerHTML = menuWith(variants['no icon at all']!);
    const row = injectMenuItem(findMenu(document.body)!, 'Send to Devdy', () => {})!;
    const label = row.querySelector('.c-menu_item__label')!;
    expect(label.previousElementSibling?.querySelector(`[${DEVDY_ICON_ATTR}]`)).not.toBeNull();
    expect(row.querySelector(`[${DEVDY_ICON_ATTR}]`)?.getAttribute('width')).toBe('16');
  });

  it('gives the same icon to every menu, whatever the template row', () => {
    const shapes = Object.values(variants).map((inner) => {
      document.body.innerHTML = menuWith(inner);
      const row = injectMenuItem(findMenu(document.body)!, 'Send to Devdy', () => {})!;
      return row.querySelector(`[${DEVDY_ICON_ATTR}]`)!.innerHTML;
    });
    expect(new Set(shapes).size).toBe(1);
  });

  it('adds an icon to plain ARIA menus too', () => {
    document.body.innerHTML = `<ul role="menu"><li role="menuitem">Mark unread</li></ul>`;
    const row = injectMenuItem(findMenu(document.body)!, 'Send to Devdy', () => {})!;
    expect(row.querySelectorAll('svg')).toHaveLength(1);
    expect(row.textContent).toBe('Send to Devdy');
  });
});

describe('hover highlight on the injected row', () => {
  const hover = (el: Element, type: 'mouseenter' | 'mouseleave') => el.dispatchEvent(new MouseEvent(type));

  it("borrows Slack's highlight class from the highlighted row and gives it back on leave", () => {
    document.body.innerHTML = slackMenu();
    const menu = findMenu(document.body)!;
    const slackRow = menu.querySelector('#mi-1')!;
    slackRow.classList.add('c-menu_item__button--highlighted'); // React highlighted "Reply in thread"
    const ours = injectMenuItem(menu, 'Send to Devdy', () => {})!.querySelector('button')!;

    hover(ours, 'mouseenter');
    expect(ours.classList.contains('c-menu_item__button--highlighted')).toBe(true);
    expect(slackRow.classList.contains('c-menu_item__button--highlighted')).toBe(false);

    hover(ours, 'mouseleave');
    expect(ours.classList.contains('c-menu_item__button--highlighted')).toBe(false);
    expect(slackRow.classList.contains('c-menu_item__button--highlighted')).toBe(true);
  });

  it("uses Slack's known class (or paints Slack's highlight colour) when nothing is highlighted", () => {
    document.body.innerHTML = slackMenu();
    const menu = findMenu(document.body)!;
    const ours = injectMenuItem(menu, 'Send to Devdy', () => {})!.querySelector('button')! as HTMLElement;
    expect(findHighlighted(menu, ours)).toEqual([]);

    hover(ours, 'mouseenter');
    expect(ours.classList.contains('c-menu_item__button--highlighted')).toBe(true);
    // No Slack stylesheet in the test → the class has no visible effect → inline fallback.
    expect(ours.hasAttribute(FALLBACK_HIGHLIGHT_ATTR)).toBe(true);
    expect(ours.style.getPropertyValue('background')).toContain('--sk_highlight');

    hover(ours, 'mouseleave');
    expect(ours.classList.contains('c-menu_item__button--highlighted')).toBe(false);
    expect(ours.hasAttribute(FALLBACK_HIGHLIGHT_ATTR)).toBe(false);
    expect(ours.style.getPropertyValue('background')).toBe('');
  });

  it('skips the inline fallback when the borrowed class already changes the background', () => {
    document.body.innerHTML = `<style>.c-menu_item__button--highlighted { background-color: rgb(18, 100, 163); }</style>${slackMenu()}`;
    const menu = findMenu(document.body)!;
    const ours = injectMenuItem(menu, 'Send to Devdy', () => {})!.querySelector('button')!;
    hover(ours, 'mouseenter');
    expect(ours.classList.contains('c-menu_item__button--highlighted')).toBe(true);
    expect(ours.hasAttribute(FALLBACK_HIGHLIGHT_ATTR)).toBe(false);
  });
});

describe('quick-send toasts', () => {
  const toast = (outcome: Parameters<typeof toastForDelivery>[0]['outcome'], message = 'm') =>
    toastForDelivery({ outcome, message }, 'k');

  it('maps delivery results to toast states and actions', () => {
    expect(toast({ kind: 'created', id: 'x' }, 'Sent')).toEqual({
      target: 'context-kit-toast',
      key: 'k',
      state: 'success',
      text: 'Sent',
    });
    expect(toast({ kind: 'existing', id: 'x' }).state).toBe('success');
    expect(toast({ kind: 'created', id: 'x', errorCode: 'no_token' }).state).toBe('queued');
    expect(toast({ kind: 'unreachable', message: 'down' }).state).toBe('queued');
    expect(toast({ kind: 'choose_instance', message: 'm' })).toMatchObject({
      state: 'queued',
      action: 'open-settings',
    });
    expect(toast({ kind: 'token_missing', message: 'm' })).toMatchObject({ state: 'queued', action: 'open-settings' });
    expect(toast({ kind: 'unauthorized', message: 'm' })).toMatchObject({ state: 'error', action: 'open-settings' });
    expect(toast({ kind: 'outdated', status: 415, message: 'm' }).state).toBe('error');
    expect(toast({ kind: 'rejected', status: 400, code: 'dm_unsupported', message: 'm' })).not.toHaveProperty('action');
  });
});
