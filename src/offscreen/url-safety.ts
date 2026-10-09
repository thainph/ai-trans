// URL checks for web-image downloads (pure, unit-tested). Images come from
// arbitrary page Markdown, so the offscreen document must not be turned into a
// proxy for the local network (router admin pages, localhost services…) nor
// attach the user's cookies to third-party requests.

/** IPv4 literal → 4 octets, or null. (The URL parser already normalizes 0x7f.1 etc.) */
function ipv4(host: string): number[] | null {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((p) => p <= 255) ? parts : null;
}

function isPrivateIpv4([a, b]: number[]): boolean {
  return (
    a === 0 || // 0.0.0.0/8
    a === 10 || // 10/8
    a === 127 || // loopback
    (a === 100 && b! >= 64 && b! <= 127) || // CGNAT 100.64/10
    (a === 169 && b === 254) || // link-local
    (a === 172 && b! >= 16 && b! <= 31) || // 172.16/12
    (a === 192 && b === 168) || // 192.168/16
    a! >= 224 // multicast / reserved
  );
}

/** Expand an IPv6 literal (without brackets) to 8 hextets, or null. */
function ipv6(host: string): number[] | null {
  if (!host.includes(':')) return null;
  const [head, tail] = host.split('::') as [string, string | undefined];
  if (host.split('::').length > 2) return null;
  const parse = (s: string) => (s ? s.split(':') : []);
  const toHextets = (parts: string[]): number[] | null => {
    const out: number[] = [];
    for (const p of parts) {
      const v4 = ipv4(p);
      if (v4) {
        out.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
      } else if (/^[0-9a-f]{1,4}$/i.test(p)) {
        out.push(Number.parseInt(p, 16));
      } else {
        return null;
      }
    }
    return out;
  };
  const h = toHextets(parse(head));
  const t = toHextets(parse(tail ?? ''));
  if (!h || !t) return null;
  if (tail === undefined) return h.length === 8 ? h : null;
  const fill = 8 - h.length - t.length;
  return fill >= 0 ? [...h, ...Array<number>(fill).fill(0), ...t] : null;
}

function isPrivateIpv6(x: number[]): boolean {
  const zeroPrefix = x.slice(0, 5).every((v) => v === 0);
  if (zeroPrefix && x[5] === 0 && x[6] === 0 && (x[7] === 0 || x[7] === 1)) return true; // :: and ::1
  // IPv4-mapped (::ffff:a.b.c.d) → check the IPv4 address.
  if (zeroPrefix && x[5] === 0xffff) return isPrivateIpv4([x[6]! >> 8, x[6]! & 0xff, x[7]! >> 8, x[7]! & 0xff]);
  const first = x[0]!;
  return (
    (first & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (first & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (first & 0xff00) === 0xff00 // multicast
  );
}

/** Hostname that must not be fetched: loopback, private, link-local, `localhost`, `*.local`. */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (!host.includes('.') && !host.includes(':')) return true; // single-label intranet names
  const v4 = ipv4(host);
  if (v4) return isPrivateIpv4(v4);
  const v6 = ipv6(host);
  if (v6) return isPrivateIpv6(v6);
  return false;
}

/** An http(s) URL on a public host (no credentials in the URL). data:image is handled separately. */
export function isPublicHttpUrl(u: string): boolean {
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  return !isPrivateHost(url.hostname);
}

/** Second-level labels used under country TLDs (co.jp, com.au, org.uk…). */
const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'or', 'ne', 'go', 'gr', 'lg', 'ad']);

/** Approximate registrable domain ("eTLD+1") without the Public Suffix List. */
export function siteOf(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (ipv4(host) || host.includes(':')) return host;
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  const tld = labels.at(-1)!;
  const sld = labels.at(-2)!;
  const take = tld.length === 2 && SECOND_LEVEL.has(sld) ? 3 : 2;
  return labels.slice(-take).join('.');
}

/** Same scheme + registrable domain: cookies may be sent (the page itself would send them). */
export function isSameSite(a: string, b: string | undefined): boolean {
  if (!b) return false;
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.protocol === y.protocol && siteOf(x.hostname) === siteOf(y.hostname);
  } catch {
    return false;
  }
}
