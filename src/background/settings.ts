// Open the Context Kit popup on the Devdy tab (token / instance settings).

/** One-shot hint read (and cleared) by the popup shell to pick its first tab. */
export const OPEN_TAB_KEY = 'contextKitOpenTab';

export async function openSettings(): Promise<void> {
  await chrome.storage.local.set({ [OPEN_TAB_KEY]: 'devdy' });
  try {
    await chrome.action.openPopup();
  } catch {
    await chrome.tabs.create({ url: chrome.runtime.getURL('src/popup/index.html') });
  }
}
