// The ➤ "send to Devdy" icon used by the Slack content script. Same shape as the
// ➤ button of the selection toolbar (translator content script), built with
// createElementNS so no markup string is ever parsed into Slack's page.

const SVG_NS = 'http://www.w3.org/2000/svg';
export const DEVDY_ICON_ATTR = 'data-context-kit-icon';

/** A fresh ➤ icon, `size` px square, drawn with the surrounding text colour. */
export function createDevdyIcon(doc: Document, size = 16): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  const attrs: Record<string, string> = {
    viewBox: '0 0 24 24',
    width: String(size),
    height: String(size),
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2.2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false',
    [DEVDY_ICON_ATTR]: '',
  };
  for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
  svg.style.flexShrink = '0';

  const line = doc.createElementNS(SVG_NS, 'line');
  for (const [k, v] of Object.entries({ x1: '22', y1: '2', x2: '11', y2: '13' })) line.setAttribute(k, v);
  const polygon = doc.createElementNS(SVG_NS, 'polygon');
  polygon.setAttribute('points', '22 2 15 22 11 13 2 9 22 2');
  svg.append(line, polygon);
  return svg;
}
