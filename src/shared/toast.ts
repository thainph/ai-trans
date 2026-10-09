// Devdy toasts shown inside web pages (Slack quick send, selection send).
// Rendered in a Shadow DOM so the page's CSS can't affect them (and ours
// can't leak into the page).

import type { ToastMessage } from '../features/slack/quick-send-messages';

const AUTO_HIDE_MS: Record<ToastMessage['state'], number | null> = {
  progress: null,
  success: 4000,
  queued: 7000,
  error: 12000,
};

const CSS = `
  :host { all: initial; }
  .stack {
    position: fixed; right: 20px; bottom: 20px; z-index: 2147483647;
    display: flex; flex-direction: column; gap: 8px; align-items: flex-end;
    font-family: "Inter", system-ui, -apple-system, "Segoe UI", sans-serif;
    pointer-events: none;
  }
  .toast {
    pointer-events: auto;
    display: flex; align-items: flex-start; gap: 10px;
    width: 340px; box-sizing: border-box; padding: 12px 14px;
    background: #fff; color: #0f172a;
    border: 1px solid #e2e8f0; border-left: 4px solid #2563eb; border-radius: 10px;
    box-shadow: 0 8px 24px rgba(15, 23, 42, 0.16);
    font-size: 13px; line-height: 1.45;
    animation: in 180ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  .toast.success { border-left-color: #16a34a; }
  .toast.queued { border-left-color: #f59e0b; }
  .toast.error { border-left-color: #dc2626; }
  .icon { flex-shrink: 0; width: 18px; height: 18px; margin-top: 1px; }
  .body { flex: 1; min-width: 0; }
  .title { font-weight: 600; margin-bottom: 2px; }
  .text { color: #475569; word-break: break-word; }
  .actions { margin-top: 8px; }
  .btn {
    padding: 5px 10px; border: 1px solid #2563eb; border-radius: 6px;
    background: #2563eb; color: #fff; font: inherit; font-size: 12px; font-weight: 600; cursor: pointer;
  }
  .close {
    flex-shrink: 0; border: none; background: none; color: #94a3b8;
    font-size: 16px; line-height: 1; cursor: pointer; padding: 0 2px;
  }
  .close:hover { color: #0f172a; }
  .spinner {
    width: 16px; height: 16px; border: 2px solid #bfdbfe; border-top-color: #2563eb;
    border-radius: 50%; animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
`;

const ICONS: Record<Exclude<ToastMessage['state'], 'progress'>, string> = {
  success:
    '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
  queued:
    '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  error:
    '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="#dc2626" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
};

const TITLES: Record<ToastMessage['state'], string> = {
  progress: 'Sending to Devdy',
  success: 'Devdy',
  queued: 'Queued for Devdy',
  error: 'Could not send to Devdy',
};

export class Toaster {
  private stack: HTMLElement | null = null;
  private readonly toasts = new Map<string, { el: HTMLElement; timer?: number }>();

  constructor(
    private readonly onAction: (action: NonNullable<ToastMessage['action']>) => void,
    /** Distinct per content script (Slack + page scripts both run on app.slack.com). */
    private readonly hostId = 'context-kit-toast-host',
  ) {}

  private ensureStack(): HTMLElement {
    if (this.stack?.isConnected) return this.stack;
    const host = document.createElement('div');
    host.id = this.hostId;
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${CSS}</style><div class="stack" role="status" aria-live="polite"></div>`;
    document.documentElement.appendChild(host);
    this.stack = root.querySelector('.stack')!;
    return this.stack;
  }

  show(msg: Pick<ToastMessage, 'key' | 'state' | 'text' | 'action'>): void {
    const stack = this.ensureStack();
    let entry = this.toasts.get(msg.key);
    if (!entry) {
      entry = { el: document.createElement('div') };
      this.toasts.set(msg.key, entry);
      stack.appendChild(entry.el);
    }
    const { el } = entry;
    el.className = `toast ${msg.state}`;
    el.innerHTML = `
      ${msg.state === 'progress' ? '<div class="spinner icon"></div>' : ICONS[msg.state]}
      <div class="body"><div class="title"></div><div class="text"></div><div class="actions" hidden></div></div>
      <button class="close" aria-label="Dismiss">✕</button>`;
    el.querySelector('.title')!.textContent = TITLES[msg.state];
    el.querySelector('.text')!.textContent = msg.text;
    el.querySelector('.close')!.addEventListener('click', () => this.dismiss(msg.key));
    if (msg.action === 'open-settings') {
      const actions = el.querySelector<HTMLElement>('.actions')!;
      actions.hidden = false;
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.textContent = 'Open settings';
      btn.addEventListener('click', () => {
        this.onAction('open-settings');
        this.dismiss(msg.key);
      });
      actions.appendChild(btn);
    }

    if (entry.timer) clearTimeout(entry.timer);
    const hideAfter = AUTO_HIDE_MS[msg.state];
    entry.timer = hideAfter ? window.setTimeout(() => this.dismiss(msg.key), hideAfter) : undefined;
  }

  dismiss(key: string): void {
    const entry = this.toasts.get(key);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.el.remove();
    this.toasts.delete(key);
  }
}
