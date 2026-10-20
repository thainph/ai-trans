# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**AI Trans** (formerly Context Kit) — a Chrome Manifest V3 extension that bundles four tabs behind one toolbar popup:

| Tab | Code | What it does |
|---|---|---|
| Translate | `src/features/translator/` | Translate selected text / whole pages via OpenAI, Gemini, local Ollama or Devdy; English grammar check |
| Web → MD | `src/features/web-to-md/` | Convert the current page to Markdown (export .md/.zip, copy) — export only |
| Slack | `src/features/slack/` | Export a Slack thread to Markdown (.md/.zip, copy); "Send to Devdy" in Slack's message menu sends the thread link |
| Devdy | `src/features/devdy/` | Devdy connection: token, app (port) choice, features, queue of Slack links |

This repo was previously the standalone AI Translator extension; its history is preserved. Everything is TypeScript (`allowJs: false`).

Human-facing docs: `README.md` (install, usage, limits), `docs/architecture.md` (internals: messaging, offscreen, image fetch policy, thread links, link queue), `CHANGELOG.md`. Keep them in sync when behaviour changes.

Naming: only user-visible text says "AI Trans". Internal ids keep the `context-kit` prefix (storage keys `contextKit*`, message targets `context-kit-*`, the `context-kit-debug` flag, `[context-kit]` logs, IIFE globals, package name) — renaming them would lose users' saved data.

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
  content/all-frames.ts entry of the <all_urls> content script (one IIFE): the translator content script
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
  features/devdy/api.ts Devdy service API for other features (outbox, openSettings, SendOutcome, DeliveryResult, devdyTranslate, devdyCheckGrammar, devdyTranslateStatus, DevdyTranslateError)
tests/                  vitest; import TS modules directly
public/                 manifest.json + icons only (copied verbatim)
```

### Dependency direction (enforced by `tests/dependencies.test.ts`)

- `src/shared/` imports nothing outside `src/shared/`.
- `src/features/<name>/` imports only `src/shared/`, its own folder, and `src/features/devdy/api.ts` (the explicit Devdy service API). Features never import each other otherwise.
- Entry points (`src/background/`, `src/offscreen/`, `src/popup/`, `src/content/`) may import shared code and features; cross-feature wiring happens there (e.g. the offscreen document serves both the Slack and the Web → MD zip exports).

## Architecture

- **Build:** `vite.config.ts` bundles the pages (`src/popup/index.html`, each `src/features/*/popup/popup.html`, `src/offscreen/offscreen.html`) and the SW (`src/background/index.ts`). `vite.content.config.ts --mode all-frames|slack` builds each content script as a classic IIFE (content scripts can't `import`): `dist/content.js` (translator, every frame; no global CSS: widgets style themselves in Shadow DOM) and `dist/slack-content.js` (app.slack.com). Builds are minified; watch scripts pass `--minify false`.
- **Popup shell** (`src/popup/shell.ts`): tab bar that loads each tool page in a same-origin iframe (chrome.* APIs still work, CSS/IDs stay isolated). Iframes are created lazily and auto-sized. Code inside an iframe must call `window.top.close()` to close the popup and `requestOpenTab(tool)` (`shared/popup-tabs.ts`) to switch tab. First tab: one-shot `contextKitOpenTab`, else Slack on app.slack.com, else `contextKitLastTab`.
- **Styling:** `src/shared/styles/tokens.css` holds the design tokens, imported by `theme.css` (Web → MD, Slack, Devdy), the translator popup CSS and `shell.css`. In-page widgets (Shadow DOM) carry their own CSS strings.
- **Page-injected functions** (`pageSlackApi` in `slack/core/slack-client.ts`, `extractInPage` in `web-to-md/core/extract.ts`) are serialized by `chrome.scripting.executeScript({ func })`: keep them **self-contained** (no imports/closures, type-only imports are fine). `tests/minified-injection.test.ts` checks the minified versions still run standalone.

## Messages and senders

- Every request/response channel is a `chrome.runtime.onMessage` listener filtered by a `target` string (`onTargetMessage()`), with a `type` discriminant and a `Result<T>` response (`{ ok: true, ...T } | { ok: false, error }`). Callers build requests as `Command<R>` (the request without `target`). Targets: `context-kit-translator` (→ SW, LLM calls), `context-kit-translator-page` (popup → tab, full-page translation), `context-kit-devdy`, `context-kit-quick-send`, `context-kit-web` (Web → MD `download-page`), `context-kit-offscreen`; toasts go SW → Slack tab with `sendToTab()` on `context-kit-toast`. The Slack export streams progress over the port `slack-thread-export` (`chrome.runtime.onConnect`); Devdy selection translations stream over one port `context-kit-translator-stream` per request (content → SW; disconnect = abort).
- Sender kinds (`src/shared/sender.ts`, one definition for every feature):
  - **extension sender** — `sender.id` is ours (any context, content scripts included);
  - **extension page** — an extension sender whose `sender.url` starts with `chrome-extension://<id>/` (popup pages, offscreen document, SW); content scripts report the web page URL, so they never qualify;
  - **content script from origin X** — an extension sender whose frame URL has exactly origin X.
- Allow-lists stay in each feature:
  - translator (`translator/background/sender.ts`): every request from extension senders, `fetch-ollama-models` / `devdy-status` from extension pages only, the stream port from extension senders (`streamPortRejectReason`, `isStreamRequest`); sizes validated (`MAX_TEXT_CHARS` 100 000, `MAX_BATCH_ITEMS` 200); `cancel` is scoped to the sending frame (`requestKey`);
  - Devdy (`context-kit-devdy`) and offscreen (`context-kit-offscreen`): extension pages only;
  - Web → MD (`context-kit-web`): `download-page` from extension pages only;
  - Slack: the export port from extension pages only; quick send (`devdy-send`, `open-settings`) only from the content script on `https://app.slack.com`, `devdy-send` only with a canonical thread link (`isCanonicalThreadLink()`, DMs refused).

## Translator notes

- Settings: `TranslatorSettings` + `DEFAULT_SETTINGS` in `features/translator/shared/settings.ts` are the single source of keys/defaults (`loadSettings()` / `saveSettings()`); `SEEDED_SETTINGS` (no API keys) are written on install/update.
- Content script (`content/index.ts`): selection toolbar (T / G grammar in editable fields / R reverse) and the result popup. Both use **closed** Shadow DOM roots (keep the returned root, `shadowRoot.getElementById`, never `document`), and every handler ignores synthetic events (`e.isTrusted`, `trusted()` wrapper) so page scripts can't drive our UI. Closing the popup or starting a new request cancels the request in flight (`cancel` → aborts the LLM fetch).
- `isExtensionAlive()` guards every chrome.* call in content scripts — keep this pattern.
- `background/index.ts` is the only place that calls LLM APIs: `getProviderConfig()` → `{ provider, url, model, headers }`, `callLLM()` (OpenAI chat completions, Gemini `generateContent`, Ollama `/api/chat`); pure helpers in `background/llm.ts`. Every fetch has a timeout (LLM 120 s, Ollama 300 s, model list 10 s). Long selections are split into ≤ 4 000-char chunks (never inside a surrogate pair).
- **Batch protocol** (`core/batch-protocol.ts`): full-page batches send a JSON array of strings and expect `{"translations": [...]}` with exactly as many strings (JSON mode per provider). `parseBatchResponse()` returns one translation or `null` per item: wrong-length arrays → all null; truncated JSON → the complete leading items; legacy `[N] text` lines are still parsed. `null` items keep their original text, are never cached, and are re-queued after 2 s up to 2 retries per text (`RetryBudget`).
- Full-page translation runs in the top frame only (popup sends with `frameId: 0`): viewport first, the rest lazily via IntersectionObserver (50 % margin); identical texts translated once (`TranslationCache`); items > 4 000 chars are skipped; lazy/dynamic flushes are debounced (400 ms), never overlap and are capped at 20 requests/min (`RateLimiter`). Originals are held in `WeakOriginals` for revert. Text filtering: `isCandidate()` + `isElementVisible()` (ancestor-aware) in `core/`.
- **Devdy provider** (`provider: 'devdy'`, `background/devdy.ts`): no LLM call; uses `devdyTranslate()` from `features/devdy/api.ts`. Only the target language is sent (`devdyTargetLang()`); engine/model/style are Devdy's (style selectors hidden). Grammar check: `checkGrammarWithDevdy()` → `devdyCheckGrammar()` (`POST /v1/grammar`), any language, ≤ 8 000-char segments, explanations in the target language; the response adds `issues`, listed by the content script outside `#result`. Selections: ≤ 8 000-char segments, sequential, streamed (`delta` / `segment` / `done` / `error` on the port; `done.text` replaces the rendered text). Page: larger batches (5 500 chars, concurrency 1) packed with `⟦i⟧` marker lines (`core/devdy-pack.ts`: `planPacks` / `packItems` / `unpackItems`). Items containing `⟦`/`⟧` or too large → `false` (untranslatable: original kept, cached, no retry). Unpacking accepts markers wrapped in Markdown or followed by text on the same line; stray/duplicated/reordered markers → `null` for the affected items (usual retry). Guarantee is structural only: text comes from a section opened by one well-formed, in-order marker for that item with no other bracket inside (no output contains a marker); it can't detect a model that swaps meanings under intact markers. Batches carry a `requestId` (cancel on revert / new run / `pagehide`; the SW stops before the next pack); a 429 after retries is pack-local.
- Batch results are `BatchTranslation` (`string | null | false`) in `shared/messages.ts`; `CANCELLED` lives there too. The stream port handler is `background/stream-port.ts` (`serveStreamPort`, chrome-free, tested).
- Ollama CORS (DNR scoping): `background/ollama-cors.ts` installs dynamic rules (ids 1–3) that strip `Origin` only on requests made by this extension (`initiatorDomains: [our id]`) to the configured Ollama origin(s) — the saved `ollamaUrl` and the URL last probed from the popup. Web pages' requests to localhost are never touched; rules are re-synced when `ollamaUrl` changes.

## Web → MD notes

- Export only (copy / .md / .zip): nothing is sent to Devdy any more (Devdy removed `POST /v1/web-pages`).
- `core/extract.ts` (injected into every frame) → `core/converter.ts` (`htmlToMarkdown`) → front matter `webFrontMatter()` (`core/web-capture.ts`) built with `shared/yaml.ts`. Text length is counted on an inert copy (no scripts run); the Claude artifact content URL comes from the tab.
- `core/image-src.ts` (`bestImageSrc`) is used by the converter. Zip download: `background/download.ts` (`download-page`) fetches images through the offscreen `fetch-image` command into `images/` (≤ 10 MB each, ≤ 200 MB total, ≤ 500 images); Markdown from the tab is capped at 30 MB (`background/limits.ts`).

## Slack export notes

- `pageSlackApi` runs in the app.slack.com page (MAIN world); the session token never leaves the page. Rate limits are waited out in the SW with keepalive pings (Retry-After ≤ 10 min).
- Attachments: `core/attachments.ts` plans downloads (only `https://*.slack.com`, 25 MB per file, 200 MB total, external files skipped); `md-builder` renders saved files as local links and skipped ones with a `_(not included: …)_` note.

## Offscreen document

- Why: MV3 service workers can't create blob: URLs and data: URLs cap at ~2 MB. `shared/offscreen/zip-job.ts` (SW side) opens the document on demand and drives jobs; `src/offscreen/` does the work.
- Zips are **streamed** (`zip-stream.ts`, fflate `Zip`): each fetched file goes straight into the job's `ZipWriter` (precompressed formats stored, others deflated), output folded into Blob parts every 8 MB, the Markdown written last. Result: a blob: URL for `chrome.downloads` (`build-zip`). If a zip can't be built the export falls back to plain Markdown.
- Downloads reserve their bytes from a shared `ByteBudget` before fetching, so parallel fetches never overshoot the total. Jobs idle for 15 min are freed.
- Lifetime: the document is closed 10 s after the last job (timer after a keepalive ping), with a `offscreen-close` alarm as fallback; a fresh service worker closes a leftover document right away.
- **Image fetch policy** (`image-fetch.ts`, `url-safety.ts`): only `http(s)` / `data:image` URLs; private, loopback, link-local, CGNAT and multicast hosts (IPv4/IPv6 literals, `localhost`, `.local`…) are refused. Cookies are sent only to images on the page's exact origin, with `redirect: 'error'` (a cookie-bearing request never follows a redirect; on failure the image is retried once without cookies). Cookie-less fetches use `redirect: 'follow'` and re-check the final URL. Limitations: Chrome hides `Location` for `redirect: 'manual'`, so intermediate hops can't be pre-checked (a cookie-less hop may reach a private host, its response is discarded); hosts are checked by name/literal only (no DNS resolution, so DNS rebinding isn't detected). A response is rejected as non-image only when its `Content-Type` isn't `image/*` and the URL has no recognisable image extension.

## Devdy integration

- Contract: Devdy Inbox API 2026-10-20 (`devdy/docs/inbox-api.md`; the link-based API lives on Devdy's `feature/slack-thread-translate` branch). Loopback `http://127.0.0.1:{47821..47830}`, Bearer token. Settings live in the Devdy tab (`features/devdy/popup/`). Other features use only `features/devdy/api.ts`.
- Instance choice: `resolveDevdy()` uses the pinned port (`devdyPortPinned`) exclusively, otherwise the single running app; with several apps and no pin, links stay queued (`choose_instance`) — never guess.
- Features: `parseHealth()` keeps `/health.features`; `supportsTranslate()` (`"translate"`), `supportsGrammar()` (`"grammar"`), `supportsSlackThreadLink()` (`"slack-thread-link"`). Without `slack-thread-link` nothing is sent (`outdated` → "Update Devdy to send Slack threads"); a new link isn't queued, already queued links wait for the update.
- **Slack thread link** (`features/slack/core/thread-link.ts` pure + `content/message-dom.ts` `threadLinkFor()`): the message's timestamp anchor permalink, normalized (`normalizeThreadLink`), else built from the message ts + channel (open thread `/thread/<C>-<root ts>` / `data-qa-channel-id` / client URL) + workspace host (anchor host, else the page's timestamp permalinks / URL via `workspaceHostFromPage()`, else `url`/`domain` of the team in Slack's `localStorage.localConfig_v2` via `workspaceHostFromLocalConfig()`, parsed with token-like keys dropped; cached per team id). Anchor choice: selectors one at a time in priority order (`a.c-timestamp` → `[data-qa="timestamp"] a` → …), anchors inside message content (`CONTENT_SELECTOR`: text, blocks, files, attachments, unfurls) ignored, and with a ts known from attributes (`data-msg-ts`, `data-item-key`, id) only a matching `p<ts>` counts. Format `https://<ws>[.enterprise].slack.com/archives/<C|G…>/p<16 digits>`, plus `?thread_ts=<root>&cid=<channel>` for a reply (thread pane message whose ts ≠ the open thread's root). DM channels (`D…`) → `{ ok: false, error: 'dm' }` → toast, nothing sent. No content, files or cookies.
- Quick send inside Slack: `features/slack/content/` injects "Send to Devdy" into Slack's own message menu (`message-dom.ts`: selectors try `data-qa` → `c-*` classes → ARIA; when nothing matches it does nothing; the cloned row's icons are stripped and replaced by the fixed ➤ SVG from `content/devdy-icon.ts`) and shows toasts. `features/slack/background/quick-send.ts` validates the URL (`isCanonicalThreadLink`), calls `outbox.send(url)` and maps the result with `toastForDelivery()` (`core/quick-send.ts`); 401 also opens the Devdy tab. No browser context menus anywhere. The Slack popup tab is export-only.
- `postSlackThread()` (`core/client.ts`): `POST /v1/slack-threads`, body `{"url"}` (≤ 16 KB), headers **only** `Authorization` + `Content-Type: application/json` (no `X-Devdy-*`, no `Idempotency-Key`). `slackThreadOutcome()`: 2xx → `created` / `existing` (+ `fetchStatus`, `errorCode` e.g. `no_token` = Devdy has no Slack token); 401 → `unauthorized`; 503 / connection error → `unreachable`; 404 / 415 → `outdated`; other (400 with `code`: `invalid_json` / `invalid_link` / `dm_unsupported` / `invalid_project` / `invalid_title`, 413, 500) → `rejected`. User texts: `describeOutcome()` (Inbox API §9.2 wording).
- **Link queue** (`features/devdy/core/outbox.ts`, `DevdyOutbox`): `chrome.storage.local.devdyLinkQueue` = `[{ id, url, createdAt, attempts, lastError }]`, state in `devdyLinkQueueState` (`paused`, `backoff`, `notice`). Serialized by one promise chain.
  - `send(url)` posts at once; retryable outcomes (`isRetryable`: `unreachable`, `choose_instance`, `token_missing`, `unauthorized`) queue it (dedupe by URL; ≤ 50 links, new ones refused when full). Anything else is reported, not queued, and removes a queued copy (except `outdated`, which keeps it). A success then delivers the older queued links.
  - `flush({auto})`: app resolution problems / outdated / no token stop the round (no attempt); posts oldest-first; `unreachable`, 401, 404/415 stop the round; links refused for good are dropped with a notice. Only `unreachable` after reaching Devdy counts an attempt. The Devdy tab's `status` request flushes at once when the app lists `slack-thread-link`, the token is valid and links are queued (`status(true)` in `background/index.ts`).
  - `unauthorized` / `token_missing` **pause** automatic retries until a token is saved. Retries use the one-shot `devdy-outbox-retry` alarm with backoff 1 → 2 → 5 → 15 → 60 min (last repeats; reset when something is sent). Bounds: 7 days, 20 attempts (dropped with a notice).
  - Migration (`core/migration.ts`, `onInstalled`): removes the ≤ 2.1 blob outbox (`devdyOutbox`, `devdyOutboxState`, IndexedDB `context-kit` — retired name); if it had entries, a one-time notice in the Devdy tab (dismissable). Runs once: flag `devdyLegacyMigrated`.
- Translation (`core/translate.ts` pure client + `SseParser`, `core/translator.ts` `DevdyTranslator`, `background/translate.ts` wiring): needs `/health` `features` ∋ `"translate"` (`supportsTranslate()`); instance cached 30 s, re-probed once after a connection error; 429 retried 3× after 1.5 s; errors are `DevdyTranslateError` (code from the HTTP status / SSE `error`, `describeTranslateError()`, `needsDevdySettings()`).
- Grammar (`core/grammar.ts` `checkGrammar()`, JSON only; `DevdyTranslator.checkGrammar()`; `devdyCheckGrammar()`): needs `"grammar"`; shares `postEngine()`, limits, retries and `DevdyTranslateError` (`task: 'grammar'` only changes the wording).
- Fetches to Devdy must run in extension contexts (service worker / offscreen), never in content scripts (CORS + Private Network Access).

## Size limits

| What | Limit | Where |
|---|---|---|
| Translator text / batch | 100 000 chars, 200 items; page items ≤ 4 000 chars | `translator/shared/messages.ts`, `translator/core/page-text.ts` |
| Slack attachments (export) | 25 MB per file, 200 MB total | `slack/core/attachments.ts` |
| Web images (zip export) | 10 MB each, 200 MB total, 500 images | `web-to-md/core/web-capture.ts` |
| Web → MD Markdown (download-page) | 30 × 1024 × 1024 chars (≈ 30 MB) | `web-to-md/background/limits.ts` |
| Devdy translation | 8 000 chars per request; page packs ≤ 6 500 chars | `devdy/core/translate.ts`, `translator/core/devdy-pack.ts` |
| Devdy link queue | 50 links, 7 days, 20 attempts | `devdy/core/outbox.ts` |

## Storage keys

- `chrome.storage.sync` — translator: `provider, apiKey, openaiModel, geminiApiKey, geminiModel, ollamaUrl, ollamaModel, style, targetLang, popupWidth, popupHeight` (types/defaults: `features/translator/shared/settings.ts`). Slack: `includeReactions, includeFiles, zipFiles` (`DEFAULT_OPTIONS` in `features/slack/messages.ts`).
- `chrome.storage.local` — popup shell: `contextKitLastTab`, `contextKitOpenTab` (one-shot tab to open; `shared/popup-tabs.ts`); Devdy: `devdyToken, devdyPort, devdyPortPinned, devdyLinkQueue` (queued Slack links), `devdyLinkQueueState` (`paused`, `backoff`, `notice`). `devdyLegacyMigrated` (migration done). Legacy (≤ 2.1, deleted once by `core/migration.ts`): `devdyOutbox`, `devdyOutboxState`, IndexedDB `context-kit`.
