# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**AI Trans** (formerly Context Kit) — a Chrome Manifest V3 extension that bundles four tabs behind one toolbar popup:

| Tab | Code | What it does |
|---|---|---|
| Translate | `src/features/translator/` | Translate selected text / whole pages via OpenAI, Gemini or local Ollama; English grammar check |
| Web → MD | `src/features/web-to-md/` | Convert the current page to Markdown (export .md/.zip, copy, send to Devdy) |
| Slack | `src/features/slack/` | Export a Slack thread to Markdown, optionally as a .zip with attachments |
| Devdy | `src/features/devdy/` | Devdy connection: token, app (port) choice, outbox queue |

This repo was previously the standalone AI Translator extension; its history is preserved. Everything is TypeScript (`allowJs: false`).

Human-facing docs: `README.md` (install, usage, limits), `docs/architecture.md` (internals: messaging, offscreen, image fetch policy, outbox), `CHANGELOG.md`. Keep them in sync when behaviour changes.

Naming: only user-visible text says "AI Trans". Internal ids keep the `context-kit` prefix (storage keys `contextKit*`, message targets `context-kit-*`, IndexedDB `context-kit`, the `context-kit-debug` flag, `[context-kit]` logs, IIFE globals, package name) — renaming them would lose users' saved data.

## Development

```bash
pnpm install
pnpm build       # typecheck + vite build (pages, SW) + content IIFEs + check:dist → dist/
pnpm dev         # = dev:all: every watcher (dev:main, dev:content, dev:slack), unminified, dist/ not wiped
pnpm test        # vitest
pnpm typecheck   # tsc --noEmit
pnpm lint        # biome check --error-on-warnings (lint + format check; warnings fail)
pnpm lint:ci     # biome ci --error-on-warnings (CI flavour, no writes)
pnpm format      # biome check --write
pnpm check:dist  # every path referenced by dist/manifest.json, HTML and code exists (also run by build)
```

Load `dist/` unpacked at `chrome://extensions/` (Developer mode). Reload the extension after rebuilding. CI (`.github/workflows/ci.yml`) runs `lint:ci`, `test`, `build` (the typecheck runs inside `build`). Lint must end with 0 warnings and 0 infos.

## Layout

```
src/
  background/index.ts   SW entry: only imports each feature's background module
  offscreen/            offscreen document: fetch files/images (image-fetch.ts, url-safety.ts), streaming zip (zip-stream.ts)
  popup/                popup shell: tab bar + one iframe per tool page
  content/all-frames.ts entry of the <all_urls> content script (one IIFE); wires the translator ➤ button to Web → MD
  shared/               feature-neutral code:
    async.ts            mapLimit (bounded concurrency, ordered results)
    bytes.ts            formatBytes, ByteBudget (shared download budget)
    errors.ts           errorMessage()
    filename.ts         safeFileName / filenamePart / isPrecompressedPath
    keepalive.ts        keepAliveSleep / chromePing (MV3 idle timer)
    messaging.ts        Result<T>, onTargetMessage, Command<R>, sendToTab
    offscreen/          protocol.ts (offscreen messages) + zip-job.ts (SW client: open/close the document, ZipJob)
    popup-tabs.ts       ToolId, LAST_TAB_KEY / OPEN_TAB_KEY, requestOpenTab()
    runtime.ts          isExtensionAlive()
    sender.ts           sender kinds (see "Messages and senders")
    toast.ts            in-page toast (Shadow DOM)
    yaml.ts             the one YAML front matter emitter
    styles/             tokens.css (design tokens) + theme.css
  features/<feature>/
    core/               pure logic (unit-tested, no chrome.*)
    background/         service-worker side (listeners, allow-lists)
    content/            content-script side
    popup/              the tab's page (html + ts)
    messages.ts         the feature's message types (translator: shared/{messages,settings}.ts)
  features/devdy/api.ts Devdy service API for other features (outbox, openSettings, SendOutcome, DevdyDelivery, DEVDY_MAX_ATTACHMENTS)
tests/                  vitest; import TS modules directly
public/                 manifest.json + icons only (copied verbatim)
```

### Dependency direction (enforced by `tests/dependencies.test.ts`)

- `src/shared/` imports nothing outside `src/shared/`.
- `src/features/<name>/` imports only `src/shared/`, its own folder, and `src/features/devdy/api.ts` (the explicit Devdy service API). Features never import each other otherwise.
- Entry points (`src/background/`, `src/offscreen/`, `src/popup/`, `src/content/`) may import shared code and features; cross-feature wiring happens there (e.g. `content/all-frames.ts` calls `setSelectionSender(sendSelection)`).

## Architecture

- **Build:** `vite.config.ts` bundles the pages (`src/popup/index.html`, each `src/features/*/popup/popup.html`, `src/offscreen/offscreen.html`) and the SW (`src/background/index.ts`). `vite.content.config.ts --mode all-frames|slack` builds each content script as a classic IIFE (content scripts can't `import`): `dist/content.js` (translator + Web → MD selection capture, every frame; no global CSS: widgets style themselves in Shadow DOM) and `dist/slack-content.js` (app.slack.com). Builds are minified; watch scripts pass `--minify false`.
- **Popup shell** (`src/popup/shell.ts`): tab bar that loads each tool page in a same-origin iframe (chrome.* APIs still work, CSS/IDs stay isolated). Iframes are created lazily and auto-sized. Code inside an iframe must call `window.top.close()` to close the popup and `requestOpenTab(tool)` (`shared/popup-tabs.ts`) to switch tab. First tab: one-shot `contextKitOpenTab`, else Slack on app.slack.com, else `contextKitLastTab`.
- **Styling:** `src/shared/styles/tokens.css` holds the design tokens, imported by `theme.css` (Web → MD, Slack, Devdy), the translator popup CSS and `shell.css`. In-page widgets (Shadow DOM) carry their own CSS strings.
- **Page-injected functions** (`pageSlackApi` in `slack/core/slack-client.ts`, `extractInPage` in `web-to-md/core/extract.ts`) are serialized by `chrome.scripting.executeScript({ func })`: keep them **self-contained** (no imports/closures, type-only imports are fine). `tests/minified-injection.test.ts` checks the minified versions still run standalone.

## Messages and senders

- Every request/response channel is a `chrome.runtime.onMessage` listener filtered by a `target` string (`onTargetMessage()`), with a `type` discriminant and a `Result<T>` response (`{ ok: true, ...T } | { ok: false, error }`). Callers build requests as `Command<R>` (the request without `target`). Targets: `context-kit-translator` (→ SW, LLM calls), `context-kit-translator-page` (popup → tab, full-page translation), `context-kit-devdy`, `context-kit-quick-send`, `context-kit-web`, `context-kit-offscreen`; toasts go SW → tab with `sendToTab()` on `context-kit-toast` / `context-kit-web-toast`. The Slack export streams progress over the port `slack-thread-export` (`chrome.runtime.onConnect`).
- Sender kinds (`src/shared/sender.ts`, one definition for every feature):
  - **extension sender** — `sender.id` is ours (any context, content scripts included);
  - **extension page** — an extension sender whose `sender.url` starts with `chrome-extension://<id>/` (popup pages, offscreen document, SW); content scripts report the web page URL, so they never qualify;
  - **content script from origin X** — an extension sender whose frame URL has exactly origin X.
- Allow-lists stay in each feature:
  - translator (`translator/background/sender.ts`): every request from extension senders, `fetch-ollama-models` from extension pages only; sizes validated (`MAX_TEXT_CHARS` 100 000, `MAX_BATCH_ITEMS` 200); `cancel` is scoped to the sending frame (`requestKey`);
  - Devdy (`context-kit-devdy`) and offscreen (`context-kit-offscreen`): extension pages only;
  - Web → MD (`context-kit-web`): `send-selection` / `open-settings` from any of our content scripts, `send-page` / `download-page` from extension pages only;
  - Slack: the export port from extension pages only; quick send (`devdy-send`, `open-settings`) only from the content script on `https://app.slack.com`.

## Translator notes

- Settings: `TranslatorSettings` + `DEFAULT_SETTINGS` in `features/translator/shared/settings.ts` are the single source of keys/defaults (`loadSettings()` / `saveSettings()`); `SEEDED_SETTINGS` (no API keys) are written on install/update.
- Content script (`content/index.ts`): selection toolbar (T / G grammar in editable fields / R reverse / ➤ send to Devdy for non-editable selections, when wired) and the result popup. Both use **closed** Shadow DOM roots (keep the returned root, `shadowRoot.getElementById`, never `document`), and every handler ignores synthetic events (`e.isTrusted`, `trusted()` wrapper) so page scripts can't drive our UI. Closing the popup or starting a new request cancels the request in flight (`cancel` → aborts the LLM fetch).
- `isExtensionAlive()` guards every chrome.* call in content scripts — keep this pattern.
- `background/index.ts` is the only place that calls LLM APIs: `getProviderConfig()` → `{ provider, url, model, headers }`, `callLLM()` (OpenAI chat completions, Gemini `generateContent`, Ollama `/api/chat`); pure helpers in `background/llm.ts`. Every fetch has a timeout (LLM 120 s, Ollama 300 s, model list 10 s). Long selections are split into ≤ 4 000-char chunks.
- **Batch protocol** (`core/batch-protocol.ts`): full-page batches send a JSON array of strings and expect `{"translations": [...]}` with exactly as many strings (JSON mode per provider). `parseBatchResponse()` returns one translation or `null` per item: wrong-length arrays → all null; truncated JSON → the complete leading items; legacy `[N] text` lines are still parsed. `null` items keep their original text, are never cached, and are re-queued after 2 s up to 2 retries per text (`RetryBudget`).
- Full-page translation runs in the top frame only (popup sends with `frameId: 0`): viewport first, the rest lazily via IntersectionObserver (50 % margin); identical texts translated once (`TranslationCache`); items > 4 000 chars are skipped; lazy/dynamic flushes are debounced (400 ms), never overlap and are capped at 20 requests/min (`RateLimiter`). Originals are held in `WeakOriginals` for revert. Text filtering: `isCandidate()` + `isElementVisible()` (ancestor-aware) in `core/`.
- Ollama CORS (DNR scoping): `background/ollama-cors.ts` installs dynamic rules (ids 1–3) that strip `Origin` only on requests made by this extension (`initiatorDomains: [our id]`) to the configured Ollama origin(s) — the saved `ollamaUrl` and the URL last probed from the popup. Web pages' requests to localhost are never touched; rules are re-synced when `ollamaUrl` changes.

## Web → MD notes

- `core/extract.ts` (injected into every frame) → `core/converter.ts` (`htmlToMarkdown`) → front matter `webFrontMatter()` (`core/web-capture.ts`, same keys as Devdy captures) built with `shared/yaml.ts`. Text length is counted on an inert copy (no scripts run); the Claude artifact content URL comes from the tab.
- `core/image-src.ts` (`bestImageSrc`) is shared by the converter and the selection capture.
- Selection capture (`content/send-selection.ts`): `blob:` images are inlined as data URLs (≤ 5 MB each, ≤ 10 MB per selection); Markdown sent to the background is capped at 30 MB (`background/limits.ts`).

## Slack export notes

- `pageSlackApi` runs in the app.slack.com page (MAIN world); the session token never leaves the page. Rate limits are waited out in the SW with keepalive pings (Retry-After ≤ 10 min).
- Attachments: `core/attachments.ts` plans downloads (only `https://*.slack.com`, 25 MB per file, 200 MB total, external files skipped); `md-builder` renders saved files as local links and skipped ones with a `_(not included: …)_` note. Sends to Devdy are capped at 45 MB / 199 attachments.

## Offscreen document

- Why: MV3 service workers can't create blob: URLs and data: URLs cap at ~2 MB. `shared/offscreen/zip-job.ts` (SW side) opens the document on demand and drives jobs; `src/offscreen/` does the work.
- Zips are **streamed** (`zip-stream.ts`, fflate `Zip`): each fetched file goes straight into the job's `ZipWriter` (precompressed formats stored, others deflated), output folded into Blob parts every 8 MB, the Markdown written last. Result: a blob: URL for `chrome.downloads` (`build-zip`) or a Blob in IndexedDB for the outbox (`store-zip`). If a zip can't be built the export falls back to plain Markdown.
- Downloads reserve their bytes from a shared `ByteBudget` before fetching, so parallel fetches never overshoot the total. Jobs idle for 15 min are freed.
- Lifetime: the document is closed 10 s after the last job (timer after a keepalive ping), with a `offscreen-close` alarm as fallback; a fresh service worker closes a leftover document right away.
- **Image fetch policy** (`image-fetch.ts`, `url-safety.ts`): only `http(s)` / `data:image` URLs; private, loopback, link-local, CGNAT and multicast hosts (IPv4/IPv6 literals, `localhost`, `.local`…) are refused. Cookies are sent only to images on the page's exact origin, with `redirect: 'error'` (a cookie-bearing request never follows a redirect; on failure the image is retried once without cookies). Cookie-less fetches use `redirect: 'follow'` and re-check the final URL. Limitations: Chrome hides `Location` for `redirect: 'manual'`, so intermediate hops can't be pre-checked (a cookie-less hop may reach a private host, its response is discarded); hosts are checked by name/literal only (no DNS resolution, so DNS rebinding isn't detected). A response is rejected as non-image only when its `Content-Type` isn't `image/*` and the URL has no recognisable image extension.

## Devdy integration

- "Send to Devdy" posts to Devdy's local Inbox API (`POST http://127.0.0.1:{47821..47830}/v1/{slack-threads|web-pages}`, Bearer token, body ≤ 50 MB). Contract: `devdy/docs/inbox-api.md`. Settings live in the Devdy tab (`features/devdy/popup/`). Other features use only `features/devdy/api.ts`.
- Instance choice: `resolveDevdy()` uses the pinned port (`devdyPortPinned`) exclusively, otherwise the single running app; with several apps and no pin, sends stay queued (`choose_instance`) — never guess.
- **Outbox** (`features/devdy/core/outbox.ts`, `DevdyOutbox`): every export is stored first — payload in IndexedDB (`core/blob-store.ts`, also written by the offscreen `store-zip`), metadata in `chrome.storage.local.devdyOutbox`, retry state in `devdyOutboxState`.
  - Retryable outcomes (`unreachable`, `choose_instance`, `no_token`, `unauthorized`, `server_error`) stay queued. Retries use the one-shot `devdy-outbox-retry` alarm with backoff 1 → 2 → 5 → 15 → 60 min (last repeats; reset when something is sent).
  - `unauthorized` / `no_token` **pause** automatic retries until a token is saved (`unauthorized` doesn't count as an attempt). `unreachable` / `choose_instance` / token problems stop the current flush; a `server_error` only counts an attempt for that entry and the flush continues with the next one (one bad payload doesn't block the queue).
  - Payloads Devdy refuses (400/413/415…) become **failed records** (never retried) that the Devdy tab can download or remove; at most 20 are kept.
  - Bounds: queued exports are dropped after 7 days or 20 attempts (a notice is shown); failed records also expire after 7 days; total payload ≤ 300 MB (oldest failed records are evicted first, queued exports never; if that is not enough the new export is refused with "queue is full").
  - Idempotency: posts carry `Idempotency-Key: <entry id>`, and the list is saved right after each delivery, so a worker killed mid-flush doesn't resend.
  - Orphan cleanup: blobs not referenced by the outbox are deleted on startup/install and before each flush; `outbox.hold(id)` protects a zip being written before `enqueue`.
- Quick send inside Slack: `features/slack/content/` injects "Send to Devdy" into Slack's own message menu (`message-dom.ts`: selectors try `data-qa` → `c-*` classes → ARIA; when nothing matches it does nothing) and shows toasts. `features/slack/background/quick-send.ts` runs the export (always reactions + attachments, no project). No browser context menus anywhere.
- Web pages / selections: the ➤ button (wired in `content/all-frames.ts`) calls `sendSelection()` (`features/web-to-md/content/send-selection.ts`). `features/web-to-md/background/web-capture.ts` builds the front matter, downloads images via the offscreen `fetch-image` command into `images/` (≤ 10 MB each, ≤ 45 MB total, ≤ 199 images) and enqueues for `/v1/web-pages`. The Web → MD tab's "Send to Devdy" uses the same path (`send-page`).
- Fetches to Devdy must run in extension contexts (service worker / offscreen), never in content scripts (CORS + Private Network Access).

## Size limits

| What | Limit | Where |
|---|---|---|
| Translator text / batch | 100 000 chars, 200 items; page items ≤ 4 000 chars | `translator/shared/messages.ts`, `translator/core/page-text.ts` |
| Slack attachments (export) | 25 MB per file, 200 MB total | `slack/core/attachments.ts` |
| Slack → Devdy | 45 MB total, 199 attachments | `slack/background/export.ts`, `devdy/core/client.ts` |
| Web images | 10 MB each, 45 MB total, 199 images | `web-to-md/core/web-capture.ts` |
| Inlined `blob:` images (selection) | 5 MB each, 10 MB total | `web-to-md/content/send-selection.ts` |
| Captured Markdown | 30 × 1024 × 1024 chars (≈ 30 MB) | `web-to-md/background/limits.ts` |
| Devdy request body | 50 MB | `devdy/core/client.ts` |
| Outbox | 300 MB, 7 days, 20 attempts, 20 failed records | `devdy/core/outbox.ts` |

## Storage keys

- `chrome.storage.sync` — translator: `provider, apiKey, openaiModel, geminiApiKey, geminiModel, ollamaUrl, ollamaModel, style, targetLang, popupWidth, popupHeight` (types/defaults: `features/translator/shared/settings.ts`). Slack: `includeReactions, includeFiles, zipFiles` (`DEFAULT_OPTIONS` in `features/slack/messages.ts`).
- `chrome.storage.local` — popup shell: `contextKitLastTab`, `contextKitOpenTab` (one-shot tab to open; `shared/popup-tabs.ts`); Devdy: `devdyToken, devdyPort, devdyPortPinned, devdyOutbox` (entries), `devdyOutboxState` (`paused`, `backoff`, `notice`).
- IndexedDB `context-kit` / store `devdy-outbox` — outbox payloads (Blob per entry id).
