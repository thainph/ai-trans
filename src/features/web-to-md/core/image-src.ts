// The real URL of an <img> (pure DOM → unit-tested). Used by the Markdown
// converter and the selection capture.

/** Tiny placeholder images lazy-loaders put in `src` before the real one loads. */
const PLACEHOLDER_RE = /^data:image\/(gif|png|svg\+xml)[;,]/i;
const LAZY_ATTRS = ['data-src', 'data-lazy-src', 'data-original', 'data-actualsrc', 'data-url'];

/** Largest candidate of a `srcset` ("a.png 1x, b.png 2x" / "a.png 480w, b.png 960w"). */
export function largestFromSrcset(srcset: string | null): string | null {
  if (!srcset) return null;
  let best: { url: string; size: number } | null = null;
  for (const part of srcset.split(/,\s+/)) {
    const [url, descriptor = '1x'] = part.trim().split(/\s+/);
    if (!url) continue;
    const size = parseFloat(descriptor) * (descriptor.endsWith('w') ? 1 : 1000);
    if (!best || size > best.size) best = { url, size: Number.isFinite(size) ? size : 0 };
  }
  return best?.url ?? null;
}

/**
 * The real image URL of an <img>: a lazy-loaded image keeps a tiny data:
 * placeholder in `src` until it scrolls into view; the real URL is in
 * data-src (or similar) / srcset.
 */
export function bestImageSrc(img: Element): string | null {
  const src = img.getAttribute('src');
  if (!src || PLACEHOLDER_RE.test(src)) {
    for (const a of LAZY_ATTRS) {
      const v = img.getAttribute(a);
      if (v) return v;
    }
    const fromSet = largestFromSrcset(img.getAttribute('srcset') || img.getAttribute('data-srcset'));
    if (fromSet) return fromSet;
  }
  return src || largestFromSrcset(img.getAttribute('srcset'));
}
