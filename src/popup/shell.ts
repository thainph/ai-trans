// Popup shell: a tab bar that hosts each tool's original popup page in an
// iframe. The pages are same-origin extension pages, so chrome.* APIs work
// inside them, and their CSS/IDs stay isolated from each other.

type ToolId = 'translator' | 'web-to-md' | 'slack' | 'devdy';

const TOOL_PAGES: Record<ToolId, string> = {
  translator: '/src/features/translator/popup/popup.html',
  'web-to-md': '/src/features/web-to-md/popup/popup.html',
  slack: '/src/features/slack/popup/popup.html',
  devdy: '/src/features/devdy/popup/popup.html',
};

const LAST_TAB_KEY = 'contextKitLastTab';
/** One-shot request to open a given tab (set by the background's openSettings). */
const OPEN_TAB_KEY = 'contextKitOpenTab';

// Sub-pages were designed as standalone popups with a fixed body width.
const EMBED_CSS = 'html, body { width: auto !important; min-width: 0 !important; overflow: hidden !important; }';

const panelsEl = document.getElementById('panels')!;
const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('.tab'));
const toolFrames = new Map<ToolId, HTMLIFrameElement>();

function isToolId(v: unknown): v is ToolId {
  return typeof v === 'string' && v in TOOL_PAGES;
}

/** Keep the iframe as tall as its content so the popup itself sizes/scrolls. */
function autoSize(frame: HTMLIFrameElement): void {
  const doc = frame.contentDocument;
  if (!doc) return;
  const style = doc.createElement('style');
  style.textContent = EMBED_CSS;
  doc.head.appendChild(style);

  const fit = () => {
    frame.style.height = `${doc.documentElement.scrollHeight}px`;
  };
  new ResizeObserver(fit).observe(doc.body);
  fit();
}

function getFrame(tool: ToolId): HTMLIFrameElement {
  let frame = toolFrames.get(tool);
  if (!frame) {
    // Created lazily: e.g. Web → MD scrapes the page as soon as it loads.
    frame = document.createElement('iframe');
    frame.className = 'panel';
    frame.title = tool;
    frame.addEventListener('load', () => autoSize(frame!));
    frame.src = TOOL_PAGES[tool];
    panelsEl.appendChild(frame);
    toolFrames.set(tool, frame);
  }
  return frame;
}

function show(tool: ToolId): void {
  for (const tab of tabs) {
    const active = tab.dataset.tool === tool;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  }
  const current = getFrame(tool);
  for (const frame of toolFrames.values()) frame.hidden = frame !== current;
  current.focus();
  void chrome.storage.local.set({ [LAST_TAB_KEY]: tool });
}

/** Picks the tab to open. Storage and the active tab are read in parallel so
 *  the first iframe starts loading as early as possible. */
async function initialTool(): Promise<ToolId> {
  const [stored, activeTab] = await Promise.all([
    chrome.storage.local.get([OPEN_TAB_KEY, LAST_TAB_KEY]),
    chrome.tabs
      .query({ active: true, currentWindow: true })
      .then(([tab]) => tab)
      .catch(() => undefined), // best effort only
  ]);
  const once = stored[OPEN_TAB_KEY];
  if (isToolId(once)) {
    void chrome.storage.local.remove(OPEN_TAB_KEY);
    return once;
  }
  if (activeTab?.url?.startsWith('https://app.slack.com/')) return 'slack';
  const last = stored[LAST_TAB_KEY];
  return isToolId(last) ? last : 'translator';
}

for (const tab of tabs) {
  tab.addEventListener('click', () => {
    if (isToolId(tab.dataset.tool)) show(tab.dataset.tool);
  });
}

// Tool pages (same-origin iframes) can ask to switch tab, e.g. "Open Devdy settings".
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin) return;
  const data = e.data as { type?: string; tool?: unknown } | null;
  if (data?.type === 'context-kit-open-tab' && isToolId(data.tool)) show(data.tool);
});

void initialTool().then(show);
