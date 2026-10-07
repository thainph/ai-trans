// Popup shell: a tab bar that hosts each tool's original popup page in an
// iframe. The pages are same-origin extension pages, so chrome.* APIs work
// inside them, and their CSS/IDs stay isolated from each other.

type ToolId = 'translator' | 'web-to-md' | 'slack';

const TOOL_PAGES: Record<ToolId, string> = {
  translator: '/translator/popup.html',
  'web-to-md': '/web-to-md/popup.html',
  slack: '/src/slack/popup/popup.html',
};

const LAST_TAB_KEY = 'contextKitLastTab';

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

async function initialTool(): Promise<ToolId> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url?.startsWith('https://app.slack.com/')) return 'slack';
  } catch {
    // Best effort only.
  }
  const stored = await chrome.storage.local.get(LAST_TAB_KEY);
  const last = stored[LAST_TAB_KEY];
  return isToolId(last) ? last : 'translator';
}

for (const tab of tabs) {
  tab.addEventListener('click', () => {
    if (isToolId(tab.dataset.tool)) show(tab.dataset.tool);
  });
}

void initialTool().then(show);
