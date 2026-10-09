import type { DB } from './db';
import { getSqlStatic } from './db';

/**
 * Read-only reference database (USDA FoodData Central, CC0).
 *
 * The pack is shipped gzipped in `public/` and is *not* loaded into the user
 * database. It is opened as a second in-memory SQLite database and queried
 * alongside the user DB for food search/preview. Foods chosen by the user are
 * copied into the user DB on log (see SqliteRepository), so the reference pack
 * never needs to be written to and never grows the persisted user store beyond
 * what the user actually logs.
 */

const REF_FILENAME = 'hypertroph-ref.sqlite.gz';

let refPromise: Promise<DB | null> | null = null;

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('DecompressionStream is not available in this runtime');
  }
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  const stream = new Blob([copy.buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function refDatabaseUrl(): string {
  const base = import.meta.env.BASE_URL ?? './';
  return `${base}${REF_FILENAME}`;
}

/** Load the reference DB once per session. Returns null (non-fatal) if unavailable. */
export function loadRefDatabase(): Promise<DB | null> {
  if (!refPromise) {
    refPromise = (async () => {
      try {
        const res = await fetch(refDatabaseUrl());
        if (!res.ok) return null;
        const raw = await gunzip(new Uint8Array(await res.arrayBuffer()));
        const SQL = await getSqlStatic();
        return new SQL.Database(raw);
      } catch (e) {
        console.warn('Reference database unavailable; continuing with local foods only.', e);
        return null;
      }
    })();
  }
  return refPromise;
}
