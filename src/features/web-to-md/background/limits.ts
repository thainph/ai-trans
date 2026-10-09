// Input limits for web captures received by the background (pure, unit-tested).

/**
 * Longest Markdown accepted from a page / the popup (characters). Devdy takes
 * at most 50 MB per body; this also bounds what a page can make us process.
 */
export const MAX_MARKDOWN_CHARS = 30 * 1024 * 1024;

/** Markdown of a request, or an error text when it is missing or too long. */
export function checkMarkdown(markdown: unknown): string | null {
  if (typeof markdown !== 'string') return 'Invalid request.';
  if (markdown.length > MAX_MARKDOWN_CHARS) return 'The page is too large to send (over 30 MB of Markdown).';
  return null;
}
