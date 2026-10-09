# AI Trans

> Gather context for AI: translate any text, turn web pages and Slack threads into clean Markdown.

A Chrome extension (Manifest V3) that merges three older extensions (`ai-translator`, `artifact-exporter`,
`slack-summarier`) into one popup with four tabs:

| Tab | What it does |
|---|---|
| 🌐 **Translate** | Translate the selected text or a whole page with OpenAI, Gemini or Ollama (local models); fix English grammar while you type. |
| 📄 **Web → MD** | Turn the current page into Markdown: copy it, download it (`.md`, or a `.zip` with images) or send it to Devdy. |
| 💬 **Slack** | Export a Slack thread to Markdown (with reactions and attachments), or send it straight to Devdy. |
| ➤ **Devdy** | Connect to the Devdy app on your machine: token, app choice, delivery queue. |

See [CHANGELOG.md](CHANGELOG.md) for recent changes.

> The extension was previously called **Context Kit**. Internal identifiers (storage keys such as `contextKitLastTab`,
> message channels `context-kit-*`, the IndexedDB database `context-kit`, the `context-kit-debug` flag, the
> `[context-kit]` log prefix, the package name) keep the `context-kit` prefix on purpose, so saved settings and queued
> exports survive the rename.

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

**Setup (once, in the Translate tab):** pick a **Provider** (OpenAI / Gemini / Ollama), paste the API key, choose a
model, a **Translation Style** (Casual / Polite / Business) and a **Target Language** (Vietnamese by default), then click
**Save Settings**.

**Translating a selection:** select text on any page and a small toolbar appears right under it:

| Button | Shown when | What it does |
|---|---|---|
| **T** | always | Translate the selection into the target language. The result popup lets you switch the target language and the style, and **Copy** the result. |
| **G** | the selection is inside an input field (input, textarea, rich editor) | Check the English grammar; **Replace** writes the corrected text back where you are typing. |
| **R** | the selection is inside an input field, after at least one translation | Reverse-translate into the language of the text you translated last. E.g. read a Japanese message → translate it to Vietnamese → type your reply in Vietnamese → **R** translates the reply into Japanese. |
| **➤** | the selection is page text (not an input field) | Send the selection to Devdy (see the Devdy tab). |

The result popup can be resized from any edge; its size is remembered. Closing it cancels the request in flight.

**Translating a whole page:** Translate tab → **Translate This Page**. What is on screen is translated first, the rest
as you scroll to it; **Revert Translation** restores the original text. Only the main page is translated, not the content
of iframes.

**Using Ollama (local models):**

1. Install [Ollama](https://ollama.com), pull a model (e.g. `ollama pull qwen2.5:7b`) and keep Ollama running.
2. Translate tab → Provider **Ollama** → **Ollama URL** (default `http://localhost:11434`) → pick a model (the list is
   loaded from Ollama automatically; use the refresh button next to **Model** to reload it) → **Save Settings**.
3. No need to set `OLLAMA_ORIGINS`: the extension removes the `Origin` header on its own requests to that Ollama URL.

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
   - **Send to Devdy** — send the whole page to Devdy, images included.

**Preview** shows the first 4 000 characters with the character count and an estimated token count.
For Claude artifacts (content inside an iframe that can't be read) the tab offers a button to open the content page —
open it and convert again.

### 💬 Slack

Requires a logged-in `app.slack.com` tab (the export uses that session).

**From the Slack tab in the popup:**

1. Paste a thread link (*Copy link* on a message, like `https://<team>.slack.com/archives/C…/p…`).
2. Pick **Options**: **Reactions**, **Files** (download attachments), **Zip files** (put the files in a zip on Export).
3. Click **Export** (save a file), **Copy** (text only) or **Send to Devdy**.

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

**Quick send inside Slack:** right-click a message (or click ⋮ *More actions*) → Slack's menu gets a **Send to Devdy**
item (right after *Copy link*). It sends the whole thread containing that message, always with reactions and
attachments; progress and the result appear as a notification in the bottom-right corner. If a Slack redesign hides the
item, you can still send from the Slack tab in the popup.

> **Debugging:** if *Send to Devdy* doesn't appear, open the DevTools console on `app.slack.com`, run
> `localStorage.setItem('context-kit-debug', '1')`, reload the page and look for `[context-kit]` log lines.

### ➤ Devdy

Devdy is an app running on your machine that stores Slack threads and web pages as context. AI Trans talks to it through
a local API on `127.0.0.1`, never over the internet.

**Setup:** in Devdy open *Settings → Inbox API*, copy the token, paste it into **Inbox API token** in the Devdy tab and
click **Save**. No project needed — Devdy assigns one later.

**Three ways to send:**

| What | How |
|---|---|
| A Slack thread | right-click a message → **Send to Devdy**, or Slack tab → **Send to Devdy** |
| Selected text | the **➤** button of the floating toolbar (titled after the first line of the selection) |
| A whole page | Web → MD tab → **Send to Devdy** |

Sending the same Slack thread or the same page URL again **updates** the earlier copy in Devdy instead of duplicating it.

**Several Devdy apps running** (e.g. a release and a dev build): the Devdy tab shows a **Devdy app** picker. Until you
pick one, the extension doesn't guess: sends wait in the queue.

**The queue:** every send is stored first, so nothing is lost when Devdy isn't running.

- Devdy closed, no app picked, or a temporary Devdy error → the send stays queued and is retried after 1, 2, 5, 15 and
  then every 60 minutes. **Retry now** sends immediately; saving a token or picking an app does too.
- Missing or wrong token → automatic retries pause until you save a valid token.
- Devdy refuses the content (e.g. too large) → it moves to **Not accepted by Devdy**: download it to keep it, or
  **Dismiss** it.
- Sends still undelivered after 7 days or 20 attempts are dropped, with a notice in the Devdy tab. The queue holds at
  most 300 MB; when it is full, new sends are refused — open Devdy so the queue can drain.

## Privacy & security

- **Text to translate** goes only to the provider you chose (OpenAI, Gemini, or Ollama on your machine). API keys are
  stored in the browser's `chrome.storage.sync`.
- **Devdy** is only contacted on `127.0.0.1` (your machine); its token lives in `chrome.storage.local`.
- **Slack:** the export runs inside your Slack tab with your session; the Slack token never leaves the page.
  Attachments are only downloaded from `*.slack.com`.
- **Web page images:** cookies are sent only for images on the page's exact origin (scheme + host + port); private
  addresses (localhost, LAN, `*.local`…) are blocked so a page can't use the extension to probe your local network.
- The translate toolbar and result popup are isolated from page scripts and only react to real user input.
- The extension adds nothing to the browser's right-click menu.

## Limits

| What | Limit |
|---|---|
| Selection translation | 100 000 characters per request |
| Page translation | segments over 4 000 characters are skipped; content loaded later: at most 20 requests/minute |
| Slack attachments (export) | 25 MB per file, 200 MB total |
| Slack → Devdy | 45 MB total, 199 files |
| Web page images (export / Devdy) | 10 MB per image, 45 MB total, 199 images |
| `blob:` images in a selection | 5 MB per image, 10 MB total |
| Markdown of one page | 30 × 1024 × 1024 characters (≈ 30 MB) |
| One Devdy request | 50 MB |
| Devdy queue | 300 MB, 7 days, 20 attempts, 20 failed records |

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
    web-to-md/           web page → Markdown, selection capture
    slack/               Slack thread → Markdown, quick send inside Slack
    devdy/               Devdy client and outbox; api.ts is the API for other features
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
  e.g. `content/all-frames.ts` connects the Translator's ➤ button to Web → MD.

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
  image fetch policy, Devdy outbox.
- [CLAUDE.md](CLAUDE.md) — concise conventions for AI agents working on the repo (storage keys, where each limit lives).
