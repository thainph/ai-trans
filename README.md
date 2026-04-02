## AI Translator – Chrome Extension

### Overview

AI Translator is a Chrome extension that translates text on any web page using AI.
It supports two translation modes: **selected text translation** and **full page translation**, with two AI backend options: **OpenAI** and **Ollama** (local).

### Key Features

- **Select & Translate**: Select any text on a page, click the **T** button to see the translation in a popup.
- **Reverse Translate**: In editable fields, click the **R** button to translate text back to the detected source language.
- **Full Page Translation**: Translate the entire page at once from the extension popup. New content added dynamically is auto-translated.
- **Dual AI Provider**:
  - **OpenAI**: 7 model options — `gpt-4o-mini`, `gpt-4o`, `gpt-4-turbo`, `gpt-4.1-nano`, `gpt-4.1-mini`, `gpt-4.1`, `gpt-3.5-turbo`.
  - **Ollama**: Connect to a local Ollama server, auto-loads available models.
- **Auto Language Detection**: Detects English, Vietnamese, Japanese, Korean, Chinese, French, German, Spanish, Portuguese, Russian, Thai, Indonesian, Italian, Dutch, Arabic, Hindi based on character patterns.
- **16 Target Languages**: Vietnamese, English, Japanese, Chinese, Korean, French, German, Spanish, Portuguese, Russian, Thai, Indonesian, Italian, Dutch, Arabic, Hindi.
- **3 Style Presets**: `Casual`, `Polite`, `Business`.
- **Draggable & Resizable Popup**: Move the translation popup by dragging the header; resize by dragging the edges.
- **Copy to Clipboard**: One-click copy of translated text.
- **Smart Language Switching**: If target language matches source language, auto-switches (e.g. English ↔ Vietnamese).
- **Settings Sync**: All settings stored in `chrome.storage.sync` and synced across devices.

### How It Works

1. **Content Script (`content.js`)**
   - Listens for text selection on the page.
   - Shows a floating **T** button (and **R** button for editable fields) near the selection.
   - Opens a draggable/resizable popup (Shadow DOM) showing the translation result.
   - Detects source language, loads config from `chrome.storage.sync`, and sends a `translate` message to the background script.
   - Handles full page translation: walks the DOM, collects text nodes (skipping code/scripts/URLs), sends batches to background, and replaces text with translations.
   - Uses `MutationObserver` to auto-translate dynamically added content during page translation.

2. **Background Service Worker (`background.js`)**
   - Receives `translate` and `translateBatch` messages from the content script.
   - Routes requests to **OpenAI API** or **Ollama API** based on the selected provider.
   - Builds system prompts with source/target language and style instructions.
   - Handles batch translation with numbered format for accuracy.
   - Also handles `getOllamaModels` messages to fetch available models from the Ollama server.

3. **Settings Popup (`popup.html`, `popup.js`)**
   - UI shown when clicking the extension icon in the toolbar.
   - **Provider selection**: Toggle between OpenAI and Ollama.
   - **OpenAI config**: API key input (with show/hide toggle), model selector.
   - **Ollama config**: Server URL, model selector with refresh button.
   - **Translation style**: Casual / Polite / Business radio buttons.
   - **Target language**: Dropdown with 16 languages.
   - **Translate This Page** button: Triggers full page translation on the active tab.

### Installation & Usage

#### 1. Install as an unpacked extension

1. Clone or download this repository.
2. Open Chrome (or any Chromium-based browser like Edge, Brave).
3. Go to `chrome://extensions/`.
4. Enable **Developer mode**.
5. Click **Load unpacked** and select the `ai-translator` folder.

#### 2. Configure your AI provider

1. Click the **AI Translator** extension icon in the browser toolbar.
2. Choose your provider:
   - **OpenAI**: Paste your API key, select a model, and click **Save**.
   - **Ollama**: Enter your Ollama server URL (default: `http://localhost:11434`), click the refresh button to load models, select a model, and click **Save**.
3. Choose the default **style** and **target language**.

> Note: The API key is stored in `chrome.storage.sync` in your browser and is **not** part of the source code.

#### 3. Translate selected text

1. Open any web page.
2. **Select** the text you want to translate.
3. Click the **T** button that appears near the selection.
4. The translation popup shows:
   - Detected source language → target language.
   - Dropdown to change target language or style.
   - **Copy** button to copy the result.
5. Drag the popup header to reposition, or drag the edges to resize.

#### 4. Translate an entire page

1. Click the extension icon in the toolbar.
2. Click **Translate This Page** (green button).
3. Progress is shown: "Translating... X/Y batches".
4. Click **Revert Translation** (orange button) to restore the original text.

### Project Structure

| File | Description |
|------|-------------|
| `manifest.json` | Manifest V3 config: permissions, scripts, icons |
| `background.js` | Service worker — handles OpenAI/Ollama API calls, batch translation |
| `content.js` | Core logic — text selection, trigger buttons, popup UI, page translation, DOM observation |
| `content.css` | Styles for trigger buttons and loading indicator |
| `popup.html` | Settings popup UI |
| `popup.js` | Settings logic — provider switching, save/load config, Ollama model loading |
| `popup.css` | Settings popup styles |
| `icons/` | Extension icons (16/48/128 px) |

### Permissions & Security

| Permission | Purpose |
|-----------|---------|
| `storage` | Store API key, provider, model, style, and target language |
| `activeTab` | Access the active tab for in-page translation |
| `declarativeNetRequest` | Strip Origin header for Ollama localhost CORS compatibility |
| `host_permissions: https://api.openai.com/*` | Connect to OpenAI API |
| `host_permissions: http://localhost:*/*`, `http://127.0.0.1:*/*` | Connect to local Ollama server |

- The API key is **only stored locally** in `chrome.storage.sync`.
- No config file in the repo contains a hardcoded API key.

### Technical Details

- Plain JavaScript, no bundler or build step.
- Background script runs as a Manifest V3 service worker.
- Translation popup uses **Shadow DOM** to isolate styles from the host page.
- Batch translation uses concurrency limits: **5 concurrent requests** for OpenAI, **2** for Ollama.
- `MutationObserver` watches for dynamically added content during page translation and auto-translates within a 500ms batching window.
- Text filtering skips code blocks, scripts, stylesheets, canvas, SVG, input fields, URLs, and pure numbers.
- API parameters: `temperature: 0.3`, `max_tokens: 1024` (single) / `4096` (batch).
