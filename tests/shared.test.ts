import { describe, expect, it } from 'vitest';
import { errorMessage } from '../src/shared/errors';
import { cleanFilenamePart, filenamePart, safeFileName } from '../src/shared/filename';

describe('errorMessage', () => {
  it('reads Error messages and stringifies anything else', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('plain')).toBe('plain');
    expect(errorMessage(42)).toBe('42');
  });
});

describe('filename helpers', () => {
  it('keeps letters of any script and collapses the rest', () => {
    expect(cleanFilenamePart('..Hello, 世界 / ok..')).toBe('Hello-世界-ok');
    expect(filenamePart('???', 'page')).toBe('page');
    expect(filenamePart('a'.repeat(100), 'page')).toHaveLength(60);
    expect(safeFileName('Report v2.final.PDF')).toBe('Report-v2.final.pdf');
  });
});
