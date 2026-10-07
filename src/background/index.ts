// Unified MV3 service worker. Each feature registers its own listeners:
// - translator: chrome.runtime.onMessage ({ action: ... }) + onInstalled (defaults, Ollama CORS rule)
// - slack export: chrome.runtime.onConnect (port "slack-thread-export")
// The two channels are independent, so importing both is enough.
import '../translator/background.js';
import './slack-export';
