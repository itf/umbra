/**
 * IndexedDB-backed level storage. Levels are saved by name; the editor lists,
 * loads, saves, and deletes them. JSON import/export is handled separately
 * (exportLevel/importLevel) for sharing and committing.
 */
import type { Level } from './schema';
import { isLevel } from './schema';

const DB_NAME = 'papasangre-levels';
const STORE = 'levels';
const VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'name' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        t.oncomplete = () => db.close();
      }),
  );
}

export function saveLevel(level: Level): Promise<void> {
  return tx('readwrite', (s) => s.put(level)).then(() => undefined);
}

export function loadLevel(name: string): Promise<Level | undefined> {
  return tx<Level | undefined>('readonly', (s) => s.get(name) as IDBRequest<Level | undefined>);
}

export function deleteLevel(name: string): Promise<void> {
  return tx('readwrite', (s) => s.delete(name)).then(() => undefined);
}

export function listLevels(): Promise<string[]> {
  return tx<IDBValidKey[]>('readonly', (s) => s.getAllKeys()).then((keys) =>
    keys.map(String).sort(),
  );
}

/** Serialize a level to a downloadable JSON string. */
export function exportLevel(level: Level): string {
  return JSON.stringify(level, null, 2);
}

/** Parse + validate a JSON string into a Level (throws on invalid). */
export function importLevel(json: string): Level {
  const parsed = JSON.parse(json);
  if (!isLevel(parsed)) throw new Error('Not a valid level file (schema mismatch).');
  return parsed;
}
