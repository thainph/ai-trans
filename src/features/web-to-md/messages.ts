// Web → MD tab ─WEB_TARGET─▶ background (download-page: zip the page with its images).

import type { Result } from '../../shared/messaging';

export const WEB_TARGET = 'context-kit-web';

/**
 * Web → MD "Download": zip `<name>.md` + images/ when the Markdown references
 * downloadable images; `zipped: false` → the popup saves the plain .md itself.
 */
export type WebRequest = {
  target: typeof WEB_TARGET;
  type: 'download-page';
  markdown: string;
  filename: string;
  /** Page URL: images of the same site are fetched with cookies. */
  pageUrl?: string;
};

export type DownloadPageResponse = Result<
  | { zipped: true; filename: string; images: { saved: number; failed: number } }
  | {
      zipped: false;
      images: { saved: number; failed: number };
    }
>;
