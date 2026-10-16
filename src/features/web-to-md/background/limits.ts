// Input limits for pages the background zips for download (pure, unit-tested).

/** Longest Markdown accepted from the Web → MD tab (characters); bounds what we process. */
export const MAX_MARKDOWN_CHARS = 30 * 1024 * 1024;

/** Markdown of a request, or an error text when it is missing or too long. */
export function checkMarkdown(markdown: unknown): string | null {
  if (typeof markdown !== 'string') return 'Invalid request.';
  if (markdown.length > MAX_MARKDOWN_CHARS) return 'The page is too large to export (over 30 MB of Markdown).';
  return null;
}
