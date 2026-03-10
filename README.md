## AI Translator – Chrome Extension

### Overview

AI Translator is a browser extension that lets you **quickly translate selected text on any web page** using OpenAI models.  
The UX is intentionally simple: select text, click the **T** button, see the translation in place.

### Key Features

- **Inline translation on page**: Select any text and a small `T` button appears near the selection; click it to open the translation popup.
- **Automatic source language detection**: Heuristics to detect English, Vietnamese, Japanese, Korean, Chinese, French, German, Spanish, and more based on characters.
- **Multiple target languages**: Supports many popular languages (EN, VI, JA, ZH, KO, FR, DE, ES, PT, RU, TH, ID, IT, NL, AR, HI…).
- **Style presets**: Choose translation style: `Casual`, `Polite`, or `Business`.
- **Compact popup UI**:
  - Shows source → target language pair.
  - Allows changing target language directly in the popup.
  - `Copy` button for quick copy of the translated text.
- **Chrome cloud storage for settings**:
  - Stores OpenAI API key.
  - Stores default style.
  - Stores default target language.

### How It Works

1. **Content script (`content.js`)**
   - Listens for text selection on the page.
   - Renders a circular `T` button near the selected text.
   - When the user clicks `T`, opens a popup (Shadow DOM) showing translation status.
   - Reads the selected text, detects the source language, loads config (style, targetLang) from `chrome.storage.sync`.
   - Sends a `translate` message with: `text`, `sourceLang`, `targetLang`, `style` to the **background** script.

2. **Background service worker (`background.js`)**
   - Receives `translate` messages from the content script.
   - Reads `apiKey` from `chrome.storage.sync`.
   - Builds a **system prompt** based on:
     - Source and target languages.
     - Selected style (casual / polite / business).
   - Calls OpenAI Chat Completions API (`gpt-4o-mini`) via `https://api.openai.com/v1/chat/completions`.
   - Returns the translated text back to the content script.

3. **Settings popup (`popup.html`, `popup.js`)**
   - UI shown when clicking the extension icon in the toolbar.
   - Allows:
     - Entering and saving the **OpenAI API key**.
     - Choosing default translation style.
     - Choosing default target language.
   - Configuration is stored in `chrome.storage.sync` and used by both the in-page popup and the background script.

### Installation & Usage

#### 1. Install as an unpacked extension

1. Clone or download this repository.
2. Open Chrome (or any Chromium-based browser like Edge, Brave).
3. Go to `chrome://extensions/`.
4. Enable **Developer mode**.
5. Click **Load unpacked** and select the `ai-translator` folder.

#### 2. Configure your OpenAI API key

1. Click the **AI Translator** extension icon in the browser toolbar.
2. In the popup:
   - Paste your **OpenAI API key** into the `API key` field.
   - Click **Save**.
3. Optionally:
   - Choose the default style: `Casual`, `Polite`, or `Business`.
   - Choose the default target language (for example: `Vietnamese`).

> Note: The API key is stored in `chrome.storage.sync` in your browser and is **not** part of the source code.  
> When sharing this repo, make sure you never commit the API key to any file.

#### 3. Translate text on a page

1. Open any web page with text you want to translate.
2. **Select** the text.
3. A small `T` button appears under the selection; click it to open the translation popup.
4. In the popup:
   - The extension shows the detected source language (for example: `EN` → `VI`).
   - You can change the target language from the dropdown.
   - You can change the style if needed (saved automatically).
5. After translation:
   - The translated text is shown in the result area.
   - Click **Copy** to copy the translation to the clipboard.

### Project Structure

- **`manifest.json`**: Manifest V3 declaration, permissions (`storage`, `activeTab`, `host_permissions` for `api.openai.com`), background service worker, content script, popup, icons.
- **`background.js`**: Calls the OpenAI API and handles `translate` messages.
- **`content.js`**: Injects UI, listens for text selection, shows `T` button, popup, and talks to the background script.
- **`content.css`**: Styles for the trigger button and translation popup (runs in the content script).
- **`popup.html`**: Popup UI when clicking the extension icon.
- **`popup.js`**: Loads/saves API key, style, and target language in the popup.
- **`popup.css`**: Styles for the settings popup.
- **`icons/`**: 16/48/128 px icons for the extension.

### Permissions & Security

- **Chrome permissions**:
  - `storage`: Store the API key, translation style, and target language in the browser.
  - `activeTab`: Allow the content script to run on the active tab and read selected text.
  - `host_permissions` for `https://api.openai.com/*`: Send requests to the OpenAI API.
- **API key security**:
  - The API key is **only stored locally** in `chrome.storage.sync`.
  - No config file in the repo contains a hardcoded API key.
  - When others use this project, they must provide their own key.

### Development

- Environment:
  - Plain JavaScript; no bundler or build step.
  - Background script runs as a Manifest V3 service worker.
- Workflow:
  - Edit JS/CSS/HTML files.
  - In `chrome://extensions/`, click **Reload** on the extension.
  - Reload the web page tab so the updated content script is injected.

### Notes

- The default model is **`gpt-4o-mini`**.  
- You can change the model or API parameters inside `background.js` if needed.

