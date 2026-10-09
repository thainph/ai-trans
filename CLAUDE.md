# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**Context Kit** — a Chrome Manifest V3 extension that bundles three tools behind one toolbar popup:

| Tab | Code | What it does |
|---|---|---|
| Translate | `public/translator/`, `src/translator/background.js` | Translate selected text / whole pages via OpenAI, Gemini or local Ollama |
| Web → MD | `public/web-to-md/` | Convert the current page to Markdown (download / copy) |
| Slack | `src/slack/popup/`, `src/core/`, `src/background/slack-export.ts` | Export a Slack thread to Markdown, optionally as a .zip with attachments |

This repo was previously the standalone AI Translator extension; its history is preserved.

## Development

```bash
pnpm install
pnpm build       # tsc --noEmit + vite build → dist/
pnpm test        # vitest (Slack export + attachments)
pnpm dev         # vite build --watch
```

Load `dist/` unpacked at `chrome://extensions/` (Developer mode). Reload the extension after rebuilding.

## Architecture

- **Build:** Vite bundles TypeScript entries (`src/popup/index.html`, `src/slack/popup/popup.html`, `src/offscreen/offscreen.html`, `src/background/index.ts`). Everything in `public/` (manifest, icons, translator + web-to-md plain-JS files, `shared/theme.css`) is copied verbatim — those classic scripts are **not** bundled.
- **Popup shell** (`src/popup/shell.ts`): tab bar that loads each tool's own popup page in a same-origin iframe (chrome.* APIs still work, CSS/IDs stay isolated). Iframes are created lazily and auto-sized. Code inside an iframe must call `window.top.close()` to close the popup.
- **Service worker** (`src/background/index.ts`): imports `../translator/background.js` (`chrome.runtime.onMessage` with `request.action`) and `./slack-export` (`chrome.runtime.onConnect`, port `slack-thread-export`). Independent channels — add new features as separate modules imported here.
- **Offscreen document** (`src/offscreen/`): fetches Slack attachments with the browser's cookies and builds the zip (fflate) → blob: URL for `chrome.downloads`. Needed because MV3 service workers can't create blob URLs and data: URLs cap at ~2 MB. Messages use `target: 'context-kit-offscreen'` (`src/types/offscreen.ts`).
- **Styling:** translator keeps `public/translator/popup.css`; Web → MD and Slack use `public/shared/theme.css`, which mirrors the translator design tokens — keep them in sync.

## Translator notes

- `public/translator/content.js` runs in every frame. Selection translation uses a **Shadow DOM** popup (query via `shadowRoot.getElementById`, not `document`). Full-page translation walks text nodes and stores originals in the `originalTexts` Map for revert; a `MutationObserver` translates dynamic content. New filter logic must go in both `collectTranslatableTextNodes()` and `isTranslatableTextNode()`.
- `src/translator/background.js` is the only place that calls LLM APIs. `getProviderConfig()` returns `{ provider, url, model, headers }`; `callLLM()` branches on provider (OpenAI chat completions, Gemini `generateContent`, Ollama `/api/chat`). Batch prompts use numbered `[N] text` lines.
- Ollama CORS: `declarativeNetRequest` dynamic rules (set in `onInstalled`) strip `Origin` for localhost/127.0.0.1.
- `isExtensionValid()` guards every `chrome.*` call in the content script — keep this pattern.

## Slack export notes

- `pageSlackApi` in `src/core/slack-client.ts` is serialized and run in the app.slack.com page (MAIN world): it must stay **self-contained** (no imports/closures). The session token never leaves the page.
- Attachments: `src/core/attachments.ts` plans downloads (only `https://*.slack.com`, 25 MB per file, 200 MB total, external files skipped); `md-builder` renders saved files as local links and skipped ones with a `_(not included: …)_` note.

## Devdy integration

- "Send to Devdy" posts the thread to Devdy's local Inbox API (`POST http://127.0.0.1:{47821..47830}/v1/slack-threads`, Bearer token). Contract: `devdy/docs/slack-thread-inbox-api.md`.
- All sends go through `DevdyOutbox` (`src/core/devdy-outbox.ts`): payload stored in IndexedDB (`src/core/blob-store.ts`, shared with the offscreen document which writes zips there via `store-zip`), metadata in `chrome.storage.local.devdyOutbox`. Retryable outcomes (`unreachable`, `no_token`, `unauthorized`, `server_error`) stay queued and are retried by the `devdy-outbox-retry` alarm; others are dropped.
- Fetches to Devdy must run in extension contexts (service worker / offscreen), never in content scripts (CORS + Private Network Access).

## Storage keys

- `chrome.storage.sync` — translator: `provider, apiKey, openaiModel, geminiApiKey, geminiModel, ollamaUrl, ollamaModel, style, targetLang, popupWidth` (defaults in `DEFAULT_SETTINGS` in `src/translator/background.js`, re-declared in `public/translator/popup.js` — keep aligned). Slack: `includeReactions, includeFiles, zipFiles`.
- `chrome.storage.local` — `contextKitLastTab`; Devdy: `devdyToken, devdyPort, devdyProjectId, devdyOutbox`.
