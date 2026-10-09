// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toastFor } from '../src/features/slack/core/quick-send';
import {
  FALLBACK_HIGHLIGHT_ATTR,
  INJECTED_ATTR,
  findHighlighted,
  findMenu,
  findMessageElement,
  injectMenuItem,
  messageLink,
  messageTs,
} from '../src/features/slack/content/message-dom';

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

describe('messageLink', () => {
  it('prefers the timestamp permalink', () => {
    document.body.innerHTML = channelMessage;
    const msg = findMessageElement(document.getElementById('body1'))!;
    expect(messageLink(msg, CHANNEL_URL)).toBe('https://acme.slack.com/archives/C0DEV1234/p1700000000000100');
  });

  it('builds a client thread link from ts + channel id when there is no permalink', () => {
    document.body.innerHTML = noPermalinkMessage;
    const msg = findMessageElement(document.getElementById('body2'))!;
    expect(messageLink(msg, CHANNEL_URL)).toBe(
      'https://app.slack.com/client/T0TEAM/C0OTHER99/thread/C0OTHER99-1700000500.000900',
    );
  });

  it('uses the open thread for replies in the thread pane', () => {
    document.body.innerHTML = threadPane;
    const msg = findMessageElement(document.getElementById('reply'))!;
    expect(messageLink(msg, THREAD_URL)).toBe(THREAD_URL);
  });

  it('returns null when nothing usable is found', () => {
    document.body.innerHTML = noPermalinkMessage;
    const msg = findMessageElement(document.getElementById('body2'))!;
    expect(messageLink(msg, 'https://example.com/')).toBeNull();
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

describe('hover highlight on the injected row', () => {
  const hover = (el: Element, type: 'mouseenter' | 'mouseleave') => el.dispatchEvent(new MouseEvent(type));

  it('borrows Slack\'s highlight class from the highlighted row and gives it back on leave', () => {
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

  it('uses Slack\'s known class (or paints Slack\'s highlight colour) when nothing is highlighted', () => {
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
    document.body.innerHTML =
      '<style>.c-menu_item__button--highlighted { background-color: rgb(18, 100, 163); }</style>' + slackMenu();
    const menu = findMenu(document.body)!;
    const ours = injectMenuItem(menu, 'Send to Devdy', () => {})!.querySelector('button')!;
    hover(ours, 'mouseenter');
    expect(ours.classList.contains('c-menu_item__button--highlighted')).toBe(true);
    expect(ours.hasAttribute(FALLBACK_HIGHLIGHT_ATTR)).toBe(false);
  });
});

describe('quick-send helpers', () => {
  it('maps export results to toasts', () => {
    const base = { type: 'done' as const, action: 'devdy' as const, filename: 'a.md', messageCount: 3 };
    expect(toastFor({ type: 'progress', text: 'Fetching…' }, 'k')).toMatchObject({ state: 'progress', text: 'Fetching…' });
    expect(
      toastFor({ ...base, files: { saved: 2, notIncluded: 0 }, devdy: { kind: 'created', message: '', pending: 0 } }, 'k'),
    ).toMatchObject({ state: 'success', text: 'Sent to Devdy (3 messages, 2 files).' });
    expect(toastFor({ ...base, devdy: { kind: 'unreachable', message: 'queued', pending: 1 } }, 'k')?.state).toBe(
      'queued',
    );
    expect(toastFor({ ...base, devdy: { kind: 'no_token', message: 'set token', pending: 1 } }, 'k')).toMatchObject({
      state: 'error',
      action: 'open-settings',
    });
    expect(toastFor({ type: 'error', message: 'Open app.slack.com' }, 'k')?.state).toBe('error');
  });
});
