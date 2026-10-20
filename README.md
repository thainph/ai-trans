# AI Trans

> Gather context for AI: translate any text, turn web pages and Slack threads into clean Markdown.

A Chrome extension (Manifest V3) that merges three older extensions (`ai-translator`, `artifact-exporter`,
`slack-summarier`) into one popup with four tabs:

| Tab | What it does |
|---|---|
| 🌐 **Translate** | Translate the selected text or a whole page with OpenAI, Gemini, Ollama (local models) or the Devdy app; fix English grammar while you type. |
| 📄 **Web → MD** | Turn the current page into Markdown: copy it or download it (`.md`, or a `.zip` with images). |
| 💬 **Slack** | Export a Slack thread to Markdown (with reactions and attachments). Inside Slack, **Send to Devdy** sends the thread's link to Devdy. |
| ➤ **Devdy** | Connect to the Devdy app on your machine: token, app choice, features, queue of Slack links. |

See [CHANGELOG.md](CHANGELOG.md) for recent changes.

> The extension was previously called **Context Kit**. Internal identifiers (storage keys such as `contextKitLastTab`,
> message channels `context-kit-*`, the `context-kit-debug` flag, the `[context-kit]` log prefix, the package name)
> keep the `context-kit` prefix on purpose, so saved settings survive the rename.

## Installation

Requires Node.js 22 and `pnpm` 9.

```bash
pnpm install
pnpm build        # produces dist/
```

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick the `dist/` folder.
3. Pin the AI Trans icon to the toolbar.

After every rebuild, click the extension's reload button in `chrome://extensions` (and reload open tabs).

### Migrating from the old extensions

- This extension has a different ID, so **old settings are not carried over**: enter your Translator API keys / models
  again.
- **Uninstall the three old extensions**, otherwise the translate toolbar shows up twice on every page.

## Usage

Click the AI Trans icon to open the popup. It reopens the tab you used last; on `app.slack.com` it opens the **Slack**
tab directly.

### 🌐 Translate

**Setup (once, in the Translate tab):** pick a **Provider** (OpenAI / Gemini / Ollama / Devdy), paste the API key, choose a
model, a **Translation Style** (Casual / Polite / Business) and a **Target Language** (Vietnamese by default), then click
**Save Settings**.

**Translating a selection:** select text on any page and a small toolbar appears right under it:

| Button | Shown when | What it does |
|---|---|---|
| **T** | always | Translate the selection into the target language. The result popup lets you switch the target language and the style, and **Copy** the result. |
| **G** | the selection is inside an input field (input, textarea, rich editor) | Check the grammar (English with OpenAI / Gemini / Ollama, any language with Devdy); **Replace** writes the corrected text back where you are typing. |
| **R** | the selection is inside an input field, after at least one translation | Reverse-translate into the language of the text you translated last. E.g. read a Japanese message → translate it to Vietnamese → type your reply in Vietnamese → **R** translates the reply into Japanese. |

The result popup can be resized from any edge; its size is remembered. Closing it cancels the request in flight.

**Translating a whole page:** Translate tab → **Translate This Page**. What is on screen is translated first, the rest
as you scroll to it; **Revert Translation** restores the original text. Only the main page is translated, not the content
of iframes.

**Using Ollama (local models):**

1. Install [Ollama](https://ollama.com), pull a model (e.g. `ollama pull qwen2.5:7b`) and keep Ollama running.
2. Translate tab → Provider **Ollama** → **Ollama URL** (default `http://localhost:11434`) → pick a model (the list is
   loaded from Ollama automatically; use the refresh button next to **Model** to reload it) → **Save Settings**.
3. No need to set `OLLAMA_ORIGINS`: the extension removes the `Origin` header on its own requests to that Ollama URL.

**Using Devdy as the translation provider:**

Requires a Devdy build with the **translate** feature (its `GET /health` lists `"translate"` in `features`; older Devdy
builds don't have it and the Translate tab says so).

1. Set up the Devdy connection first (Devdy tab: token, app choice — see [➤ Devdy](#-devdy)).
2. Translate tab → Provider **Devdy** → **Save Settings**. The tab shows whether Devdy was found, can translate and has a
   valid token, with a link to the Devdy tab when something is missing there.
3. No API key or model here: Devdy translates with the engine, model and style set in **Devdy → Settings**; AI Trans only
   picks the **Target Language** (Vietnamese, English, Japanese, Chinese, Korean, French, German and Spanish are sent
   as language codes, other languages by name). The style menus are hidden.

With Devdy:

- The selection translation appears **progressively** in the result popup. Selections over 8 000 characters are split
  at paragraph/sentence boundaries and translated one part after another.
- **G (grammar check)** corrects the text in its own language (needs a Devdy build with the **grammar** feature). The
  popup shows the corrected text plus each fix (original → suggestion) with a short explanation in your target
  language; **Replace** writes the corrected text back. Selections over 8 000 characters are checked part by part.
- **Page translation** packs many page texts into each request (Devdy translates one request at a time, shared with the
  Devdy app), so it is slower than with an API provider; texts that come back unusable are retried, then left as they
  are.
- Errors say what to do: *Devdy is not running or its Inbox API is turned off*, token rejected (with an **Open Devdy
  settings** button), engine unavailable (check the translation settings in Devdy), busy (retried automatically),
  timeout.

### 📄 Web → MD

1. Open the page, then the **Web → MD** tab.
2. Choose the **Content**: *Entire page* (default), *Main content* (a heuristic guess of the article body), or
   *Selected text only*.
3. Toggle the **Options** chips:
   - **Frontmatter** — a YAML header: `title, url, site_name, author, published_at, captured_at, description, selection`;
   - **Images** — keep images; Export downloads them;
   - **Links** — keep links.
4. Click:
   - **Export** — save a file. With images (Images chip on) you get `<name>.zip` with `images/01-….png` + `<name>.md`
     (image links point into the zip). Images that fail to download keep their original URL; no images, or a zip that
     can't be built → a plain `.md`.
   - **Copy** — copy the Markdown to the clipboard.

Web pages can't be sent to Devdy any more (Devdy dropped that API); export or copy them instead.

**Preview** shows the first 4 000 characters with the character count and an estimated token count.
For Claude artifacts (content inside an iframe that can't be read) the tab offers a button to open the content page —
open it and convert again.

### 💬 Slack

Requires a logged-in `app.slack.com` tab (the export uses that session).

**From the Slack tab in the popup:**

1. Paste a thread link (*Copy link* on a message, like `https://<team>.slack.com/archives/C…/p…`).
2. Pick **Options**: **Reactions**, **Files** (download attachments), **Zip files** (put the files in a zip on Export).
3. Click **Export** (save a file) or **Copy** (text only).

With **Files** + **Zip files** on and attachments in the thread, **Export** saves a zip:

```
slack-thread-dev-20231115-0513.zip
├── attachments/
│   ├── 01-screenshot.png
│   └── 02-server-log.txt
└── slack-thread-dev-20231115-0513.md   # images: ![..](attachments/01-…png), other files: 📎 [..](attachments/02-…)
```

Files left out of the zip (external files such as Google Drive, files over 25 MB, beyond the 200 MB total, failed
downloads) keep their Slack link with a `_(not included: …)_` note. If no file could be downloaded you get a plain `.md`.

**Send to Devdy inside Slack:** right-click a message (or click ⋮ *More actions*) → Slack's menu gets a **Send to
Devdy** item (right after *Copy link*, with a ➤ icon). It sends **only the thread's link** — the permalink of that
message, like Slack's *Copy link* (a reply's link carries the thread's root: `?thread_ts=…&cid=…`). Devdy then fetches
the whole thread with its own Slack token, downloads the files and translates it; AI Trans exports nothing and downloads
nothing for this. The result appears as a notification in the bottom-right corner:

| Notification | Meaning |
|---|---|
| *Sent — Devdy is fetching and translating the thread* | New thread in Devdy. |
| *Already in Devdy — refreshing* | Devdy already had it and fetches it again (new replies, edits). |
| *Saved, but Devdy has no Slack token…* | Add the Slack MCP server (`SLACK_MCP_XOXP_TOKEN`) in Devdy, then **Refresh** there. |
| *Devdy is not running or the Inbox API is off — queued* | Sent automatically once Devdy is back (see the queue below). |
| *Update Devdy to send Slack threads* | The running Devdy is too old (or doesn't match): update it. |
| *Direct messages (DMs) can't be sent to Devdy* | Devdy only takes channel threads (public or private). |
| token rejected | the popup opens on the Devdy tab so you can paste the token again. |

If a Slack redesign hides the item, copy the thread with the Slack tab instead.

> **Debugging:** if *Send to Devdy* doesn't appear, open the DevTools console on `app.slack.com`, run
> `localStorage.setItem('context-kit-debug', '1')`, reload the page and look for `[context-kit]` log lines.

### ➤ Devdy

Devdy is an app running on your machine that stores Slack threads (and translates them) as context for AI sessions.
AI Trans talks to it through a local API on `127.0.0.1`, never over the internet.

**Requirements:** a Devdy build whose Inbox API supports Slack thread links — its `GET /health` lists
`"slack-thread-link"` in `features` (the Devdy tab shows ✓/✗ for **Slack thread links** and **Translate**). With an older
Devdy, *Send to Devdy* is refused with "Update Devdy to send Slack threads" and nothing is sent. For Devdy to fetch the
threads, add the Slack MCP server (`SLACK_MCP_XOXP_TOKEN`) in Devdy.

**Setup:** in Devdy open *Settings → Inbox API*, copy the token, paste it into **Inbox API token** in the Devdy tab and
click **Save**. No project needed — Devdy assigns one later.

**Sending:** Slack → right-click a message → **Send to Devdy** (see [💬 Slack](#-slack)). Sending the same thread again
is safe: Devdy refreshes it instead of duplicating it.

**Several Devdy apps running** (e.g. a release and a dev build): the Devdy tab shows a **Devdy app** picker. Until you
pick one, the extension doesn't guess: links wait in the queue.

**The queue** (only for problems that go away by themselves):

- Devdy not running / Inbox API off (including "server stopping"), no app picked, or a missing/wrong token → the link is
  queued and retried after 1, 2, 5, 15 and then every 60 minutes. **Retry now** sends immediately; saving a token or
  picking an app does too. The Devdy tab lists the waiting links; **Remove** drops one.
- Missing or wrong token → automatic retries pause until you save a valid token.
- A **new** link Devdy can't take for other reasons (not a thread link, DM, outdated Devdy…) is reported right away and
  not queued. Links **already** in the queue stay there while the running Devdy is outdated, and are sent as soon as a
  Devdy with Slack thread links is seen (opening the Devdy tab checks it, besides the automatic retries); a queued link
  Devdy refuses for good (e.g. not a thread link) is dropped with a notice.
- The same link is queued once. Links still undelivered after 7 days or 20 attempts are dropped, with a notice in the
  Devdy tab; the queue holds at most 50 links.
- Updating from AI Trans ≤ 2.1: Markdown/zip exports still queued by the old version can't be sent any more; they are
  dropped and the Devdy tab says so once.

## Privacy & security

- **Text to translate** goes only to the provider you chose (OpenAI, Gemini, Ollama on your machine, or the Devdy app on
  your machine, which uses its own engine). API keys are
  stored in the browser's `chrome.storage.sync`.
- **Devdy** is only contacted on `127.0.0.1` (your machine); its token lives in `chrome.storage.local`. Only the Slack
  thread link is sent to it — no message content, files or cookies.
- **Slack:** the export runs inside your Slack tab with your session; the Slack token never leaves the page.
  Attachments are only downloaded from `*.slack.com`. To build a thread link, the Slack content script reads only the
  workspace address from Slack's local settings.
- **Web page images:** cookies are sent only for images on the page's exact origin (scheme + host + port); private
  addresses (localhost, LAN, `*.local`…) are blocked so a page can't use the extension to probe your local network.
- The translate toolbar and result popup are isolated from page scripts and only react to real user input.
- The extension adds nothing to the browser's right-click menu.

## Limits

| What | Limit |
|---|---|
| Selection translation | 100 000 characters per request (Devdy: sent in parts of ≤ 8 000 characters) |
| Page translation | segments over 4 000 characters are skipped; content loaded later: at most 20 requests/minute |
| Slack attachments (export) | 25 MB per file, 200 MB total |
| Web page images (export) | 10 MB per image, 200 MB total, 500 images |
| Markdown of one page | 30 × 1024 × 1024 characters (≈ 30 MB) |
| Devdy queue | 50 links, 7 days, 20 attempts |

## Development

### Scripts

```bash
pnpm build        # typecheck + vite build (pages, service worker, 2 content-script IIFEs) + check:dist → dist/
pnpm dev          # = dev:all: runs dev:main, dev:content, dev:slack in parallel (watch, unminified, dist/ not wiped)
pnpm test         # vitest
pnpm test:watch   # vitest in watch mode
pnpm typecheck    # tsc --noEmit
pnpm lint         # Biome lint + format check; warnings fail
pnpm lint:ci      # same with `biome ci` (no writes)
pnpm format       # Biome fixes formatting
pnpm check:dist   # every path dist/ references exists (already run by build)
```

### Layout

```
public/                  manifest.json + icons (copied verbatim into dist/)
src/
  background/index.ts    service worker: only imports each feature's background module
  offscreen/             offscreen document: fetches files/images, streams zips
  popup/                 popup shell: tab bar + one iframe per tool
  content/all-frames.ts  content script for every page/frame → dist/content.js
  shared/                feature-neutral code (messaging, sender, yaml, toast, styles…)
  features/
    translator/          selection / page translation, grammar check
    web-to-md/           web page → Markdown (copy / .md / .zip export)
    slack/               Slack thread → Markdown, "Send to Devdy" (thread link) inside Slack
    devdy/               Devdy client and link queue; api.ts is the API for other features
tests/                   vitest
scripts/check-dist.mjs   checks dist/ after a build
docs/architecture.md     detailed architecture
```

Each feature is split into `core/` (pure logic, no `chrome.*`, unit-tested), `background/`, `content/`, `popup/` and
`messages.ts`.

### Dependency rules

Enforced by `tests/dependencies.test.ts`:

- `src/shared/` imports nothing outside `src/shared/`.
- `src/features/<name>/` imports only `src/shared/`, its own folder and `src/features/devdy/api.ts`. Features never import
  each other.
- Cross-feature wiring happens in the entry points (`src/background/`, `src/offscreen/`, `src/popup/`, `src/content/`),
  e.g. the offscreen document serves both the Slack and the Web → MD zip exports.

### Adding a feature

1. Create `src/features/<name>/` with `core/`, `background/`, `popup/`… and `messages.ts` (its own `target`, handled with
   `onTargetMessage()`).
2. Import its background module in `src/background/index.ts`; if it has a tab, add the page to `src/popup/shell.ts`,
   `src/shared/popup-tabs.ts` and `rollupOptions.input` in `vite.config.ts`.
3. Check senders with the helpers in `src/shared/sender.ts` (see [docs/architecture.md](docs/architecture.md)).
4. Test `core/`, then run `pnpm lint && pnpm test && pnpm build`.

### Tests, lint, CI

- Tests use vitest (+ happy-dom where a DOM is needed) and import the TypeScript modules directly.
  `tests/minified-injection.test.ts` checks that page-injected functions still run after minification.
- CI (`.github/workflows/ci.yml`, on pushes to `main` and on pull requests): `pnpm lint:ci` → `pnpm test` → `pnpm build`
  (the typecheck runs inside `build`). Lint must be clean: 0 warnings, 0 infos.

### More documentation

- [docs/architecture.md](docs/architecture.md) — messaging and sender checks, Translator internals, offscreen document,
  image fetch policy, Devdy link queue.
- [CLAUDE.md](CLAUDE.md) — concise conventions for AI agents working on the repo (storage keys, where each limit lives).
