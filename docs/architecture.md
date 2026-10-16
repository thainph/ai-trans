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
        │ messages                          └──► blob: URL for chrome.downloads
content scripts (content.js in every frame, slack-content.js on app.slack.com)
```

- The **service worker** (`src/background/index.ts`) only imports each feature's background module. It is the only place
  that calls LLMs and Devdy (together with the offscreen document) — never content scripts (CORS and Chrome's Private
  Network Access rules).
- The **offscreen document** exists because MV3 service workers can't create `blob:` URLs and `data:` URLs cap at about
  2 MB.
- **Content scripts** are built as IIFEs (`vite.content.config.ts`) because content scripts can't `import`:
  `dist/content.js` (Translator, every frame) and `dist/slack-content.js` (app.slack.com).

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
| `context-kit-translator` | content script / popup → SW | translate, grammar check, page batches, cancel, list Ollama models, Devdy status, open the Devdy tab |
| `context-kit-translator-page` | Translate tab → tab (frame 0) | translate / revert the whole page |
| `context-kit-devdy` | Devdy tab → SW | status (connection, features, queue), save token, pick app, retry, remove a queued link, dismiss the notice |
| `context-kit-quick-send` | Slack content script → SW | "Send to Devdy" in Slack's menu (`devdy-send` with the thread `url`), open the Devdy tab |
| `context-kit-web` | Web → MD tab → SW | `download-page` (zip the page with its images) |
| `context-kit-offscreen` | SW → offscreen | `fetch-file`, `fetch-image`, `build-zip`, `release` |
| `context-kit-toast` | SW → Slack tab (`sendToTab()`) | in-page progress/result toasts |

The Slack export started from the Slack tab streams progress over the **port** `slack-thread-export`
(`chrome.runtime.onConnect`). Streamed selection translations (Devdy provider) use one **port**
`context-kit-translator-stream` per request (content script → SW): one `translate` message in, `delta` / `segment`
events then exactly one `done` or `error` out; disconnecting the port aborts the request.

### Sender kinds

Defined once in `src/shared/sender.ts`:

- **extension sender** — `sender.id` is this extension's ID (any context, content scripts included).
- **extension page** — an extension sender whose `sender.url` starts with `chrome-extension://<id>/` (popup, offscreen
  document, service worker). Content scripts report the web page's URL, so they never qualify.
- **content script from origin X** — an extension sender running in a frame whose origin is exactly X.

### Allow-lists (kept in each feature)

| Channel | Allowed |
|---|---|
| Translator (`translator/background/sender.ts`) | any extension sender; `fetch-ollama-models` and `devdy-status` from extension pages only; the stream port from any extension sender (`streamPortRejectReason`), its `translate` message validated like `translate` (`isStreamRequest`). Sizes are validated (text ≤ 100 000 chars, batch ≤ 200 items and ≤ 100 000 chars in total). `cancel` only reaches requests of the sending frame (`requestKey`); `translate`, `grammar-check` and `translate-batch` take an optional `requestId` for it. |
| Devdy, offscreen | extension pages only |
| Web → MD | `download-page` from extension pages only. Incoming Markdown ≤ 30 × 1024 × 1024 chars (`background/limits.ts`). |
| Slack | the export port from extension pages only; quick send only from the content script on `https://app.slack.com`, and `devdy-send` only with a canonical thread link (`isCanonicalThreadLink()`; DMs refused) |

## Translator

- **Settings:** types + defaults live only in `features/translator/shared/settings.ts` (`loadSettings()` /
  `saveSettings()`). On install/update only `SEEDED_SETTINGS` are written (never API keys).
- **LLM calls** happen only in `background/index.ts`: OpenAI chat completions, Gemini `generateContent`, Ollama
  `/api/chat`. Timeouts: 120 s (Ollama 300 s, model list 10 s). Long selections are split into ≤ 4 000-char chunks
  (never inside a UTF-16 surrogate pair).
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
  at most 2 times per text (`RetryBudget`). A provider may also answer `false` for an item (`BatchTranslation`): it can't take that text, so the original is kept and cached without retries.
- **Devdy provider** (`provider: 'devdy'`, `background/devdy.ts`): no LLM call — requests go through the Devdy service
  API (`features/devdy/api.ts`: `devdyTranslate`, `devdyTranslateStatus`, `openSettings`). Engine/model/style are
  Devdy's; only the target language is sent (`devdyTargetLang()`: `vi en ja zh ko fr de es` codes, else the English
  name). Grammar check throws (the G button is shown disabled), the style selectors are hidden.
  - Selection: the content script opens the stream port; the SW splits the text into ≤ 8 000-char segments
    (`splitForTranslation`), translates them **sequentially** over SSE, posts each `delta`, a `segment` when one part is
    final and `done` with the full text (the popup replaces what it rendered). The non-streamed `translate` request
    works too (JSON mode).
  - Page (`core/devdy-pack.ts`): Devdy only translates plain text with its own prompt and serializes requests, so the
    content script sends larger batches (≤ 5 500 chars, concurrency 1) and the SW packs each batch into one Markdown
    document — a marker line `⟦i⟧` before each item (`packItems`), ≤ 6 500 chars per request (`planPacks`). Items that
    contain `⟦` / `⟧` themselves or are too large are not sent and come back as `false` (*untranslatable*: the content
    script keeps the original and caches it, no retry).
  - `unpackItems()` reads the reply line by line. A marker may start a line, wrapped in Markdown the model may add
    (`**⟦1⟧**`, `` `⟦1⟧` ``, `\⟦1\⟧`, `# `, `- `), with full-width digits, and may be followed by the item's text
    (`⟦1⟧ Sign in`). Any other `⟦`/`⟧` in a line (a marker inside the text, two markers on a line) makes the current
    item and the item it names `null`; duplicated or reordered markers make both sides `null`; text after an unknown
    marker is dropped; missing or empty sections are `null`.
  - The guarantee is structural: an item only gets text from a section opened by one well-formed marker for exactly
    that item, seen once and in increasing order, with no other bracket inside — so no returned text contains a
    marker. It can't detect a model that keeps the markers but moves one item's meaning under another item's marker.
    It also relies on the model keeping the markers at all (Devdy's prompt says to keep Markdown, not guaranteed);
    `null` items follow the usual retry path.
  - A pack failing with an engine error / timeout / 429 after retries leaves its items `null`; connection, token and
    engine-unavailable errors fail the batch. Batches carry a `requestId` and are cancellable: revert, a new run and
    `pagehide` (navigation / tab close) send `cancel`, and the SW stops before the next pack.
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
- Export only (copy, `.md`, or `.zip` with `images/`): `background/download.ts` fetches the images in the offscreen
  document (≤ 10 MB each, ≤ 200 MB total, ≤ 500 images) and saves the zip. Web pages are no longer sent to Devdy (its
  `POST /v1/web-pages` was removed).

## Slack

- `pageSlackApi` (`core/slack-client.ts`) runs in the app.slack.com page (`MAIN` world) with the user's session; the
  Slack token never leaves the page. Rate limits are waited out in the service worker following `Retry-After`
  (≤ 10 minutes) with keepalive pings.
- Attachments: `core/attachments.ts` plans downloads (only `https://*.slack.com`, 25 MB per file, 200 MB total; external
  files such as Google Drive are skipped). `md-builder` renders saved files as relative links and skipped ones with a
  `_(not included: …)_` note.
- "Send to Devdy" inside Slack (`content/`): `message-dom.ts` finds the message menu via `data-qa` → `c-*` classes →
  ARIA; when nothing matches it does nothing. The item is inserted right after "Copy link" (or at the end of the menu)
  with a fixed ➤ icon (`content/devdy-icon.ts`).
- **Thread link** (`threadLinkFor()` in `content/message-dom.ts`, pure builders in `core/thread-link.ts`), computed
  when the menu opens:
  1. the message's timestamp anchor (`…/archives/<channel>/p<16 digits>`; Slack adds `?thread_ts=<root>&cid=<channel>`
     for replies) is parsed and rebuilt canonically (unknown query parameters dropped);
  2. otherwise the link is built from the message ts (`data-msg-ts` / `data-item-key`…), the channel (open thread
     `/thread/<channel>-<root ts>` in the client URL, `data-qa-channel-id`, or the client URL's channel) and the
     workspace host. A message in the thread pane whose ts differs from the open thread's root is a **reply**: the link
     gets `?thread_ts=<root ts>&cid=<channel>`; otherwise it is the root message permalink.
  - Workspace host: the anchor's host, else `url` / `domain` of the team in Slack's `localStorage.localConfig_v2`
    (`workspaceHostFromLocalConfig()`; the token is never read out). Only `<ws>.slack.com` / `<ws>.enterprise.slack.com`
    are accepted (`app.slack.com` is not a workspace).
  - DM channels (`D…`) give an error result: clicking the item shows a toast and sends nothing (Devdy can't fetch DMs).
  - No message content, file or cookie is read for this.

## Offscreen document

- **Streamed zips** (`zip-stream.ts`, fflate `Zip`): each fetched file goes straight into the job's `ZipWriter`
  (precompressed formats such as png/jpg/pdf/zip are stored, others deflated); output is folded into Blob parts every
  8 MB; the Markdown file is written **last**. The result is a `blob:` URL for `chrome.downloads` (`build-zip`). If a
  zip can't be built, the export falls back to plain Markdown.
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

- Local Inbox API (contract: Devdy `docs/inbox-api.md`, version 2026-10-16) on `http://127.0.0.1:{47821..47830}`, Bearer
  token. Apps are discovered with `GET /health` (800 ms timeout) on that port range.
- App choice (`resolveDevdy()`): a pinned port (`devdyPortPinned`) is used exclusively; otherwise the single running app;
  several apps and no pin → links stay queued (`choose_instance`), never guessed.
- Other features only use `features/devdy/api.ts` (`outbox`, `openSettings`, `devdyTranslate`…).
- `/health` `features` is kept (`parseHealth()`): `supportsTranslate()` needs `"translate"`, `supportsSlackThreadLink()`
  needs `"slack-thread-link"`. Older Devdy builds lack one or both (or the whole field); the Devdy tab shows both flags.

### Slack thread links (`core/client.ts`)

- `postSlackThread()`: `POST /v1/slack-threads` with the JSON body `{"url": "<thread permalink>"}` and **only**
  `Authorization` + `Content-Type: application/json` (no `X-Devdy-*`, no `Idempotency-Key`; project/title would go in the
  body and aren't used). Devdy answers at once and fetches, downloads and translates the thread itself with its Slack MCP
  token.
- Never sent unless the resolved app lists `"slack-thread-link"` → otherwise `outdated` ("Update Devdy to send Slack
  threads"), not queued.
- Outcomes (`slackThreadOutcome()`, texts in `describeOutcome()`):

| Response | Outcome | Queued | Slack toast |
|---|---|---|---|
| 202 `status: created` | `created` | – | "Sent — Devdy is fetching and translating the thread" |
| 202 `status: existing` | `existing` | – | "Already in Devdy — refreshing" |
| 202 with `errorCode: no_token` | `created` / `existing` + `errorCode` | – | "Saved, but Devdy has no Slack token: add the Slack MCP server (SLACK_MCP_XOXP_TOKEN) in Devdy, then Refresh" (warning) |
| connection error, 503 (`server stopping`), no app running | `unreachable` | yes | "Devdy is not running or the Inbox API is off — queued" |
| several apps, none picked | `choose_instance` | yes | + "Open settings" |
| no token saved | `token_missing` | yes (paused) | + "Open settings" |
| 401 | `unauthorized` | yes (paused) | error + the popup opens on the Devdy tab |
| 404 / 415 / no `slack-thread-link` | `outdated` | no | "Update Devdy…" / "Devdy version mismatch…" |
| 400 `code` (`invalid_link`, `dm_unsupported`, `invalid_project`, `invalid_title`, `invalid_json`), 413, 500… | `rejected` | no | text per `code` |

### Translation (`core/translate.ts`, `core/translator.ts`, `background/translate.ts`)

- `POST /v1/translate` with `{"text","targetLang"}` (text ≤ 8 000 characters after trim, checked locally first).
  `translateJson()` (JSON mode, 120 s client timeout) and `translateStream()` (SSE over `fetch` — `EventSource` can't
  POST or send `Authorization`; aborts after 100 s without a byte, keep-alives included). `SseParser` is a pure
  incremental parser: chunks split anywhere, LF / CRLF / CR, multi-line `data`, `:` comments; `chunk` deltas are display
  only, `done.text` is authoritative; pre-stream errors are JSON with a status.
- Errors are `DevdyTranslateError` with a code from the HTTP status (`codeForStatus`: 400/415 bad request, 401, 413,
  429 busy, 502 engine error, 503 `server stopping` vs `translation engine unavailable`, 504) or the SSE `error` message;
  `describeTranslateError()` gives the user text, `needsDevdySettings()` marks the ones fixed in the Devdy tab (no token,
  401, several apps).
- `DevdyTranslator` (SW): the instance comes from `resolveDevdy()` (pinned port / single app / ambiguous → error) and is
  cached 30 s (dropped when the token / port settings change). A connection error probes the ports again and retries
  once; the feature check is repeated once before reporting "unsupported"; 429 is retried 3 times after 1.5 s. Aborting
  the fetch frees Devdy's slot, but its engine still finishes that turn (FIFO on one session) — hence the sparing page
  translation. A 20 s `chrome.runtime` ping keeps the SW alive while a request waits in Devdy's queue.

### Link queue (`features/devdy/core/outbox.ts`)

`DevdyOutbox` keeps Slack links Devdy can't take *for now* in `chrome.storage.local.devdyLinkQueue`
(`[{ id, url, createdAt, attempts, lastError }]`), with the retry state in `devdyLinkQueueState`
(`paused`, `backoff`, `notice`).

- Every read-modify-write of the queue and every delivery round runs serially (one promise chain).
- `send(url)` posts right away. Retryable outcomes (`unreachable`, `choose_instance`, `token_missing`, `unauthorized` —
  Inbox API §9.3) queue the link; the queue is **deduplicated by URL** (resending a link is idempotent in Devdy). Anything
  else is reported and removes a queued copy of the same link. After a successful send the older queued links are
  delivered too.
- `flush()` (alarm, browser start, Devdy tab): resolves the app first; none / several / outdated / no token stops the
  round (no attempt counted). Links are posted oldest first: connection problems, 401 and 404/415 stop the round (the
  rest stays queued); links refused for good are dropped with a notice. Only `unreachable` after reaching Devdy counts an
  attempt.
- `unauthorized` / `token_missing` **pause** automatic retries until a token is saved. With links still queued, the
  one-shot alarm `devdy-outbox-retry` is scheduled with backoff 1 → 2 → 5 → 15 → 60 minutes (the last step repeats; back
  to the first step once something is sent). Saving a token, picking an app or *Retry now* sends at once.
- Bounds: links older than 7 days or with 20 attempts are dropped (notice in the Devdy tab); at most 50 links — new ones
  are refused beyond that ("queue is full"), queued ones are never evicted.
- **Migration** (`core/migration.ts`, on install/update): the blob outbox of AI Trans ≤ 2.1 (`devdyOutbox` /
  `devdyOutboxState` + IndexedDB `context-kit`, a retired name) can't be sent any more, so it is deleted; if it held
  exports, a one-time notice in the Devdy tab says how many were dropped. It runs once per profile (flag
  `devdyLegacyMigrated` in `chrome.storage.local`).

## Build

- `vite.config.ts` builds the pages (`src/popup/index.html`, `src/features/*/popup/popup.html`,
  `src/offscreen/offscreen.html`) and the service worker. `vite.content.config.ts --mode all-frames|slack` builds each
  content script as an IIFE. Builds are minified; watch scripts pass `--minify false` and don't wipe `dist/`.
- Functions injected with `chrome.scripting.executeScript({ func })` (`pageSlackApi`, `extractInPage`) are serialized
  to a string: keep them **self-contained** (no imports/closures; type-only imports are fine).
  `tests/minified-injection.test.ts` checks that the minified versions still run standalone.
- `scripts/check-dist.mjs` checks that every file referenced by `dist/manifest.json`, the HTML and the code exists.
