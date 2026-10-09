// Ollama rejects requests whose Origin it doesn't allow (chrome-extension://…
// by default), so declarativeNetRequest strips `Origin` — but only on requests
// made by this extension (initiatorDomains = our id) and only to the configured
// Ollama origin(s): the saved `ollamaUrl` and the URL last probed from the
// popup ("Refresh" before saving). Web pages' requests to localhost are never
// touched.

import { loadSettings } from '../shared/settings';

/** Dynamic rule ids owned by the translator (1–2 also cover the old global rules). */
const RULE_IDS = [1, 2, 3];

/** http(s) origin of a URL, or null. */
export function ollamaOrigin(url: string): string | null {
  try {
    const u = new URL(url.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

/** One Origin-stripping rule per distinct Ollama origin, limited to requests from `extensionId`. */
export function ollamaCorsRules(urls: string[], extensionId: string): chrome.declarativeNetRequest.Rule[] {
  const origins = [...new Set(urls.map(ollamaOrigin).filter((o): o is string => !!o))];
  return origins.slice(0, RULE_IDS.length).map((origin, i) => ({
    id: RULE_IDS[i]!,
    priority: 1,
    action: {
      type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
      requestHeaders: [{ header: 'Origin', operation: 'remove' as chrome.declarativeNetRequest.HeaderOperation }],
    },
    condition: {
      // `|` anchors the filter at the start of the URL: scheme + host + port.
      urlFilter: `|${origin}/`,
      initiatorDomains: [extensionId],
      resourceTypes: [
        'xmlhttprequest' as chrome.declarativeNetRequest.ResourceType,
        'other' as chrome.declarativeNetRequest.ResourceType,
      ],
    },
  }));
}

let probeUrl = '';
let syncedKey: string | null = null;
let queue: Promise<void> = Promise.resolve();

/**
 * Make the dynamic rules match the saved Ollama URL (+ `probe`, a URL about to
 * be fetched). Serialized, and a no-op when nothing changed.
 */
export function syncOllamaCors(probe?: string): Promise<void> {
  if (probe !== undefined) probeUrl = probe;
  queue = queue
    .then(async () => {
      const { ollamaUrl } = await loadSettings('ollamaUrl');
      const rules = ollamaCorsRules([ollamaUrl, probeUrl], chrome.runtime.id);
      const key = JSON.stringify(rules);
      if (key === syncedKey) return;
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: RULE_IDS, addRules: rules });
      syncedKey = key;
    })
    .catch((err: unknown) => console.warn('AI Translator: cannot update the Ollama CORS rules', err));
  return queue;
}
