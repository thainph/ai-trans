# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Chrome Manifest V3 extension that translates web page text via OpenAI or a local Ollama server. Plain JavaScript — no bundler, no build step, no tests.

## Development

Load the extension unpacked at `chrome://extensions/` → Developer mode → "Load unpacked" → select this directory. Reload the extension after editing `background.js` or `manifest.json`; content script edits take effect on next page load.

## Architecture

Three-layer message-passing design across the standard MV3 surfaces:

- **[content.js](content.js)** runs in every frame. Handles two independent flows:
  1. *Selection translation* — listens on `mouseup`, shows a floating `T`/`R` trigger button, opens a draggable/resizable **Shadow DOM** popup (Shadow DOM is required to isolate styles from arbitrary host pages).
  2. *Full-page translation* — walks the DOM with `TreeWalker`, filters via `SKIP_TAGS` + [needsTranslation()](content.js#L525), batches text nodes by `maxChars` (3000), and replaces `node.textContent` in place. The pre-translation text for every touched node is stored in the `originalTexts` Map keyed by the live node — this is what `revertPageTranslation()` uses to restore the page and what dedupe checks rely on. A `MutationObserver` (started only after a successful page translation) auto-translates dynamically inserted nodes with a 500 ms debounce.
- **[background.js](background.js)** is the MV3 service worker and the **only** place that talks to the LLM APIs. Routes `translate` / `translateBatch` / `fetchOllamaModels` messages. Batch prompts use a numbered `[N] text` format — more reliable than separator-based parsing; `handleTranslateBatch` parses the response with `/^\[(\d+)\]\s*(.+)/` and falls back to the original text for any missing index. Caches the resolved provider config for 5s to avoid hammering `chrome.storage.sync`.
- **[popup.js](popup.js)** is the toolbar settings UI. Fetches Ollama models **via the background script** (not directly) to bypass CORS. Sends `translatePage`/`revertPage`/`getPageTranslationState` messages to the active tab's content script.

### Provider abstraction

`getProviderConfig()` in [background.js](background.js#L123) returns a uniform `{ url, model, headers }` shape; `callLLM()` then branches request/response shape on `config.provider`. OpenAI uses `/v1/chat/completions` with `Authorization: Bearer`; Ollama uses `/api/chat` with `{ stream: false }`. Concurrency limit differs by provider: **5 for OpenAI, 2 for Ollama** (local models are usually the bottleneck).

### Ollama CORS workaround

Ollama rejects requests with a browser `Origin` header. The extension uses `declarativeNetRequest` dynamic rules (set up in `onInstalled`) to strip `Origin` on requests to `localhost` / `127.0.0.1`. The `declarativeNetRequest` permission in [manifest.json](manifest.json) exists solely for this.

### Source language detection

[detectLanguage()](content.js#L53) is heuristic-only — Unicode block ranges plus a few diacritic-set checks for Latin-script languages. It is duplicated implicitly: the content script detects, the background script just maps the key to a display name via `LANG_NAMES`. Same-language guard: if detected source equals saved target, the target auto-flips (English ↔ Vietnamese fallback).

### Settings keys (chrome.storage.sync)

`provider`, `apiKey`, `openaiModel`, `ollamaUrl`, `ollamaModel`, `style`, `targetLang`, `popupWidth`. Defaults live in `DEFAULT_SETTINGS` in [background.js](background.js#L2) and are seeded on `onInstalled`. The popup independently re-declares defaults when reading — keep these two lists aligned when adding a setting.

## Things to keep in mind when editing

- The popup is rendered inside a **Shadow DOM** in the content script — all selectors inside the popup must go through `shadowRoot.getElementById(...)`, not `document`.
- Page translation mutates `Text.textContent` directly. Any new filter logic must go in both `collectTranslatableTextNodes()` (initial pass) and `isTranslatableTextNode()` (MutationObserver path) or dynamic content will diverge from initial behavior.
- The extension can be invalidated mid-session (reload during development). `isExtensionValid()` guards every `chrome.*` call from the content script — preserve this pattern when adding new entry points.
