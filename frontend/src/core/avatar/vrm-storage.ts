const DB_NAME = "deerflow-avatar";
const DB_VERSION = 1;
const STORE_NAME = "models";
const MODEL_KEY = "avatar.vrm";

/**
 * Local VRM model storage.
 *
 * Models live in IndexedDB rather than localStorage: a VRM file easily exceeds
 * the ~5MB localStorage quota, and keeping the binary in the browser avoids
 * both committing it to the repository and adding a server-side upload path.
 */

function isSupported(): boolean {
  return typeof indexedDB !== "undefined";
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("indexedDB open"));
  });
}

function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDatabase().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, mode);
        const request = run(transaction.objectStore(STORE_NAME));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () =>
          reject(request.error ?? new Error("indexedDB request"));
        transaction.oncomplete = () => db.close();
      }),
  );
}

export async function getStoredModel(): Promise<Blob | null> {
  if (!isSupported()) {
    return null;
  }
  try {
    const stored = await withStore<unknown>("readonly", (store) =>
      store.get(MODEL_KEY),
    );
    return stored instanceof Blob ? stored : null;
  } catch {
    return null;
  }
}

export async function putModel(model: Blob): Promise<void> {
  if (!isSupported()) {
    return;
  }
  await withStore("readwrite", (store) => store.put(model, MODEL_KEY));
}

export async function clearModel(): Promise<void> {
  if (!isSupported()) {
    return;
  }
  try {
    await withStore("readwrite", (store) => store.delete(MODEL_KEY));
  } catch {
    // Nothing to clean up when the record is already gone.
  }
}

/**
 * A VRM file is a GLB container, so it always starts with the `glTF` magic.
 */
export async function isGlbContainer(file: Blob): Promise<boolean> {
  const header = await file.slice(0, 4).arrayBuffer();
  if (header.byteLength < 4) {
    return false;
  }
  return new TextDecoder().decode(header) === "glTF";
}
