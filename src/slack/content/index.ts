// Content script for app.slack.com: adds "Send to Devdy" to Slack's own message
// menu (right-click on a message, or the message's "More actions" ⋮ button)
// and shows quick-send toasts.
//
// Debug: run `localStorage.setItem('context-kit-debug', '1')` on app.slack.com
// and reload to log what the script detects.

import {
  QUICK_SEND_TARGET,
  type QuickSendRequest,
  TOAST_TARGET,
  type ToastMessage,
} from '../../types/quick-send';
import { findMenu, findMessageElement, injectMenuItem, messageLink } from './message-dom';
import { Toaster } from '../../content/toast';

const MENU_LABEL = 'Send to Devdy';
/** A menu that appears this soon after a click/right-click on a message belongs to it. */
const TRIGGER_WINDOW_MS = 1500;
/** Ignore repeated clicks for the same thread. */
const RESEND_GUARD_MS = 3000;

const debugOn = (() => {
  try {
    return localStorage.getItem('context-kit-debug') === '1';
  } catch {
    return false;
  }
})();
const debug = (...args: unknown[]) => {
  if (debugOn) console.debug('[context-kit]', ...args);
};

let trigger: { link: string; at: number } | null = null;
let hoveredMessage: Element | null = null;
const recentSends = new Map<string, number>();

function extensionAlive(): boolean {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

const toaster = new Toaster((action) => {
  if (action === 'open-settings' && extensionAlive()) {
    const req: QuickSendRequest = { target: QUICK_SEND_TARGET, type: 'open-settings' };
    void chrome.runtime.sendMessage(req).catch(() => {});
  }
});

function linkFor(node: EventTarget | null): string | null {
  const msg = findMessageElement(node as Node | null);
  if (!msg) return null;
  return messageLink(msg, location.href);
}

function isMoreActionsButton(el: Element): boolean {
  const qa = el.getAttribute('data-qa') ?? '';
  const label = el.getAttribute('aria-label') ?? '';
  return /more_message_actions|more_actions|message_actions/i.test(qa) || /more actions|その他|thêm/i.test(label);
}

// Right-click on a message → Slack shows its own message menu.
document.addEventListener(
  'contextmenu',
  (e) => {
    const link = linkFor(e.target);
    trigger = link ? { link, at: Date.now() } : null;
    debug('contextmenu', link ?? '(not a message)');
  },
  true,
);

// Track the hovered message: Slack's hover toolbar (with "More actions") may be
// rendered outside the message element.
document.addEventListener(
  'mouseover',
  (e) => {
    const msg = findMessageElement(e.target as Node, false);
    if (msg) hoveredMessage = msg;
  },
  { capture: true, passive: true },
);

// Click on a message's "More actions" button → same menu.
document.addEventListener(
  'click',
  (e) => {
    const btn = (e.target as Element | null)?.closest?.('button, [role="button"]');
    if (!btn || btn.closest('[data-context-kit-item]')) return;
    let link = linkFor(btn);
    if (!link && hoveredMessage?.isConnected && isMoreActionsButton(btn)) link = messageLink(hoveredMessage, location.href);
    if (link) {
      trigger = { link, at: Date.now() };
      debug('menu button', link);
    }
  },
  true,
);

function send(link: string): void {
  const last = recentSends.get(link) ?? 0;
  if (Date.now() - last < RESEND_GUARD_MS) return;
  recentSends.set(link, Date.now());
  if (!extensionAlive()) {
    toaster.show({
      key: 'ext-reloaded',
      state: 'error',
      text: 'Context Kit was updated or reloaded. Reload this Slack tab and try again.',
    });
    return;
  }
  const req: QuickSendRequest = { target: QUICK_SEND_TARGET, type: 'devdy-send', link };
  chrome.runtime.sendMessage(req).catch((err: unknown) => {
    toaster.show({ key: `err-${link}`, state: 'error', text: `Could not reach Context Kit: ${String(err)}` });
  });
}

function closeSlackMenu(): void {
  const target = document.activeElement ?? document.body;
  for (const type of ['keydown', 'keyup'] as const) {
    target.dispatchEvent(new KeyboardEvent(type, { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
  }
}

// Inject into menus that open right after a message click/right-click.
new MutationObserver((mutations) => {
  if (!trigger || Date.now() - trigger.at > TRIGGER_WINDOW_MS) return;
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      const menu = findMenu(node);
      if (!menu || !trigger) continue;
      const { link } = trigger;
      const row = injectMenuItem(menu, MENU_LABEL, () => {
        closeSlackMenu();
        send(link);
      });
      debug(row ? 'injected into menu' : 'menu found but no item could be injected', link, menu);
      if (row) trigger = null;
    }
  }
}).observe(document.documentElement, { childList: true, subtree: true });

if (extensionAlive()) {
  chrome.runtime.onMessage.addListener((msg: ToastMessage) => {
    if (msg?.target === TOAST_TARGET) toaster.show(msg);
  });
}

debug('content script ready');
