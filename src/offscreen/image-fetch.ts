// Fetch policy for web images (pure apart from the injected fetch; unit-tested).
//
// Redirects: ideally every hop would be checked with isPublicHttpUrl() before
// it is requested (`redirect: 'manual'` + following Location ourselves). In
// Chrome that is not possible from fetch(): a manual redirect yields an
// `opaqueredirect` response (status 0, no headers, no Location) — extension
// pages with host permissions included. So:
// - with cookies (image on the page's own origin): `redirect: 'error'`, so a
//   cookie-bearing request never follows a redirect; if it fails, the image is
//   fetched once more without cookies (below).
// - without cookies: `redirect: 'follow'`, then the final URL is checked again
//   and the response discarded if it ended on a private host. The intermediate
//   request itself may have reached that host (cookie-less, response unread).
// DNS: hosts are checked by name/literal only. A public name that resolves to
// a private address (or DNS rebinding) is not detected — extensions have no
// DNS API to check the resolved address.

import { isPublicHttpUrl, isSameOrigin } from './url-safety';

export type ImageFetchResult =
  | { ok: true; res: Response; credentials: RequestCredentials }
  | { ok: false; error: string };

export interface ImageFetchOptions {
  pageUrl?: string;
  timeoutMs: number;
  fetchFn?: typeof fetch;
}

function failure(e: unknown): ImageFetchResult {
  const timedOut = e instanceof DOMException && e.name === 'TimeoutError';
  return { ok: false, error: timedOut ? 'download timed out' : 'network error' };
}

export async function fetchImage(url: string, opts: ImageFetchOptions): Promise<ImageFetchResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  if (url.startsWith('data:')) {
    try {
      return { ok: true, res: await fetchFn(url), credentials: 'omit' };
    } catch (e) {
      return failure(e);
    }
  }
  if (!isPublicHttpUrl(url)) return { ok: false, error: 'URL not allowed' };

  if (isSameOrigin(url, opts.pageUrl)) {
    try {
      const res = await fetchFn(url, {
        credentials: 'include',
        redirect: 'error',
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
      return { ok: true, res, credentials: 'include' };
    } catch (e) {
      if (e instanceof DOMException && e.name === 'TimeoutError') return failure(e);
      // Redirected (or a network error): retry without cookies.
    }
  }

  let res: Response;
  try {
    res = await fetchFn(url, {
      credentials: 'omit',
      redirect: 'follow',
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (e) {
    return failure(e);
  }
  // A redirect may have led to a private address: don't keep what it returned.
  if (!isPublicHttpUrl(res.url || url)) {
    void res.body?.cancel().catch(() => {});
    return { ok: false, error: 'URL not allowed' };
  }
  return { ok: true, res, credentials: 'omit' };
}
