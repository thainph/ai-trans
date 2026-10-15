// Devdy translation (service worker side): the DevdyTranslator wired to
// chrome.storage and fetch. Exposed to the translator through ../api.ts only.

import { chromePing } from '../../../shared/keepalive';
import { listProjects, resolveDevdy } from '../core/client';
import { translateJson, translateStream } from '../core/translate';
import { type DevdyTranslateRequest, type DevdyTranslateStatus, DevdyTranslator } from '../core/translator';
import { KEYS, loadSettings } from './index';

/** Pause that ends early when `signal` aborts (the caller then sees `cancelled`). */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

const translator = new DevdyTranslator({
  loadSettings,
  resolveDevdy: (settings) => resolveDevdy(settings),
  savePort: (port) => chrome.storage.local.set({ [KEYS.port]: port }),
  translateJson: (port, token, input, opts) => translateJson(port, token, input, opts),
  translateStream: (port, token, input, opts) => translateStream(port, token, input, opts),
  sleep,
});

// A new token / instance choice must be used right away.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes[KEYS.port] || changes[KEYS.pinned] || changes[KEYS.token])) {
    translator.invalidate();
  }
});

/**
 * Translate `text` (≤ DEVDY_TRANSLATE_MAX_CHARS) with Devdy's engine; streams
 * when `onDelta` is given. Rejects with a DevdyTranslateError.
 */
export async function devdyTranslate(req: DevdyTranslateRequest): Promise<string> {
  // Devdy serializes translations: a request may wait in its queue for a while.
  // Extension API calls keep the service worker alive meanwhile.
  const ping = setInterval(() => void chromePing(), 20_000);
  try {
    return (await translator.translate(req)).text;
  } finally {
    clearInterval(ping);
  }
}

/** Is Devdy ready to translate (running, "translate" feature, valid token)? */
export function devdyTranslateStatus(): Promise<DevdyTranslateStatus> {
  return translator.status(async (port, token) => {
    const res = await listProjects(port, token);
    if (res.ok) return true;
    return res.kind === 'unauthorized' ? false : null;
  });
}
