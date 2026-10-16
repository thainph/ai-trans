// Content script for app.slack.com: adds "Send to Devdy" to Slack's own message
// menu (right-click on a message, or the message's "More actions" ⋮ button)
// and shows quick-send toasts. Only the thread's permalink is sent (built from
// the DOM / the page URL; workspace host from the page's permalinks, else
// Slack's localConfig_v2); Devdy fetches and translates the thread itself.
//
// Debug: run `localStorage.setItem('context-kit-debug', '1')` on app.slack.com
// and reload to log what the script detects.

import { isExtensionAlive } from '../../../shared/runtime';
import { Toaster } from '../../../shared/toast';
import { type ThreadLinkResult, workspaceHostFromLocalConfig } from '../core/thread-link';
import { QUICK_SEND_TARGET, type QuickSendRequest, TOAST_TARGET, type ToastMessage } from '../quick-send-messages';
import { findMenu, findMessageElement, injectMenuItem, threadLinkFor, workspaceHostFromPage } from './message-dom';

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

let trigger: { link: ThreadLinkResult; at: number } | null = null;
let hoveredMessage: Element | null = null;
const recentSends = new Map<string, number>();

const toaster = new Toaster((action) => {
  if (action === 'open-settings' && isExtensionAlive()) {
    const req: QuickSendRequest = { target: QUICK_SEND_TARGET, type: 'open-settings' };
    void chrome.runtime.sendMessage(req).catch(() => {});
  }
});

/** Workspace host per team id ('' = no team in the URL), once found. */
const hostCache = new Map<string, string>();

/**
 * Workspace host of the team in the client URL: the page's own timestamp
 * permalinks / URL first, then `url`/`domain` of the team in Slack's
 * localConfig_v2 (parsed without its tokens). The result stays in this script.
 */
function hostForTeam(teamId: string | undefined): string | null {
  const key = teamId ?? '';
  const cached = hostCache.get(key);
  if (cached) return cached;
  let host = workspaceHostFromPage(document, location.href);
  if (!host) {
    try {
      host = workspaceHostFromLocalConfig(localStorage.getItem('localConfig_v2'), teamId);
    } catch {
      host = null;
    }
  }
  if (host) hostCache.set(key, host);
  return host;
}

function linkOf(msg: Element): ThreadLinkResult | null {
  return threadLinkFor(msg, location.href, hostForTeam);
}

function linkFor(node: EventTarget | null): ThreadLinkResult | null {
  const msg = findMessageElement(node as Node | null);
  return msg ? linkOf(msg) : null;
}

const describeLink = (l: ThreadLinkResult) => (l.ok ? l.url : `(${l.error})`);

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
    debug('contextmenu', link ? describeLink(link) : '(not a message)');
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
    if (!link && hoveredMessage?.isConnected && isMoreActionsButton(btn)) link = linkOf(hoveredMessage);
    if (link) {
      trigger = { link, at: Date.now() };
      debug('menu button', describeLink(link));
    }
  },
  true,
);

function send(result: ThreadLinkResult): void {
  if (!result.ok) {
    // DMs (Devdy can't fetch them) and links we couldn't build: say so, send nothing.
    toaster.show({ key: `link-${result.error}`, state: 'error', text: result.message });
    return;
  }
  const link = result.url;
  const last = recentSends.get(link) ?? 0;
  if (Date.now() - last < RESEND_GUARD_MS) return;
  recentSends.set(link, Date.now());
  if (!isExtensionAlive()) {
    toaster.show({
      key: 'ext-reloaded',
      state: 'error',
      text: 'AI Trans was updated or reloaded. Reload this Slack tab and try again.',
    });
    return;
  }
  const req: QuickSendRequest = { target: QUICK_SEND_TARGET, type: 'devdy-send', url: link };
  chrome.runtime
    .sendMessage(req)
    .then((res: { ok: boolean; error?: string } | undefined) => {
      if (res && !res.ok) toaster.show({ key: `err-${link}`, state: 'error', text: res.error ?? 'Not sent.' });
    })
    .catch((err: unknown) => {
      toaster.show({ key: `err-${link}`, state: 'error', text: `Could not reach AI Trans: ${String(err)}` });
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
      debug(row ? 'injected into menu' : 'menu found but no item could be injected', describeLink(link), menu);
      if (row) trigger = null;
    }
  }
}).observe(document.documentElement, { childList: true, subtree: true });

if (isExtensionAlive()) {
  chrome.runtime.onMessage.addListener((msg: ToastMessage) => {
    if (msg?.target === TOAST_TARGET) toaster.show(msg);
  });
}

debug('content script ready');
