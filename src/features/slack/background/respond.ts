import type { DevdyDelivery, ExportAction, ExportResponse, FileStats } from '../messages';

/** Build the final popup message. Markdown is included only for "copy". */
export function makeDoneResponse(
  action: ExportAction,
  result: { markdown: string; filename: string; messageCount: number },
  warning?: string,
  files?: FileStats,
  devdy?: DevdyDelivery,
): ExportResponse {
  const meta = { type: 'done' as const, filename: result.filename, messageCount: result.messageCount, warning, files };
  if (action === 'copy') return { ...meta, action: 'copy', markdown: result.markdown };
  if (action === 'devdy') {
    return { ...meta, action: 'devdy', devdy: devdy ?? { kind: 'unreachable', message: 'Not sent.', pending: 0 } };
  }
  return { ...meta, action: 'download' };
}
