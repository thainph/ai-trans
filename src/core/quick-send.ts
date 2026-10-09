// Pure helpers for quick sends (unit-tested).

import type { ExportResponse } from '../types/messages';
import { TOAST_TARGET, type ToastMessage, type ToastState } from '../types/quick-send';

/** Map an export response to the toast shown inside Slack (null = no change). */
export function toastFor(msg: ExportResponse, key: string): ToastMessage | null {
  const t = (state: ToastState, text: string, action?: ToastMessage['action']): ToastMessage => ({
    target: TOAST_TARGET,
    key,
    state,
    text,
    ...(action ? { action } : {}),
  });
  if (msg.type === 'progress') return t('progress', msg.text);
  if (msg.type === 'error') return t('error', msg.message);
  if (msg.action !== 'devdy') return null;

  const d = msg.devdy;
  const extra = msg.warning ? ` ${msg.warning}` : '';
  switch (d.kind) {
    case 'created':
      return t('success', `Sent to Devdy (${msg.messageCount} messages${filesNote(msg.files)}).${extra}`);
    case 'updated':
      return t('success', `Updated in Devdy (${msg.messageCount} messages${filesNote(msg.files)}).${extra}`);
    case 'unreachable':
    case 'server_error':
      return t('queued', d.message);
    case 'choose_instance':
      return t('queued', d.message, 'open-settings');
    case 'no_token':
    case 'unauthorized':
      return t('error', d.message, 'open-settings');
    case 'rejected':
      return t('error', d.message);
  }
}

function filesNote(files?: { saved: number; notIncluded: number }): string {
  if (!files) return '';
  return `, ${files.saved} file${files.saved === 1 ? '' : 's'}`;
}
