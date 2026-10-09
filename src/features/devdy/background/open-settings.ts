// Open the Context Kit popup on the Devdy tab (token / instance settings).

import { OPEN_TAB_KEY, type ToolId } from '../../../shared/popup-tabs';

export async function openSettings(): Promise<void> {
  await chrome.storage.local.set({ [OPEN_TAB_KEY]: 'devdy' satisfies ToolId });
  try {
    await chrome.action.openPopup();
  } catch {
    await chrome.tabs.create({ url: chrome.runtime.getURL('src/popup/index.html') });
  }
}
