// "Send to Devdy" from inside Slack (item injected into Slack's own message menu).
//
// content script ──QUICK_SEND_TARGET──▶ background   (start a send, open settings)
// background     ──TOAST_TARGET──────▶ content script (progress / result toast)

import type { ExportOptions } from './messages';

export const QUICK_SEND_TARGET = 'context-kit-quick-send';
export const TOAST_TARGET = 'context-kit-toast';

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
