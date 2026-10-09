// "Send to Devdy" from inside Slack (injected menu item / browser context menu).
//
// content script ──QUICK_SEND_TARGET──▶ background   (start a send, open settings)
// background     ──TOAST_TARGET──────▶ content script (progress / result toast)
// background     ──CONTENT_TARGET────▶ content script (which message was right-clicked?)

import type { ExportOptions } from './messages';

export const QUICK_SEND_TARGET = 'context-kit-quick-send';
export const TOAST_TARGET = 'context-kit-toast';
export const CONTENT_TARGET = 'context-kit-slack-content';

/** Quick sends always include everything (reactions + attachments). */
export const QUICK_SEND_OPTIONS: ExportOptions = { includeReactions: true, includeFiles: true, zipFiles: true };

export type QuickSendRequest =
  | { target: typeof QUICK_SEND_TARGET; type: 'devdy-send'; link: string }
  | { target: typeof QUICK_SEND_TARGET; type: 'open-settings' };

export type ToastState = 'progress' | 'success' | 'queued' | 'error';

export interface ToastMessage {
  target: typeof TOAST_TARGET;
  /** One toast per send; later messages with the same key update it. */
  key: string;
  state: ToastState;
  text: string;
  /** Show an "Open settings" button (missing/invalid Devdy token). */
  action?: 'open-settings';
}

export type ContentQuery = { target: typeof CONTENT_TARGET; type: 'last-context-link' };
export interface ContentQueryResponse {
  /** Permalink of the message that was right-clicked last (if recent). */
  link?: string;
}
