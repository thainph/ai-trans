# Changelog

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
