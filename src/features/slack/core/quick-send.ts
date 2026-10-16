// Pure helpers for quick sends (unit-tested).

import type { ToastState } from '../../../shared/toast';
import type { DeliveryResult } from '../../devdy/api';
import { TOAST_TARGET, type ToastMessage } from '../quick-send-messages';

/** Toast shown inside Slack for the result of sending a thread link (Inbox API §9.2). */
export function toastForDelivery(d: Pick<DeliveryResult, 'outcome' | 'message'>, key: string): ToastMessage {
  const t = (state: ToastState, action?: ToastMessage['action']): ToastMessage => ({
    target: TOAST_TARGET,
    key,
    state,
    text: d.message,
    ...(action ? { action } : {}),
  });
  const o = d.outcome;
  switch (o.kind) {
    case 'created':
    case 'existing':
      // Saved, but Devdy can't fetch it yet (no Slack token): a warning, not a success.
      return t(o.errorCode ? 'queued' : 'success');
    case 'unreachable':
      return t('queued');
    case 'choose_instance':
    case 'token_missing':
      return t('queued', 'open-settings');
    case 'unauthorized':
      return t('error', 'open-settings');
    case 'outdated':
    case 'rejected':
      return t('error');
  }
}
