// "Send to Devdy" from inside Slack (item injected into Slack's own message menu).
//
// content script ──QUICK_SEND_TARGET──▶ background   (start a send, open settings)
// background     ──TOAST_TARGET──────▶ content script (progress / result toast)

import type { ToastPayload } from '../../shared/toast';
import type { ExportOptions } from './messages';

export const QUICK_SEND_TARGET = 'context-kit-quick-send';
export const TOAST_TARGET = 'context-kit-toast';

/** Quick sends always include everything (reactions + attachments). */
export const QUICK_SEND_OPTIONS: ExportOptions = { includeReactions: true, includeFiles: true, zipFiles: true };

export type QuickSendRequest =
  | { target: typeof QUICK_SEND_TARGET; type: 'devdy-send'; link: string }
  | { target: typeof QUICK_SEND_TARGET; type: 'open-settings' };

export interface ToastMessage extends ToastPayload {
  target: typeof TOAST_TARGET;
}
