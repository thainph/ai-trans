# Changelog

## 2.3.0 — 2026-10-20 — Grammar check with Devdy

Needs a Devdy build whose Inbox API lists `"grammar"` in `GET /health` `features` (Inbox API 2026-10-20).

### Added

- **Grammar check (G) with the Devdy provider** (`POST /v1/grammar`): the text is corrected in its own language (not
  only English, never translated); **Replace** writes the corrected text back. Under it, the popup lists each fix
  (original → suggestion) with Devdy's short explanation, written in the Translate tab's target language. Selections
  over 8 000 characters are checked in parts, one after another.
- The Devdy tab shows the **Grammar check** feature of the connected app.

### Changed

- **G** is no longer greyed out with Devdy. An older Devdy without the grammar feature gets a clear *Update Devdy*
  message instead; other errors (busy, engine unavailable, `invalid grammar result`, timeout…) are worded for the
  grammar check.

### Fixed

- The selection toolbar with a single button (**T** only, outside input fields) has the same rounded-rectangle shape
  as the toolbar with several buttons, instead of a circle.

## 2.2.0 — 2026-10-16 — Slack threads sent to Devdy as links, Web → MD export only

Needs a Devdy build whose Inbox API lists `"slack-thread-link"` in `GET /health` `features` (Inbox API 2026-10-16) to
send Slack threads.

### Breaking

- **Web pages and selections are no longer sent to Devdy** (Devdy removed `POST /v1/web-pages`). Removed: the Web → MD
  tab's **Send to Devdy** button and the **➤** button of the selection toolbar (T / G / R stay). Web → MD now only
  copies or exports (`.md`, or `.zip` with images).
- **Slack: Devdy receives the thread link, not an export.** *Send to Devdy* in Slack's message menu now posts the
  thread's permalink (`{"url": …}`; a reply's link carries `thread_ts` / `cid`) and Devdy fetches, downloads and
  translates the thread itself with its Slack MCP token. Nothing is exported or downloaded by AI Trans for this. The
  Slack popup tab no longer has **Send to Devdy** (export / copy only).
- **The Devdy queue holds Slack links only.** Markdown/zip exports still queued by an older AI Trans can't be sent any
  more: on update they are dropped (with the old IndexedDB storage) and the Devdy tab says once how many were lost.

### Changed

- Results in Slack follow Devdy's answer: *Sent — Devdy is fetching and translating the thread*, *Already in Devdy —
  refreshing*, a warning when Devdy has no Slack token (add the Slack MCP server `SLACK_MCP_XOXP_TOKEN`, then Refresh),
  *Update Devdy to send Slack threads* for an older Devdy, a clear refusal for direct messages (checked before sending),
  and *Devdy is not running or the Inbox API is off — queued*. A rejected token opens the Devdy tab.
- Only connection problems (incl. `503 server stopping`), an unpicked Devdy app and token problems are queued and
  retried; other refusals of a new link are reported and not queued. Links already queued wait for an updated Devdy and
  go out as soon as the Devdy tab sees `slack-thread-link`. The same link is queued once; at most 50 links.
- The Devdy tab shows the connected app's features (**Translate**, **Slack thread links**) and the waiting links
  (**Retry now**, **Remove**); the "Not accepted by Devdy" downloads are gone.
- Web → MD zip export: images up to 200 MB in total / 500 images (the 45 MB / 199 limits only existed for Devdy).

### Fixed

- Slack: the **Send to Devdy** item in Slack's message menu always shows the same ➤ icon. It used to inherit the icon
  of whichever Slack row it was cloned from, so it changed from menu to menu.

## 2.1.0 — 2026-10-15 — Devdy translation provider

### Added

- **Devdy as a translation provider** (Translate tab → Provider **Devdy**): translates with the Devdy app's own engine,
  model and style through its local Inbox API (`POST /v1/translate`). Requires a Devdy build with the `translate`
  feature. The tab shows whether Devdy is found, can translate and has a valid token, with a link to the Devdy tab.
  - Selection translations stream into the result popup; long selections are sent in ≤ 8 000-character parts.
  - Page translation packs several texts per request (marker lines), one request at a time.
  - Grammar check is disabled with this provider (greyed-out **G** with a tooltip); the style menus are hidden.
  - Clear errors for Devdy not running / Inbox API off, rejected token (button to open the Devdy tab), engine
    unavailable, busy (retried automatically) and timeouts.

## 2.0.0 — 2026-10-09 — renamed to AI Trans, TypeScript restructure

The whole extension was rewritten in TypeScript and reorganised by feature. Most changes are internal; below is what
users and developers need to know.

### User-visible changes

- **Renamed from "Context Kit" to "AI Trans"** (extension name, toolbar title, page titles, notifications). Internal
  identifiers keep the `context-kit` prefix, so saved settings and queued Devdy exports are kept.
- **Web → MD: front matter keys renamed** to match what is sent to Devdy:
  `source` → `url`, `site` → `site_name`, `published` → `published_at`, `saved` → `captured_at` (plus a new `selection`
  key). Update any script that reads older `.md` files.
- **Web → MD: file names keep accented and non-Latin letters** (like the Slack export already did): a page titled
  "Hướng dẫn cài đặt" is saved as `Hướng-dẫn-cài-đặt.md` instead of `huong-dan-cai-dat.md`; Japanese/Chinese titles no
  longer lose their characters.
- **Page translation no longer translates iframes** — only the main page, so iframes don't each call the LLM.
- **In `.zip` files the `.md` is the last entry** (after `images/` or `attachments/`), because zips are now streamed.
- If a zip can't be built (on export or when sending to Devdy), the extension falls back to the plain `.md` (original
  links kept) instead of failing the whole send.

### Security

- **Ollama:** the extension used to remove the `Origin` header from **every** request to `localhost` / `127.0.0.1`,
  including web pages' requests. It now does so only for its own requests to the configured Ollama URL.
- **Message sender checks:** each channel only accepts commands from where they are expected (e.g. only extension pages
  can drive Devdy and the offscreen document; Slack quick send only from app.slack.com), with size limits.
- **Real user input only:** the translate toolbar and result popup use closed Shadow DOM and ignore script-generated
  events, so a page can't read them or click for the user.
- **Safer image downloads:** private addresses (localhost, LAN, `*.local`…) are blocked; cookies are only sent for
  same-origin images and never across a redirect; sizes and time are bounded.

### Performance and reliability

- **Cheaper page translation:** visible content first, the rest as you scroll; identical texts translated once; at most
  20 requests/minute for content loaded later; items the model got wrong are retried at most twice.
- Every LLM call has a timeout; closing the result popup cancels the request in flight.
- **More reliable Devdy queue:** payloads stored in IndexedDB, automatic retries with growing delays, no duplicate sends
  when the browser stops the service worker mid-way, one bad export no longer blocks the queue, bounded by age /
  attempts / size.
- Large zip exports no longer hold every file in memory at once; the offscreen document is closed when idle.

### For developers

- 100 % TypeScript; each feature lives in `src/features/<name>/`, dependency rules are tested.
- Biome for lint + format (0 warnings); CI runs `lint:ci`, `test`, `build`; `check:dist` verifies the build output.
- Details: [docs/architecture.md](docs/architecture.md).
