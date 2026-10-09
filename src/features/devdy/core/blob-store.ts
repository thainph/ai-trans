// Tiny IndexedDB key → Blob store for the Devdy outbox. Shared by the service
// worker and the offscreen document (same extension origin → same database),
// so a zip built offscreen never has to cross runtime messaging (JSON only).

const DB_NAME = 'context-kit';
const DB_VERSION = 1;
const STORE = 'devdy-outbox';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        dbPromise = null;
        reject(req.error);
      };
    });
  }
  return dbPromise;
}

async function run<T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = op(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function putBlob(id: string, blob: Blob): Promise<void> {
  await run('readwrite', (s) => s.put(blob, id));
}

export async function getBlob(id: string): Promise<Blob | undefined> {
  return run<Blob | undefined>('readonly', (s) => s.get(id) as IDBRequest<Blob | undefined>);
}

export async function deleteBlob(id: string): Promise<void> {
  await run('readwrite', (s) => s.delete(id));
}
