import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { getSqlStatic } from './db';
import { bytesToBase64, storage } from './storage';

/**
 * Portable, validated backup/restore of the whole tracking database.
 *
 * The backup format is simply the raw SQLite image (`.sqlite`), which is
 * lossless and re-importable. Import validates the file *before* anything is
 * overwritten, so a corrupt or foreign file can never destroy live data.
 */

// Core tables every hypertroph+ database must contain. A file missing any of
// these is not one of our backups and is rejected.
const REQUIRED_TABLES = [
  'schema_migrations',
  'foods',
  'food_nutrients',
  'log_days',
  'log_items',
  'log_item_nutrients',
  'exercises',
  'workouts',
  'workout_exercises',
  'sets',
  'preferences',
];

const SQLITE_HEADER = 'SQLite format 3\0';

export interface BackupInspection {
  ok: boolean;
  schemaVersion: number;
  tables: string[];
  missing: string[];
  error?: string;
}

function fail(error: string, tables: string[] = []): BackupInspection {
  return { ok: false, schemaVersion: 0, tables, missing: [...REQUIRED_TABLES], error };
}

/** Validate a candidate backup without touching the live database. */
export async function inspectBackup(bytes: Uint8Array): Promise<BackupInspection> {
  if (bytes.length < 100) return fail('File is too small to be a database.');
  if (String.fromCharCode(...bytes.subarray(0, 16)) !== SQLITE_HEADER) {
    return fail('Not a SQLite database file.');
  }

  let db;
  try {
    const SQL = await getSqlStatic();
    db = new SQL.Database(bytes);
  } catch {
    return fail('Could not open the file as a database.');
  }

  try {
    const integrity = db.exec('PRAGMA integrity_check')[0]?.values?.[0]?.[0];
    if (integrity !== 'ok') return fail(`Integrity check failed: ${String(integrity)}`);

    const tables = (db.exec("SELECT name FROM sqlite_master WHERE type='table'")[0]?.values ?? []).map((r) =>
      String(r[0]),
    );
    const missing = REQUIRED_TABLES.filter((t) => !tables.includes(t));
    if (missing.length) {
      return { ok: false, schemaVersion: 0, tables, missing, error: `Not a hypertroph+ backup (missing: ${missing.join(', ')}).` };
    }

    let schemaVersion = 0;
    const v = db.exec('SELECT MAX(version) AS v FROM schema_migrations')[0]?.values?.[0]?.[0];
    if (typeof v === 'number') schemaVersion = v;

    const fk = db.exec('PRAGMA foreign_key_check');
    if (fk.length && (fk[0]?.values?.length ?? 0) > 0) {
      return { ok: false, schemaVersion, tables, missing: [], error: 'Database failed its foreign-key check.' };
    }

    return { ok: true, schemaVersion, tables, missing: [] };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  } finally {
    db.close();
  }
}

export type ExportResult = 'shared' | 'downloaded';

/**
 * Export the current database image. On native it is written to the app cache
 * and handed to the OS share sheet (Files, Drive, mail…). On the web it is
 * downloaded. No network is involved either way.
 */
export async function exportBackup(bytes: Uint8Array): Promise<ExportResult> {
  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `hypertroph-backup-${stamp}.sqlite`;

  if (storage.kind === 'native') {
    await Filesystem.writeFile({
      path: filename,
      data: bytesToBase64(bytes),
      directory: Directory.Cache,
      recursive: true,
    });
    const { uri } = await Filesystem.getUri({ path: filename, directory: Directory.Cache });
    await Share.share({
      title: 'hypertroph+ backup',
      text: `hypertroph+ backup (${stamp})`,
      url: uri,
      dialogTitle: `Save ${filename}`,
    });
    return 'shared';
  }

  const copy = new Uint8Array(bytes);
  const blob = new Blob([copy.buffer], { type: 'application/vnd.sqlite3' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return 'downloaded';
}

/**
 * Validate a backup and, if valid, replace the persisted image. The caller is
 * expected to reload the app afterwards so the repository is rebuilt from the
 * restored database. Returns the validation report.
 */
export async function importBackup(bytes: Uint8Array): Promise<BackupInspection> {
  const report = await inspectBackup(bytes);
  if (!report.ok) return report;
  storage.save(bytes);
  await storage.flush();
  return report;
}
