import initSqlJs from 'sql.js';
import type { Database, SqlJsStatic } from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import schemaSql from '../../db/schema.sql?raw';
import seedSql from '../../db/seed.sql?raw';

export type DB = Database;

const PERSIST_KEY = 'hypertroph.db.v1';

let sqlStatic: SqlJsStatic | null = null;

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function getStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/**
 * Load the SQLite database. In the browser base model this uses sql.js (WASM)
 * with a localStorage persisted image. In the Tauri build, this function is
 * replaced by a rusqlite-backed implementation behind the same repository API.
 */
export async function loadDatabase(): Promise<DB> {
  if (!sqlStatic) {
    sqlStatic = await initSqlJs({ locateFile: () => wasmUrl });
  }

  const storage = getStorage();
  const stored = storage?.getItem(PERSIST_KEY);
  let db: DB;

  if (stored) {
    db = new sqlStatic.Database(base64ToBytes(stored));
  } else {
    db = new sqlStatic.Database();
    db.run(schemaSql);
    db.run(seedSql);
    persist(db);
  }

  db.run('PRAGMA foreign_keys = ON;');
  return db;
}

export function persist(db: DB): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(PERSIST_KEY, bytesToBase64(db.export()));
  } catch {
    /* quota or unavailable storage - non-fatal for the base model */
  }
}

export function resetDatabase(): void {
  getStorage()?.removeItem(PERSIST_KEY);
}

export function exportDatabaseBytes(db: DB): Uint8Array {
  return db.export();
}
