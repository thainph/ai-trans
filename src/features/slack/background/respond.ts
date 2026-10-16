import type { ExportAction, ExportResponse, FileStats } from '../messages';

/** Build the final popup message. Markdown is included only for "copy". */
export function makeDoneResponse(
  action: ExportAction,
  result: { markdown: string; filename: string; messageCount: number },
  warning?: string,
  files?: FileStats,
): ExportResponse {
  const meta = { type: 'done' as const, filename: result.filename, messageCount: result.messageCount, warning, files };
  if (action === 'copy') return { ...meta, action: 'copy', markdown: result.markdown };
  return { ...meta, action: 'download' };
}
