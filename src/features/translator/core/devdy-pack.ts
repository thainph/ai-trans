// Full-page translation with Devdy (pure → unit-tested).
//
// Devdy only translates plain text with its own prompt, and serializes its
// requests, so several page items travel in ONE request as a small Markdown
// document: a marker line `⟦i⟧` before each item, a blank line between items:
//
//   ⟦0⟧
//   Hello world
//
//   ⟦1⟧
//   Sign in
//
// Devdy's prompt keeps Markdown structure, and the mathematical brackets ⟦ ⟧
// around a bare number are not words a model translates. The reply is split
// on those marker lines; an item whose marker is missing, duplicated or empty
// becomes null (the caller keeps the original and retries it later). Text is
// never taken from a section whose marker doesn't name exactly one request item.

/** Characters of page text per batch the content script sends (before packing). */
export const DEVDY_BATCH_CHARS = 5500;
/** Target size of one packed request, markers included (Devdy accepts up to 8000 characters). */
export const DEVDY_PACK_CHARS = 6500;
/** Hard limit of one request (Devdy's own limit). */
export const DEVDY_PACK_MAX_CHARS = 8000;

const marker = (i: number) => `⟦${i}⟧`;
/** A marker line, tolerant of spacing and full-width digits (NFKC). */
const MARKER_LINE = /^\s*⟦\s*(\d{1,4})\s*⟧\s*$/;

function markerIndex(line: string): number | null {
  const m = MARKER_LINE.exec(line.normalize('NFKC'));
  return m ? Number(m[1]) : null;
}

/** Items that can't be packed safely: they contain a marker-like line themselves. */
export function isPackable(text: string): boolean {
  return !text.split(/\r\n|\r|\n/).some((line) => markerIndex(line) !== null);
}

/** Packed size of one item (marker line + text + blank line). */
const packedSize = (i: number, text: string) => marker(i).length + 1 + text.length + 2;

/**
 * Group item indexes into requests of at most `maxChars` packed characters.
 * Unpackable items and items too large even alone (> DEVDY_PACK_MAX_CHARS)
 * are left out (`skipped`). Markers are numbered within each group.
 */
export function planPacks(texts: string[], maxChars = DEVDY_PACK_CHARS): { groups: number[][]; skipped: number[] } {
  const groups: number[][] = [];
  const skipped: number[] = [];
  let current: number[] = [];
  let size = 0;
  texts.forEach((text, i) => {
    if (!isPackable(text) || packedSize(0, text) > DEVDY_PACK_MAX_CHARS) {
      skipped.push(i);
      return;
    }
    const add = packedSize(current.length, text);
    if (current.length > 0 && size + add > maxChars) {
      groups.push(current);
      current = [];
      size = 0;
    }
    size += packedSize(current.length, text);
    current.push(i);
  });
  if (current.length > 0) groups.push(current);
  return { groups, skipped };
}

/** The request text for `items` (markers 0…n-1). */
export function packItems(items: string[]): string {
  return items.map((text, i) => `${marker(i)}\n${text}`).join('\n\n');
}

/**
 * One translation (or null) per packed item. Text before the first marker and
 * sections of unknown markers are dropped; a marker seen twice makes that item
 * null (we can't tell which section is right).
 */
export function unpackItems(reply: string, count: number): (string | null)[] {
  const sections = new Map<number, string[]>();
  const duplicated = new Set<number>();
  let current: string[] | null = null;
  for (const line of reply.split(/\r\n|\r|\n/)) {
    const idx = markerIndex(line);
    if (idx === null) {
      current?.push(line);
      continue;
    }
    if (idx >= count) {
      current = null;
    } else if (sections.has(idx)) {
      duplicated.add(idx);
      current = null;
    } else {
      current = [];
      sections.set(idx, current);
    }
  }
  return Array.from({ length: count }, (_, i) => {
    if (duplicated.has(i)) return null;
    const text = sections.get(i)?.join('\n').trim();
    return text ? text : null;
  });
}
