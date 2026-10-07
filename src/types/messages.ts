// Messages exchanged between the popup and the background service worker
// over a long-lived chrome.runtime port.

export const EXPORT_PORT_NAME = 'slack-thread-export';

export interface ExportOptions {
  includeReactions: boolean;
  includeFiles: boolean;
  /**
   * "Export" downloads Slack-hosted attachments and saves a .zip
   * (Markdown + files/). Only applies when includeFiles is on; ignored by "Copy".
   */
  zipFiles: boolean;
}

export const DEFAULT_OPTIONS: ExportOptions = {
  includeReactions: true,
  includeFiles: true,
  zipFiles: true,
};

export type ExportAction = 'download' | 'copy';

export interface ExportRequest {
  type: 'export';
  link: string;
  action: ExportAction;
  options: ExportOptions;
}

/** Attachment summary for a zip export. */
export interface FileStats {
  saved: number;
  /** Skipped up front (external, too large…) or failed to download. */
  notIncluded: number;
}

interface DoneBase {
  type: 'done';
  filename: string;
  messageCount: number;
  /** Set when the export may be incomplete. */
  warning?: string;
  /** Present when the export was saved as a .zip with attachments. */
  files?: FileStats;
}

export type ExportResponse =
  | { type: 'progress'; text: string }
  // Markdown is only sent back for "copy"; "download" returns metadata only.
  | (DoneBase & { action: 'copy'; markdown: string })
  | (DoneBase & { action: 'download' })
  | { type: 'error'; message: string };
