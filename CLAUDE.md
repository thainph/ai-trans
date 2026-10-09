# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**Context Kit** — a Chrome Manifest V3 extension that bundles four tabs behind one toolbar popup:

| Tab | Code | What it does |
|---|---|---|
| Translate | `src/features/translator/` | Translate selected text / whole pages via OpenAI, Gemini or local Ollama; English grammar check |
| Web → MD | `src/features/web-to-md/` | Convert the current page to Markdown (export .md/.zip, copy, send to Devdy) |
| Slack | `src/features/slack/` | Export a Slack thread to Markdown, optionally as a .zip with attachments |
| Devdy | `src/features/devdy/` | Devdy connection: token, app (port) choice, outbox queue |

This repo was previously the standalone AI Translator extension; its history is preserved. Everything is TypeScript (`allowJs: false`).

## Development

```bash
pnpm install
pnpm build       # typecheck + vite build (pages, SW) + content IIFEs + check:dist → dist/
pnpm dev         # = dev:all: every watcher (main, all-frames content, slack content), unminified
pnpm test        # vitest
pnpm typecheck   # tsc --noEmit
pnpm lint        # biome check (lint + format check)
pnpm format      # biome check --write
pnpm check:dist  # every path referenced by dist/manifest.json, HTML and code exists
```

Load `dist/` unpacked at `chrome://extensions/` (Developer mode). Reload the extension after rebuilding. CI (`.github/workflows/ci.yml`) runs typecheck, lint, test, build.

## Layout

```
src/
  background/      index.ts (SW entry: only imports feature modules), keepalive.ts, zip-export.ts (offscreen jobs)
  offscreen/       offscreen document (fetch files/images, build zips) + messages.ts
  popup/           popup shell: tab bar + one iframe per tool page
  content/         all-frames.ts: entry of the <all_urls> content script (one IIFE)
  shared/          errors, runtime (isExtensionAlive), filename, messaging (Result/onTargetMessage), toast, yaml, styles/{tokens,theme}.css
  features/<feature>/
    core/          pure logic (unit-tested, no chrome.*)
    background/    service-worker side (listeners)
    content/       content-script side
    popup/         the tab's page (html + ts)
    messages.ts    the feature's message types (translator: shared/messages.ts + shared/settings.ts)
tests/             vitest; import TS modules directly
public/            manifest.json + icons only (copied verbatim)
```

## Architecture

- **Build:** `vite.config.ts` bundles the pages (`src/popup/index.html`, each `src/features/*/popup/popup.html`, `src/offscreen/offscreen.html`) and the SW (`src/background/index.ts`). `vite.content.config.ts --mode all-frames|slack` builds each content script as a classic IIFE (content scripts can't `import`): `dist/content.js` + `dist/content.css` (translator + Web → MD selection capture, every frame) and `dist/slack-content.js` (app.slack.com). Builds are minified; watch scripts pass `--minify false`.
- **Popup shell** (`src/popup/shell.ts`): tab bar that loads each tool page in a same-origin iframe (chrome.* APIs still work, CSS/IDs stay isolated). Iframes are created lazily and auto-sized. Code inside an iframe must call `window.top.close()` to close the popup; `postMessage({ type: 'context-kit-open-tab', tool })` to the parent switches tab.
- **Messaging:** every request/response channel is a `chrome.runtime.onMessage` listener filtered by a `target` string (`onTargetMessage()` in `src/shared/messaging.ts`), with a `type` discriminant and a `Result<T>` response (`{ ok: true, ...T } | { ok: false, error }`). Targets: `context-kit-translator` (→ SW, LLM calls), `context-kit-translator-page` (popup → tab, full-page translation), `context-kit-devdy`, `context-kit-quick-send`, `context-kit-web`, `context-kit-offscreen`; toasts go SW → tab on `context-kit-toast` / `context-kit-web-toast`. Slack export streams progress over the port `slack-thread-export` (`chrome.runtime.onConnect`).
- **Offscreen document** (`src/offscreen/`): fetches Slack attachments / web images with the browser's cookies and builds zips (fflate) → blob: URL for `chrome.downloads`, or stores them in IndexedDB for the Devdy outbox. Needed because MV3 service workers can't create blob URLs and data: URLs cap at ~2 MB.
- **Styling:** `src/shared/styles/tokens.css` holds the design tokens, imported by `theme.css` (Web → MD, Slack, Devdy), the translator popup CSS and `shell.css`. In-page widgets (Shadow DOM) carry their own CSS strings.
- **Page-injected functions** (`pageSlackApi` in `slack/core/slack-client.ts`, `extractInPage` in `web-to-md/core/extract.ts`) are serialized by `chrome.scripting.executeScript({ func })`: keep them **self-contained** (no imports/closures, type-only imports are fine). `tests/minified-injection.test.ts` checks the minified versions still run standalone.

## Translator notes

- Settings: `TranslatorSettings` + `DEFAULT_SETTINGS` in `features/translator/shared/settings.ts` are the single source of keys/defaults (`loadSettings()` / `saveSettings()`); `SEEDED_SETTINGS` (no API keys) are written on install/update.
- Content script (`content/index.ts`): selection toolbar (T / G grammar in editable fields / R reverse / ➤ send to Devdy for non-editable selections) and a **Shadow DOM** result popup (query via `shadowRoot.getElementById`, not `document`). `content/page-translation.ts` walks text nodes, stores originals in `originalTexts` for revert, and a `MutationObserver` translates dynamic content — new filter logic goes in both `collectTranslatableTextNodes()` and `isTranslatableTextNode()`.
- `isExtensionAlive()` guards every chrome.* call in content scripts — keep this pattern.
- `background/index.ts` is the only place that calls LLM APIs: `getProviderConfig()` → `{ provider, url, model, headers }`, `callLLM()` (OpenAI chat completions, Gemini `generateContent`, Ollama `/api/chat`); pure helpers in `background/llm.ts`. Batch prompts use numbered `[N] text` lines.
- Ollama CORS: `declarativeNetRequest` dynamic rules (set in `onInstalled`) strip `Origin` for localhost/127.0.0.1.

## Web → MD notes

- `core/extract.ts` (injected into every frame) → `core/converter.ts` (`htmlToMarkdown`) → front matter `webFrontMatter()` (`core/web-capture.ts`, same keys as Devdy captures) built with `shared/yaml.ts` (the one YAML emitter, also used by the Slack export).
- `core/image-src.ts` (`bestImageSrc`) is shared by the converter and the selection capture.

## Slack export notes

- `pageSlackApi` runs in the app.slack.com page (MAIN world); the session token never leaves the page.
- Attachments: `core/attachments.ts` plans downloads (only `https://*.slack.com`, 25 MB per file, 200 MB total, external files skipped); `md-builder` renders saved files as local links and skipped ones with a `_(not included: …)_` note.

## Devdy integration

- "Send to Devdy" posts to Devdy's local Inbox API (`POST http://127.0.0.1:{47821..47830}/v1/{slack-threads|web-pages}`, Bearer token). Contract: `devdy/docs/inbox-api.md`. Settings live in the Devdy tab (`features/devdy/popup/`).
- Instance choice: `resolveDevdy()` uses the pinned port (`devdyPortPinned`) exclusively, otherwise the single running app; with several apps and no pin, sends stay queued (`choose_instance`) — never guess.
- All sends go through `DevdyOutbox` (`features/devdy/core/outbox.ts`): payload in IndexedDB (`core/blob-store.ts`, shared with the offscreen document which writes zips there via `store-zip`), metadata in `chrome.storage.local.devdyOutbox`. Retryable outcomes (`unreachable`, `choose_instance`, `no_token`, `unauthorized`, `server_error`) stay queued and are retried by the `devdy-outbox-retry` alarm; others are dropped.
- Quick send inside Slack: `features/slack/content/` injects "Send to Devdy" into Slack's own message menu (`message-dom.ts`: selectors try `data-qa` → `c-*` classes → ARIA; when nothing matches it does nothing) and shows toasts. `features/slack/background/quick-send.ts` runs the export (always reactions + attachments, no project). No browser context menus anywhere.
- Web pages / selections: the translator's ➤ button calls `sendSelection()` (`features/web-to-md/content/send-selection.ts`, same all-frames bundle). `features/web-to-md/background/web-capture.ts` builds the front matter, downloads images via the offscreen `fetch-image` command into `images/` and enqueues for `/v1/web-pages`. The Web → MD tab's "Send to Devdy" uses the same path (`send-page`).
- Fetches to Devdy must run in extension contexts (service worker / offscreen), never in content scripts (CORS + Private Network Access).

## Storage keys

- `chrome.storage.sync` — translator: `provider, apiKey, openaiModel, geminiApiKey, geminiModel, ollamaUrl, ollamaModel, style, targetLang, popupWidth, popupHeight` (types/defaults: `features/translator/shared/settings.ts`). Slack: `includeReactions, includeFiles, zipFiles` (`DEFAULT_OPTIONS` in `features/slack/messages.ts`).
- `chrome.storage.local` — popup shell: `contextKitLastTab`, `contextKitOpenTab` (one-shot tab to open); Devdy: `devdyToken, devdyPort, devdyPortPinned, devdyOutbox`.
- IndexedDB `context-kit` / store `devdy-outbox` — outbox payloads (Blob per entry id).
