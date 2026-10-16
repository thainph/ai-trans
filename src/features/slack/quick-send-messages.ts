// "Send to Devdy" from inside Slack (item injected into Slack's own message menu).
//
// content script ──QUICK_SEND_TARGET──▶ background   (send a thread link, open settings)
// background     ──TOAST_TARGET──────▶ content script (progress / result toast)

import type { ToastPayload } from '../../shared/toast';

export const QUICK_SEND_TARGET = 'context-kit-quick-send';
export const TOAST_TARGET = 'context-kit-toast';

export type QuickSendRequest =
  /** `url`: canonical thread permalink (core/thread-link.ts). */
  | { target: typeof QUICK_SEND_TARGET; type: 'devdy-send'; url: string }
  | { target: typeof QUICK_SEND_TARGET; type: 'open-settings' };

export interface ToastMessage extends ToastPayload {
  target: typeof TOAST_TARGET;
}
