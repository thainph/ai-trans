# AI Trans architecture

For developers: how the parts of the extension talk to each other and the main technical decisions. Usage is in the
[README](../README.md); conventions for coding agents are in [CLAUDE.md](../CLAUDE.md).

## Overview

```
popup shell (src/popup) ── iframe ──► each tab's page (features/*/popup)
        │                                   │ chrome.runtime.sendMessage / port
        ▼                                   ▼
service worker (src/background) ──► offscreen document (src/offscreen): fetch files/images, build zips
        ▲                                   │
        │ messages                          └──► IndexedDB (Devdy outbox) / blob: URL for chrome.downloads
content scripts (content.js in every frame, slack-content.js on app.slack.com)
```

- The **service worker** (`src/background/index.ts`) only imports each feature's background module. It is the only place
  that calls LLMs and Devdy (together with the offscreen document) — never content scripts (CORS and Chrome's Private
  Network Access rules).
- The **offscreen document** exists because MV3 service workers can't create `blob:` URLs and `data:` URLs cap at about
  2 MB.
- **Content scripts** are built as IIFEs (`vite.content.config.ts`) because content scripts can't `import`:
  `dist/content.js` (Translator + selection capture, every frame) and `dist/slack-content.js` (app.slack.com).

## Popup shell

`src/popup/shell.ts` loads each tool page in an iframe on the extension's own origin, so `chrome.*` APIs still work while
the tools' CSS and IDs stay isolated. Iframes are created lazily (first time a tab is opened) and auto-sized.

- First tab: the one-shot requested tab (`contextKitOpenTab`, e.g. from "Open Devdy settings"), else **Slack** when the
  active browser tab is on `https://app.slack.com/`, else the last used tab (`contextKitLastTab`).
- Code inside an iframe closes the popup with `window.top.close()` and switches tabs with `requestOpenTab(tool)`
  (`src/shared/popup-tabs.ts`).

## Messages and sender checks

### Channels

Each request/response channel is a `chrome.runtime.onMessage` listener filtered by a `target` string
(`onTargetMessage()` in `src/shared/messaging.ts`). Responses are always a `Result<T>`: `{ ok: true, ... }` or
`{ ok: false, error }`. Callers build requests as `Command<R>` (the request without its `target`).

| Target | Direction | Used for |
|---|---|---|
| `context-kit-translator` | content script / popup → SW | translate, grammar check, page batches, cancel, list Ollama models |
| `context-kit-translator-page` | Translate tab → tab (frame 0) | translate / revert the whole page |
| `context-kit-devdy` | Devdy tab → SW | status, save token, pick app, retry, remove/download failed records |
| `context-kit-quick-send` | Slack content script → SW | "Send to Devdy" in Slack's menu |
| `context-kit-web` | content script / Web → MD tab → SW | send selection, send/download page, open Devdy settings |
| `context-kit-offscreen` | SW → offscreen | `fetch-file`, `fetch-image`, `build-zip`, `store-zip`, `release` |
| `context-kit-toast`, `context-kit-web-toast` | SW → tab (`sendToTab()`) | in-page progress/result toasts |

The Slack export started from the Slack tab streams progress over the **port** `slack-thread-export`
(`chrome.runtime.onConnect`).

### Sender kinds

Defined once in `src/shared/sender.ts`:

- **extension sender** — `sender.id` is this extension's ID (any context, content scripts included).
- **extension page** — an extension sender whose `sender.url` starts with `chrome-extension://<id>/` (popup, offscreen
  document, service worker). Content scripts report the web page's URL, so they never qualify.
- **content script from origin X** — an extension sender running in a frame whose origin is exactly X.

### Allow-lists (kept in each feature)

| Channel | Allowed |
|---|---|
| Translator (`translator/background/sender.ts`) | any extension sender; `fetch-ollama-models` from extension pages only. Sizes are validated (text ≤ 100 000 chars, batch ≤ 200 items and ≤ 100 000 chars in total). `cancel` only reaches requests of the sending frame (`requestKey`). |
| Devdy, offscreen | extension pages only |
| Web → MD | `send-selection` / `open-settings` from content scripts; `send-page` / `download-page` from extension pages only. Incoming Markdown ≤ 30 × 1024 × 1024 chars (`background/limits.ts`). |
| Slack | the export port from extension pages only; quick send only from the content script on `https://app.slack.com` |

## Translator

- **Settings:** types + defaults live only in `features/translator/shared/settings.ts` (`loadSettings()` /
  `saveSettings()`). On install/update only `SEEDED_SETTINGS` are written (never API keys).
- **LLM calls** happen only in `background/index.ts`: OpenAI chat completions, Gemini `generateContent`, Ollama
  `/api/chat`. Timeouts: 120 s (Ollama 300 s, model list 10 s). Long selections are split into ≤ 4 000-char chunks.
- **In-page UI** (floating toolbar and result popup) uses **closed** Shadow DOM — page scripts can't read or change it.
  Every handler ignores synthetic events (`e.isTrusted`), so a page can't click for the user. Closing the popup or
  starting a new request sends `cancel`, which aborts the LLM fetch in flight.
- **Page translation** (`content/page-translation.ts`):
  - Runs in the top frame only (the popup sends with `frameId: 0`); iframes don't translate themselves.
  - Visible content first; the rest when scrolled near (`IntersectionObserver`, 50 % margin).
  - Identical texts are translated once (`TranslationCache`); segments over 4 000 chars are skipped.
  - Batches hold at most 60 segments / ~3 000 chars. Lazy and dynamic content is debounced (400 ms), flushes never
    overlap and are capped at 20 requests/minute (`RateLimiter`).
  - Originals are kept in `WeakOriginals` for revert.
- **Batch protocol** (`core/batch-protocol.ts`): a batch is sent as a JSON array of strings and must come back as
  `{"translations": [...]}` with exactly as many strings (JSON mode per provider). `parseBatchResponse()` returns one
  translation or `null` per item: wrong length → all `null`; truncated JSON → the complete leading items; the legacy
  `[N] text` format is still parsed. `null` items keep their original text, are never cached and are retried after 2 s,
  at most 2 times per text (`RetryBudget`).
- **Ollama CORS** (`background/ollama-cors.ts`): Ollama rejects requests with an unknown `Origin` header. The extension
  installs dynamic `declarativeNetRequest` rules (ids 1–3) that remove `Origin` only on requests **made by this
  extension** (`initiatorDomains: [extension id]`) to the configured Ollama origin(s) — the saved `ollamaUrl` and the URL
  last probed from the popup. Web pages' requests to localhost are never touched. Rules are re-synced when `ollamaUrl`
  changes.

## Web → MD

- Pipeline: `core/extract.ts` (runs in every frame) → `core/converter.ts` (`htmlToMarkdown`) → front matter
  `webFrontMatter()` (`core/web-capture.ts`) emitted with `src/shared/yaml.ts`.
- Two-pass extraction: pass 1 asks every frame for metadata + text length only (counted on an inert copy, no scripts
  run); pass 2 fetches the HTML of the frame with the most text (e.g. an artifact iframe beats its shell page). Metadata
  prefers the top frame.
- Claude artifacts living in an unreadable iframe: the popup offers to open the content page (URL taken from the tab).
- Selection capture (`content/send-selection.ts`): `blob:` images are inlined as data URLs (≤ 5 MB each, ≤ 10 MB per
  selection).

## Slack

- `pageSlackApi` (`core/slack-client.ts`) runs in the app.slack.com page (`MAIN` world) with the user's session; the
  Slack token never leaves the page. Rate limits are waited out in the service worker following `Retry-After`
  (≤ 10 minutes) with keepalive pings.
- Attachments: `core/attachments.ts` plans downloads (only `https://*.slack.com`, 25 MB per file, 200 MB total; external
  files such as Google Drive are skipped). `md-builder` renders saved files as relative links and skipped ones with a
  `_(not included: …)_` note. Sends to Devdy are capped at 45 MB / 199 files.
- Quick send inside Slack (`content/`): `message-dom.ts` finds the message menu via `data-qa` → `c-*` classes → ARIA;
  when nothing matches it does nothing. "Send to Devdy" is inserted right after "Copy link" (or at the end of the menu).

## Offscreen document

- **Streamed zips** (`zip-stream.ts`, fflate `Zip`): each fetched file goes straight into the job's `ZipWriter`
  (precompressed formats such as png/jpg/pdf/zip are stored, others deflated); output is folded into Blob parts every
  8 MB; the Markdown file is written **last**. The result is a `blob:` URL for `chrome.downloads` (`build-zip`) or a Blob
  stored in IndexedDB for the outbox (`store-zip`). If a zip can't be built, the export falls back to plain Markdown.
- Parallel downloads reserve their bytes from a shared `ByteBudget` before fetching, so the total limit is never
  exceeded. Each fetch times out after 120 s. Jobs idle for 15 minutes are freed.
- **Lifetime:** the document is closed 10 s after the last job (a timer started after a keepalive ping), with an
  `offscreen-close` alarm as fallback; a fresh service worker with no job closes a leftover document right away.

### Web image fetch policy (`image-fetch.ts`, `url-safety.ts`)

- Only `http(s)` or `data:image/…` URLs; URLs carrying credentials are refused.
- Private hosts are refused: loopback, private ranges, link-local, CGNAT (100.64/10), multicast (IPv4/IPv6 literals),
  `localhost`, `*.localhost`, `*.local`.
- **Cookies** are sent only for images on the page's exact origin, with `redirect: 'error'` — a cookie-bearing request
  never follows a redirect; on failure the image is fetched once more without cookies.
- Cookie-less requests use `redirect: 'follow'` and the final URL is checked again; a private final host discards the
  response.
- A response is rejected as non-image only when its `Content-Type` isn't `image/*` **and** the URL has no recognisable
  image extension.
- Known limitations:
  - Chrome hides `Location` for `redirect: 'manual'` (an `opaqueredirect` response), so intermediate hops can't be
    checked beforehand: a cookie-less hop may reach a private host, but its response is discarded.
  - Hosts are checked by name/literal only, without DNS resolution (extensions have no DNS API), so a public name
    resolving to a private IP, or DNS rebinding, is not detected.

## Devdy

- Sends go to the local Inbox API: `POST http://127.0.0.1:{47821..47830}/v1/{slack-threads|web-pages}`,
  `Authorization: Bearer <token>`, body ≤ 50 MB. Apps are discovered with `GET /health` (800 ms timeout) on that port
  range. API contract: `devdy/docs/inbox-api.md` (Devdy repo).
- App choice (`resolveDevdy()`): a pinned port (`devdyPortPinned`) is used exclusively; otherwise the single running app;
  several apps and no pin → sends stay queued (`choose_instance`), never guessed.
- Other features only use `features/devdy/api.ts`.

### Outbox (`features/devdy/core/outbox.ts`)

Every export is stored before it is sent: payload in IndexedDB `context-kit` / store `devdy-outbox`
(`core/blob-store.ts`; the offscreen `store-zip` writes there too), metadata in `chrome.storage.local.devdyOutbox`,
retry state in `devdyOutboxState` (`paused`, `backoff`, `notice`).

- Every read-modify-write of the list and every delivery round runs serially (one promise chain).
- Entries are sent oldest first. Before sending, the app is resolved: none (`unreachable`), several (`choose_instance`)
  or no token (`no_token`) → the round stops without counting an attempt.
- Per-export outcome:
  - `created` / `updated` → removed from the list and **saved immediately** (a worker killed mid-round doesn't resend),
    then the blob is deleted;
  - `server_error` (5xx) → counts one attempt for that export, the round **continues** with the next one;
  - `unauthorized` (401) → no attempt counted, the round stops;
  - `rejected` (400/403/413/415…) → becomes a **failed record** (never retried).
- After a round: `unauthorized` / `no_token` **pause** automatic retries until a token is saved. With entries still
  queued, the one-shot alarm `devdy-outbox-retry` is scheduled with backoff 1 → 2 → 5 → 15 → 60 minutes (the last step
  repeats; back to the first step once something is sent). Saving a token, picking an app or *Retry now* sends at once.
- `Idempotency-Key: <export id>` lets Devdy drop duplicates after a crash.
- Bounds:
  - queued exports older than 7 days or with 20 attempts are dropped (with a notice in the Devdy tab); failed records
    also expire after 7 days;
  - at most 20 failed records are kept (newest);
  - total size ≤ 300 MB: to make room the oldest failed records are evicted first, queued exports never; if that is not
    enough the new export is **refused** ("queue is full").
- Cleanup: blobs not referenced by any entry are deleted on startup/install and before each round; `outbox.hold(id)`
  protects a zip being written before `enqueue`.

## Build

- `vite.config.ts` builds the pages (`src/popup/index.html`, `src/features/*/popup/popup.html`,
  `src/offscreen/offscreen.html`) and the service worker. `vite.content.config.ts --mode all-frames|slack` builds each
  content script as an IIFE. Builds are minified; watch scripts pass `--minify false` and don't wipe `dist/`.
- Functions injected with `chrome.scripting.executeScript({ func })` (`pageSlackApi`, `extractInPage`) are serialized
  to a string: keep them **self-contained** (no imports/closures; type-only imports are fine).
  `tests/minified-injection.test.ts` checks that the minified versions still run standalone.
- `scripts/check-dist.mjs` checks that every file referenced by `dist/manifest.json`, the HTML and the code exists.
