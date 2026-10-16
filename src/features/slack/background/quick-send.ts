// "Send to Devdy" without the popup, from the item the content script injects
// into Slack's own message menu: posts the thread link to Devdy (through the
// queue, so it is retried when Devdy is down) and shows the result as a toast
// inside the Slack tab.

import { errorMessage } from '../../../shared/errors';
import { onTargetMessage, type Result, sendToTab } from '../../../shared/messaging';
import { fromContentScriptOf } from '../../../shared/sender';
import { openSettings, outbox } from '../../devdy/api';
import { toastForDelivery } from '../core/quick-send';
import { DM_MESSAGE, isCanonicalThreadLink, normalizeThreadLink } from '../core/thread-link';
import { QUICK_SEND_TARGET, type QuickSendRequest, TOAST_TARGET, type ToastMessage } from '../quick-send-messages';

/** Quick sends are accepted only from the Slack content script (app.slack.com frames). */
const SLACK_APP_ORIGIN = 'https://app.slack.com';

/** Links currently being sent (avoid double sends from repeated clicks). */
const inFlight = new Set<string>();

const toast = (tabId: number, frameId: number | undefined, msg: ToastMessage) => sendToTab(tabId, frameId, msg);

export async function quickSend(url: string, tabId: number, frameId?: number): Promise<void> {
  const key = crypto.randomUUID();
  if (inFlight.has(url)) {
    toast(tabId, frameId, { target: TOAST_TARGET, key, state: 'progress', text: 'Already sending this thread…' });
    return;
  }
  inFlight.add(url);
  toast(tabId, frameId, { target: TOAST_TARGET, key, state: 'progress', text: 'Sending the thread link to Devdy…' });
  try {
    const delivery = await outbox.send(url);
    toast(tabId, frameId, toastForDelivery(delivery, key));
    // Wrong token: take the user straight to the Devdy tab to paste it again.
    if (delivery.outcome.kind === 'unauthorized') void openSettings();
  } catch (e) {
    toast(tabId, frameId, { target: TOAST_TARGET, key, state: 'error', text: `Could not send: ${errorMessage(e)}` });
  } finally {
    inFlight.delete(url);
  }
}

onTargetMessage<QuickSendRequest>(QUICK_SEND_TARGET, (msg, sender): Result | undefined => {
  // Sent by the Slack content script only (app.slack.com).
  if (!fromContentScriptOf(sender, SLACK_APP_ORIGIN)) return { ok: false, error: 'Not allowed.' };
  switch (msg.type) {
    case 'devdy-send': {
      const tabId = sender.tab?.id;
      if (tabId === undefined) return;
      // The content script sends canonical permalinks only; DMs never reach Devdy.
      if (!isCanonicalThreadLink(msg.url)) {
        const r = typeof msg.url === 'string' ? normalizeThreadLink(msg.url) : null;
        return { ok: false, error: r && !r.ok && r.error === 'dm' ? DM_MESSAGE : 'Invalid Slack thread link.' };
      }
      void quickSend(msg.url, tabId, sender.frameId);
      return { ok: true }; // accepted; progress/result arrive as toasts
    }
    case 'open-settings':
      void openSettings();
      return { ok: true };
  }
});
