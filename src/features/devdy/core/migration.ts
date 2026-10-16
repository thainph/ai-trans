// One-time cleanup of the blob-based outbox of AI Trans ≤ 2.1 (Markdown/zip
// exports for Devdy's old upload API). Those payloads can't be sent any more —
// Devdy now takes Slack thread links only — so they are dropped, and the user
// is told once (a notice in the Devdy tab) when there was anything to drop.

/** chrome.storage.local keys of the old outbox. */
export const LEGACY_OUTBOX_KEYS = ['devdyOutbox', 'devdyOutboxState'] as const;
/** IndexedDB database that held the old payloads (store "devdy-outbox"). */
export const LEGACY_DB_NAME = 'context-kit';

export interface MigrationDeps {
  getLocal(keys: readonly string[]): Promise<Record<string, unknown>>;
  removeLocal(keys: readonly string[]): Promise<void>;
  deleteDatabase(name: string): Promise<void>;
  setNotice(text: string): Promise<void>;
}

/** Drop the old outbox; returns how many queued/failed exports were dropped. */
export async function migrateLegacyOutbox(deps: MigrationDeps): Promise<number> {
  const old = await deps.getLocal(LEGACY_OUTBOX_KEYS);
  const entries = old.devdyOutbox;
  const dropped = Array.isArray(entries) ? entries.length : 0;
  if (LEGACY_OUTBOX_KEYS.some((k) => k in old)) await deps.removeLocal(LEGACY_OUTBOX_KEYS);
  // Harmless when the database doesn't exist; never let it block the rest.
  await deps.deleteDatabase(LEGACY_DB_NAME).catch(() => {});
  if (dropped > 0) {
    await deps.setNotice(
      `${dropped} export${dropped === 1 ? '' : 's'} queued by the previous version ${dropped === 1 ? 'was' : 'were'} dropped: ` +
        'Devdy now receives Slack thread links only (web pages are no longer sent). ' +
        'Send the threads again from Slack (message menu → Send to Devdy).',
    );
  }
  return dropped;
}
