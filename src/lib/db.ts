import { openDB, type IDBPDatabase } from 'idb';
import type { ConversionResult } from './result';

const DB_NAME = 'arca';
const STORE = 'results';

let dbPromise: Promise<IDBPDatabase> | null = null;

async function init(): Promise<boolean> {
  if (dbPromise) return true;
  try {
    dbPromise = openDB(DB_NAME, 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' });
        }
      },
    });
    await dbPromise;
    return true;
  } catch {
    return false;
  }
}

const memory: ConversionResult[] = [];

export async function addResult(r: ConversionResult): Promise<void> {
  if (!(await init())) {
    memory.unshift(r);
    memory.length = Math.min(memory.length, 200);
    return;
  }
  (await dbPromise)!.put(STORE, r);
}

export async function listResults(): Promise<ConversionResult[]> {
  if (!(await init())) return memory;
  const all = await (await dbPromise)!.getAll(STORE);
  all.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return all;
}

export async function deleteResult(id: string): Promise<void> {
  if (!(await init())) {
    const i = memory.findIndex((r) => r.id === id);
    if (i >= 0) memory.splice(i, 1);
    return;
  }
  (await dbPromise)!.delete(STORE, id);
}

export async function clearResults(): Promise<void> {
  if (!(await init())) {
    memory.length = 0;
    return;
  }
  (await dbPromise)!.clear(STORE);
}
