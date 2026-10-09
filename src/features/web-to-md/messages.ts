// Web page / selection captures → Devdy (POST /v1/web-pages).
//
// selection toolbar (content script) ─WEB_TARGET─▶ background  (send-selection)
// Web → MD popup                     ─WEB_TARGET─▶ background  (send-page)
// background ─WEB_TOAST_TARGET─▶ content script (progress / result toast)

import type { Result } from '../../shared/messaging';
import type { ToastPayload } from '../../shared/toast';
import type { DevdyDelivery } from '../slack/messages';
import type { PageMeta } from './core/web-capture';

export const WEB_TARGET = 'context-kit-web';
/** Distinct from the Slack toast target so app.slack.com doesn't show two toasts. */
export const WEB_TOAST_TARGET = 'context-kit-web-toast';

export type WebRequest =
  | {
      target: typeof WEB_TARGET;
      type: 'send-selection';
      /** Markdown of the selected fragment (links/images absolute). */
      markdown: string;
      /** Plain selected text: its first line becomes the title. */
      selectionText: string;
      page: PageMeta;
    }
  | {
      target: typeof WEB_TARGET;
      type: 'send-page';
      markdown: string;
      page: PageMeta;
      /** The popup's "Selected text only" mode. */
      selection: boolean;
      selectionText?: string;
    }
  /**
   * Web → MD "Download": zip `<name>.md` + images/ when the Markdown references
   * downloadable images; `zipped: false` → the popup saves the plain .md itself.
   */
  | {
      target: typeof WEB_TARGET;
      type: 'download-page';
      markdown: string;
      filename: string;
      /** Page URL: images of the same site are fetched with cookies. */
      pageUrl?: string;
    }
  /** "Open settings" on a toast → popup on the Devdy tab. */
  | { target: typeof WEB_TARGET; type: 'open-settings' };

export interface WebSendResult {
  delivery: DevdyDelivery;
  images: { saved: number; failed: number };
}

export type DownloadPageResponse = Result<
  | { zipped: true; filename: string; images: { saved: number; failed: number } }
  | {
      zipped: false;
      images: { saved: number; failed: number };
    }
>;

/** Response to `send-page`: the delivery plus the status line for the popup. */
export type SendPageResponse = Result<{ result: WebSendResult; text: string }>;

export interface WebToastMessage extends ToastPayload {
  target: typeof WEB_TOAST_TARGET;
}
