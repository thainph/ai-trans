// DOM helpers for Slack's web client (app.slack.com). Kept free of chrome.*
// so they can be unit-tested against HTML fixtures.
//
// Slack's markup is not a public API. Every lookup therefore tries several
// selectors, most stable first: `data-qa` attributes (Slack's own test hooks),
// then `c-*` class names, then generic ARIA roles. When nothing matches we do
// nothing (Slack's menu stays untouched) — threads can still be sent from the
// Slack tab of the popup.

import { parseThreadLink } from '../core/permalink';

const MESSAGE_SELECTORS = [
  '[data-qa="message_container"]',
  '[data-qa="virtual-list-item"]',
  '.c-message_kit__background',
  '.c-message_kit__message',
  '.c-virtual_list__item',
  '[data-msg-ts]',
  '[data-item-key]',
];

const TS_RE = /^\d{9,10}\.\d{6}$/;
const PERMALINK_RE = /\/archives\/[CGD][A-Z0-9]+\/p\d{16}/;

/**
 * The Slack message element containing `node`, if any. `deep` enables a slower
 * last-resort ancestor scan (off for high-frequency events like mouseover).
 */
export function findMessageElement(node: Node | null, deep = true): Element | null {
  const el = node instanceof Element ? node : node?.parentElement ?? null;
  if (!el) return null;
  for (const sel of MESSAGE_SELECTORS) {
    const m = el.closest(sel);
    if (m && messageTs(m)) return m;
  }
  if (!deep) return null;
  // Last resort: any ancestor that has a permalink timestamp inside it.
  for (let cur: Element | null = el; cur && cur !== el.ownerDocument.body; cur = cur.parentElement) {
    if (cur.querySelector('a.c-timestamp[href*="/archives/"], [data-qa="timestamp"] a[href*="/archives/"]')) return cur;
  }
  return null;
}

/** Message timestamp ("1700000000.123456") from attributes on/inside the message. */
export function messageTs(msg: Element): string | null {
  const attrs = ['data-msg-ts', 'data-ts', 'data-item-key'];
  for (const a of attrs) {
    const v = msg.getAttribute(a);
    if (v && TS_RE.test(v)) return v;
  }
  for (const a of attrs) {
    const inner = msg.querySelector(`[${a}]`)?.getAttribute(a);
    if (inner && TS_RE.test(inner)) return inner;
  }
  const href = permalinkAnchor(msg)?.getAttribute('href');
  const p = href?.match(/\/p(\d{10})(\d{6})/);
  return p ? `${p[1]}.${p[2]}` : null;
}

function permalinkAnchor(msg: Element): HTMLAnchorElement | null {
  const candidates = msg.querySelectorAll<HTMLAnchorElement>(
    'a.c-timestamp, [data-qa="timestamp"] a, a[data-qa="message_timestamp"], a[href*="/archives/"]',
  );
  for (const a of candidates) {
    if (PERMALINK_RE.test(a.getAttribute('href') ?? '')) return a;
  }
  return null;
}

/**
 * Thread link for a message:
 * 1. its timestamp permalink (`…/archives/C…/p…`, with `?thread_ts=` for replies);
 * 2. otherwise built from the message ts and the client URL
 *    (`/client/T…/C…` or an open thread `/client/T…/C…/thread/C…-ts`).
 */
export function messageLink(msg: Element, pageUrl: string): string | null {
  const anchor = permalinkAnchor(msg);
  if (anchor) {
    const href = new URL(anchor.getAttribute('href')!, pageUrl).toString();
    if (parseThreadLink(href).ok) return href;
  }

  const ts = messageTs(msg);
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return null;
  }
  const seg = url.pathname.split('/').filter(Boolean);
  if (url.hostname !== 'app.slack.com' || seg[0] !== 'client' || !seg[1]) return null;
  const team = seg[1];

  // A message inside the thread side pane belongs to the open thread.
  const inThreadPane = !!msg.closest('[data-qa="threads_flexpane"], .p-threads_flexpane, [data-qa="thread_view"]');
  const threadIdx = seg.indexOf('thread');
  if (inThreadPane && threadIdx > 0 && seg[threadIdx + 1]) {
    const link = `https://app.slack.com/client/${team}/${seg[2] ?? ''}/thread/${seg[threadIdx + 1]}`;
    if (parseThreadLink(link).ok) return link;
  }

  const channel = channelIdFor(msg) ?? seg[2];
  if (!ts || !channel) return null;
  const link = `https://app.slack.com/client/${team}/${channel}/thread/${channel}-${ts}`;
  return parseThreadLink(link).ok ? link : null;
}

function channelIdFor(msg: Element): string | null {
  const holder = msg.closest('[data-qa-channel-id], [data-channel-id]');
  const v = holder?.getAttribute('data-qa-channel-id') ?? holder?.getAttribute('data-channel-id');
  return v && /^[CGD][A-Z0-9]+$/.test(v) ? v : null;
}

// ---------------------------------------------------------------------------
// Menu injection
// ---------------------------------------------------------------------------

export const INJECTED_ATTR = 'data-context-kit-item';
const COPY_LINK_RE = /copy link|copy message link|リンクをコピー|sao chép liên kết|复制链接/i;

/** The Slack menu element in/under `node` (a freshly rendered popover). */
export function findMenu(node: Node): Element | null {
  if (!(node instanceof Element)) return null;
  const sel = '[role="menu"], [data-qa="menu"], .c-menu';
  if (node.matches(sel)) return node;
  return node.querySelector(sel);
}

/** Outermost wrapper of a menu item that contains no other item (its "row"). */
function itemRow(item: Element, menu: Element): Element {
  let row = item;
  while (row.parentElement && row.parentElement !== menu && menuItems(row.parentElement).length <= 1) {
    row = row.parentElement;
  }
  return row;
}

function menuItems(menu: Element): Element[] {
  const items = [...menu.querySelectorAll('[role="menuitem"], [data-qa="menu_item_button"], .c-menu_item__button')];
  // Keep outermost matches only (a button inside a menuitem row counts once).
  return items.filter((el) => !items.some((other) => other !== el && other.contains(el)));
}

/**
 * Insert a "Send to Devdy" row into `menu`, styled by cloning an existing row.
 * Placed right after "Copy link" when present, otherwise at the end.
 * Returns the inserted row, or null when the menu has no usable item / already has ours.
 */
export function injectMenuItem(menu: Element, label: string, onSelect: () => void): Element | null {
  if (menu.querySelector(`[${INJECTED_ATTR}]`)) return null;
  const items = menuItems(menu).filter((el) => !el.closest(`[${INJECTED_ATTR}]`));
  const template = items.find((el) => !el.hasAttribute('aria-disabled') && !el.hasAttribute('disabled')) ?? items[0];
  if (!template) return null;

  const templateRow = itemRow(template, menu);
  const row = templateRow.cloneNode(true) as Element;
  row.setAttribute(INJECTED_ATTR, '');
  for (const el of [row, ...row.querySelectorAll('*')]) {
    el.removeAttribute('id');
    el.removeAttribute('aria-checked');
    el.removeAttribute('aria-disabled');
    el.removeAttribute('disabled');
    el.removeAttribute('aria-describedby');
    // The template may be the row Slack is highlighting right now.
    el.classList.remove(...[...el.classList].filter((c) => HIGHLIGHT_TOKEN_RE.test(c)));
    // Drop Slack's data-* hooks (indexes, keys…) so Slack's own code never
    // mistakes the clone for one of its rows; keep a data-qa marker for styling.
    const hadQa = el.hasAttribute('data-qa');
    for (const attr of [...el.attributes]) {
      if (attr.name.startsWith('data-') && attr.name !== INJECTED_ATTR) el.removeAttribute(attr.name);
    }
    if (hadQa) el.setAttribute('data-qa', 'context-kit-send-to-devdy');
  }
  setLabel(row, label);
  row.querySelectorAll('.c-menu_item__shortcut, [data-qa="menu_item_shortcut"], kbd').forEach((k) => {
    k.remove();
  });

  const clickable = row.matches('[role="menuitem"], button') ? row : row.querySelector('[role="menuitem"], button') ?? row;
  clickable.setAttribute('role', 'menuitem');
  clickable.setAttribute('tabindex', '-1');
  const activate = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    onSelect();
  };
  clickable.addEventListener('click', activate, true);
  enableHoverHighlight(menu, row, clickable);
  clickable.addEventListener('keydown', (e) => {
    const key = (e as KeyboardEvent).key;
    if (key === 'Enter' || key === ' ') activate(e);
  });

  const copyLink = items.find((el) => COPY_LINK_RE.test(el.textContent ?? ''));
  const anchorRow = copyLink ? itemRow(copyLink, menu) : null;
  if (anchorRow?.parentElement) anchorRow.after(row);
  else templateRow.parentElement!.appendChild(row);
  return row;
}

/** Replace the visible text of a cloned row with `label` (keeps icons/markup). */
function setLabel(row: Element, label: string): void {
  const labelEl =
    row.querySelector('.c-menu_item__label, [data-qa="menu_item_label"]') ??
    [...row.querySelectorAll('*')].reverse().find((el) => el.children.length === 0 && el.textContent?.trim());
  if (labelEl) labelEl.textContent = label;
  else row.textContent = label;
}

// ---------------------------------------------------------------------------
// Hover highlight
// ---------------------------------------------------------------------------
// Slack highlights menu rows from React state (a "--highlighted"-style class
// added on mouseenter), not with CSS :hover, so a cloned row never lights up
// by itself. We mirror that: borrow the highlight class from the row Slack is
// currently highlighting (and take it away from that row), or fall back to
// Slack's known class / its highlight colour.

const HIGHLIGHT_TOKEN_RE = /(?:--|__|-|_)(?:highlighted|highlight|active|selected|focused|hover(?:ed)?)$/i;
const SLACK_HIGHLIGHT_CLASS = 'c-menu_item__button--highlighted';
export const FALLBACK_HIGHLIGHT_ATTR = 'data-context-kit-highlight';

/** Elements of other menu rows that currently carry highlight classes. */
export function findHighlighted(menu: Element, except: Element): { el: Element; tokens: string[] }[] {
  const found: { el: Element; tokens: string[] }[] = [];
  for (const item of menuItems(menu)) {
    if (except.contains(item)) continue;
    for (const el of [item, ...item.querySelectorAll('*')]) {
      const tokens = [...el.classList].filter((c) => HIGHLIGHT_TOKEN_RE.test(c));
      if (tokens.length) found.push({ el, tokens });
    }
  }
  return found;
}

function enableHoverHighlight(menu: Element, row: Element, clickable: Element): void {
  let added: string[] = [];
  let borrowed: { el: Element; tokens: string[] }[] = [];

  const on = () => {
    const highlighted = findHighlighted(menu, row);
    const tokens = new Set(highlighted.flatMap((h) => h.tokens));
    // Only one row should look highlighted: take it away from Slack's row
    // (given back on leave — React won't re-add it if its state didn't change).
    for (const h of highlighted) h.el.classList.remove(...h.tokens);
    borrowed = highlighted;
    if (tokens.size === 0 && clickable.classList.contains('c-menu_item__button')) tokens.add(SLACK_HIGHLIGHT_CLASS);

    const before = getComputedStyle(clickable).backgroundColor;
    added = [...tokens].filter((t) => !clickable.classList.contains(t));
    clickable.classList.add(...added);
    // Class had no visible effect (or none was found) → paint it ourselves.
    if (getComputedStyle(clickable).backgroundColor === before) {
      clickable.setAttribute(FALLBACK_HIGHLIGHT_ATTR, '');
      (clickable as HTMLElement).style.setProperty('background', 'var(--sk_highlight, #1264a3)', 'important');
      (clickable as HTMLElement).style.setProperty('color', '#fff', 'important');
    }
  };
  const off = () => {
    clickable.classList.remove(...added);
    added = [];
    // If the pointer moves on to another Slack row, React re-renders both rows
    // and overrides this; if it goes back to the same row, the class is right.
    for (const h of borrowed) if (h.el.isConnected) h.el.classList.add(...h.tokens);
    borrowed = [];
    if (clickable.hasAttribute(FALLBACK_HIGHLIGHT_ATTR)) {
      clickable.removeAttribute(FALLBACK_HIGHLIGHT_ATTR);
      (clickable as HTMLElement).style.removeProperty('background');
      (clickable as HTMLElement).style.removeProperty('color');
    }
  };

  clickable.addEventListener('mouseenter', on);
  clickable.addEventListener('mouseleave', off);
  clickable.addEventListener('focus', on);
  clickable.addEventListener('blur', off);
}
