// Content scripts outlive their extension: after an update/reload the old
// script keeps running but every chrome.* call throws. Guard calls with this.

export function isExtensionAlive(): boolean {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}
