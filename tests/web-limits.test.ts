import { describe, expect, it } from 'vitest';
import { checkMarkdown, MAX_MARKDOWN_CHARS } from '../src/features/web-to-md/background/limits';

describe('markdown cap (download)', () => {
  it('accepts normal markdown, rejects missing or oversized', () => {
    expect(checkMarkdown('# hi')).toBeNull();
    expect(checkMarkdown(undefined)).toMatch(/Invalid/);
    expect(checkMarkdown({})).toMatch(/Invalid/);
    expect(checkMarkdown('x'.repeat(MAX_MARKDOWN_CHARS + 1))).toMatch(/too large/);
  });
});
