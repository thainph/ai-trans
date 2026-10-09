// Unified MV3 service worker. Each feature registers its own listeners:
// - translator: chrome.runtime.onMessage ({ action: ... }) + onInstalled (defaults, Ollama CORS rule)
// - devdy: chrome.runtime.onMessage ({ target: 'context-kit-devdy' }) + outbox retry alarm
// - slack export: chrome.runtime.onConnect (port "slack-thread-export")
// - quick send (Slack menu item): chrome.runtime.onMessage ({ target: 'context-kit-quick-send' })
// - web capture (selection toolbar / Web → MD): chrome.runtime.onMessage ({ target: 'context-kit-web' })
// The channels are independent, so importing each module is enough.
import '../translator/background.js';
import '../features/devdy/background';
import '../features/slack/background/export';
import '../features/slack/background/quick-send';
import '../features/web-to-md/background/web-capture';
