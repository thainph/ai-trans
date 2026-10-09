// Is an element rendered and visible? Ancestor-aware: a text inside a
// `display: none` or `visibility: hidden` subtree is hidden too.

export function isElementVisible(el: Element): boolean {
  if (typeof el.checkVisibility === 'function') {
    return el.checkVisibility({ checkVisibilityCSS: true });
  }
  // Fallback (no checkVisibility): walk the ancestors' computed styles.
  const view = el.ownerDocument.defaultView;
  if (!view) return true;
  if (view.getComputedStyle(el).visibility === 'hidden') return false;
  for (let e: Element | null = el; e; e = e.parentElement) {
    if (view.getComputedStyle(e).display === 'none') return false;
  }
  return true;
}

/** Does the element's box intersect the viewport (grown by `margin` px)? Boxless elements count as in view. */
export function isInViewport(el: Element, margin = 0): boolean {
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return true;
  const view = el.ownerDocument.defaultView;
  const h = view?.innerHeight ?? 0;
  const w = view?.innerWidth ?? 0;
  return r.bottom >= -margin && r.top <= h + margin && r.right >= 0 && r.left <= w;
}
