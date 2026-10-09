// Unified MV3 service worker. Each feature registers its own listeners:
// - translator: chrome.runtime.onMessage ({ action: ... }) + onInstalled (defaults, Ollama CORS rule)
// - devdy: chrome.runtime.onMessage ({ target: 'context-kit-devdy' }) + outbox retry alarm
// - slack export: chrome.runtime.onConnect (port "slack-thread-export")
// The channels are independent, so importing each module is enough.
import '../translator/background.js';
import './devdy';
import './slack-export';
