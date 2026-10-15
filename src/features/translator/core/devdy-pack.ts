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
// around a bare number are not words a model translates. Items containing ⟦
// or ⟧ themselves are not packed (`isPackable`), so in a reply these brackets
// can only come from our markers.
//
// What unpacking guarantees (structural, not semantic): an item gets text
// only from a section that starts with a well-formed marker for exactly one
// request item, seen once and in increasing order, and that contains no other
// bracket. Anything ambiguous — missing, duplicated, out-of-range or
// reordered markers, a stray marker inside a line — makes the affected items
// null (kept original, retried later); no returned text ever contains ⟦ or ⟧.
// It cannot detect a model that moves one item's meaning under another
// item's marker while keeping the markers intact.

/** Characters of page text per batch the content script sends (before packing). */
export const DEVDY_BATCH_CHARS = 5500;
/** Target size of one packed request, markers included (Devdy accepts up to 8000 characters). */
export const DEVDY_PACK_CHARS = 6500;
/** Hard limit of one request (Devdy's own limit). */
export const DEVDY_PACK_MAX_CHARS = 8000;

const marker = (i: number) => `⟦${i}⟧`;
/** Any bracket of a marker: never part of a packable item, never in an output. */
const BRACKET = /[⟦⟧]/;
/** A bracketed number anywhere in a line (half- or full-width digits). */
const MARKER_ANYWHERE = /⟦\s*\\?([0-9０-９]{1,4})\s*\\?⟧/g;
/**
 * A marker at the start of a line, optionally wrapped in Markdown the model may
 * add (`**⟦1⟧**`, `` `⟦1⟧` ``, `\⟦1\⟧`, `# ⟦1⟧`, `- ⟦1⟧`) and optionally
 * followed by the item's text on the same line (`⟦1⟧ Sign in`).
 */
const MARKER_HEAD = /^[\s*_`\\#-]*⟦\s*\\?([0-9０-９]{1,4})\s*\\?⟧[*_`\\]*\s*/;

const toIndex = (digits: string) => Number(digits.normalize('NFKC'));

/** Items that can't be packed safely: they contain a marker bracket themselves. */
export function isPackable(text: string): boolean {
  return !BRACKET.test(text);
}

/** Packed size of one item (marker line + text + blank line). */
const packedSize = (i: number, text: string) => marker(i).length + 1 + text.length + 2;

/**
 * Group item indexes into requests of at most `maxChars` packed characters.
 * Unpackable items and items too large even alone (> DEVDY_PACK_MAX_CHARS)
 * are left out (`skipped`: the caller reports them as untranslatable, not as
 * failures to retry). Markers are numbered within each group.
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
 * One translation (or null) per packed item; see the guarantees at the top.
 * Text before the first marker is dropped.
 */
export function unpackItems(reply: string, count: number): (string | null)[] {
  const sections = new Map<number, string[]>();
  const poisoned = new Set<number>();
  let current: number | null = null;
  let last = -1;
  const stop = (...indexes: number[]) => {
    if (current !== null) poisoned.add(current);
    for (const i of indexes) poisoned.add(i);
    current = null;
  };
  for (const line of reply.split(/\r\n|\r|\n/)) {
    const head = MARKER_HEAD.exec(line);
    const rest = head ? line.slice(head[0].length) : line;
    if (BRACKET.test(rest)) {
      // A marker (or a bracket) where it doesn't belong: we can't tell where
      // the items it touches begin or end.
      const named = [...rest.matchAll(MARKER_ANYWHERE)].map((m) => toIndex(m[1]!));
      stop(...named, ...(head ? [toIndex(head[1]!)] : []));
      continue;
    }
    if (!head) {
      if (current !== null) sections.get(current)!.push(line);
      continue;
    }
    const idx = toIndex(head[1]!);
    if (idx >= count) {
      // Unknown marker: what follows belongs to no item.
      current = null;
      continue;
    }
    if (idx <= last || sections.has(idx)) {
      // Duplicated or reordered: both sides are suspect.
      stop(idx);
      continue;
    }
    last = idx;
    current = idx;
    sections.set(idx, rest ? [rest] : []);
  }
  return Array.from({ length: count }, (_, i) => {
    if (poisoned.has(i)) return null;
    const text = sections.get(i)?.join('\n').trim();
    return text ? text : null;
  });
}
