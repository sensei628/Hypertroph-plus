import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { getSqlStatic, LATEST_SCHEMA_VERSION, migrateToLatest, type DB } from './db';
import { bytesToBase64, storage } from './storage';
import { getDesktopBridge } from '../desktop';

/**
 * Portable, validated backup/restore of the whole tracking database.
 *
 * The backup format is simply the raw SQLite image (`.sqlite`), which is
 * lossless and re-importable. Import validates (and, when needed, upgrades) the
 * file *before* anything is overwritten, so a corrupt or foreign file can never
 * destroy live data.
 */

// Tables every hypertroph+ database must contain after being upgraded to the
// latest schema. A file missing any of these is not one of our backups.
const REQUIRED_TABLES = [
  'schema_migrations',
  'sources',
  'nutrients',
  'foods',
  'food_nutrients',
  'food_portions',
  'food_aliases',
  'muscles',
  'equipment',
  'movement_patterns',
  'exercise_categories',
  'exercises',
  'exercise_patterns',
  'exercise_aliases',
  'exercise_muscles',
  'exercise_equipment',
  'log_days',
  'log_items',
  'log_item_nutrients',
  'targets',
  'target_history',
  'nutrition_plans',
  'routines',
  'routine_exercises',
  'workouts',
  'workout_exercises',
  'sets',
  'personal_records',
  'body_metrics',
  'favorites',
  'recent_uses',
  'preferences',
  'diet_plan',
  'diet_plan_meal',
  'diet_plan_item',
  'diet_plan_check',
  'protein_source',
  'diet_plan_protein_item',
  'micronutrient_target',
];

const SQLITE_HEADER = 'SQLite format 3\0';

export interface BackupInspection {
  ok: boolean;
  schemaVersion: number;
  targetVersion: number;
  tables: string[];
  missing: string[];
  willMigrate: boolean;
  error?: string;
}

/** How an imported backup should be applied. */
export type ImportMode = 'replace' | 'merge';

export interface ImportReport {
  ok: boolean;
  mode: ImportMode;
  schemaVersion: number;
  migratedFrom: number | null;
  inserted: number;
  skipped: number;
  safetyCopy: string | null;
  error?: string;
}

export type ExportResult = 'shared' | 'downloaded' | 'saved' | 'cancelled';

interface Prepared {
  ok: boolean;
  schemaVersion: number;
  migratedFrom: number | null;
  tables: string[];
  missing: string[];
  bytes?: Uint8Array;
  error?: string;
}

// --- SQLite helpers -------------------------------------------------------

function quoteIdent(id: string): string {
  return `"${id.replace(/"/g, '""')}"`;
}

function listTables(db: DB): string[] {
  const res = db.exec("SELECT name FROM sqlite_master WHERE type = 'table'");
  return res.length ? res[0].values.map((r) => String(r[0])) : [];
}

function columnsOf(db: DB, table: string): string[] {
  const res = db.exec(`PRAGMA table_info(${quoteIdent(table)})`);
  if (!res.length) return [];
  const idx = res[0].columns.indexOf('name');
  return res[0].values.map((r) => String(r[idx]));
}

function countRows(db: DB, table: string): number {
  const res = db.exec(`SELECT COUNT(*) FROM ${quoteIdent(table)}`);
  return res.length ? Number(res[0].values[0][0]) : 0;
}

// Tables without a stable id use a natural key (name + date) so re-importing a
// file never duplicates a record the user already has.
function naturalKey(cols: string[]): string[] | null {
  if (!cols.includes('name')) return null;
  const dateCol = ['local_date', 'log_date', 'date', 'day'].find((c) => cols.includes(c));
  return dateCol ? ['name', dateCol] : null;
}

// --- Validation / upgrade -------------------------------------------------

async function prepareImport(bytes: Uint8Array): Promise<Prepared> {
  const target = LATEST_SCHEMA_VERSION;
  const none = (error: string, tables: string[] = []): Prepared => ({
    ok: false,
    schemaVersion: 0,
    migratedFrom: null,
    tables,
    missing: [...REQUIRED_TABLES],
    error,
  });

  if (bytes.length < 100) return none('File is too small to be a database.');
  if (String.fromCharCode(...bytes.subarray(0, 16)) !== SQLITE_HEADER) {
    return none('Not a SQLite database file.');
  }

  let db: DB;
  try {
    const SQL = await getSqlStatic();
    db = new SQL.Database(bytes);
  } catch {
    return none('Could not open the file as a database.');
  }

  try {
    const integrity = db.exec('PRAGMA integrity_check')[0]?.values?.[0]?.[0];
    if (integrity !== 'ok') return none(`Integrity check failed: ${String(integrity)}`);

    const tables = listTables(db);
    const uvRow = db.exec('PRAGMA user_version')[0]?.values?.[0]?.[0];
    const userVersion = typeof uvRow === 'number' ? uvRow : Number(uvRow) || 0;
    let migrationVersion = 0;
    try {
      const mv = db.exec('SELECT MAX(version) AS v FROM schema_migrations')[0]?.values?.[0]?.[0];
      if (typeof mv === 'number') migrationVersion = mv;
    } catch {
      migrationVersion = 0;
    }
    const schemaVersion = Math.max(userVersion, migrationVersion);

    if (!tables.includes('schema_migrations') && schemaVersion === 0) {
      const missing = REQUIRED_TABLES.filter((t) => !tables.includes(t));
      return {
        ok: false,
        schemaVersion,
        migratedFrom: null,
        tables,
        missing,
        error: `Not a hypertroph+ backup (missing: ${missing.join(', ')}).`,
      };
    }

    if (schemaVersion > target) {
      return {
        ok: false,
        schemaVersion,
        migratedFrom: null,
        tables,
        missing: [],
        error: `This backup is from a newer version (schema v${schemaVersion}); update hypertroph+ to import it.`,
      };
    }

    let migratedFrom: number | null = null;
    if (schemaVersion < target) {
      try {
        migrateToLatest(db);
        migratedFrom = schemaVersion;
      } catch (e) {
        return {
          ok: false,
          schemaVersion,
          migratedFrom: null,
          tables,
          missing: [],
          error: `Could not upgrade backup from schema v${schemaVersion}: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    }

    const finalTables = listTables(db);
    const missing = REQUIRED_TABLES.filter((t) => !finalTables.includes(t));
    if (missing.length) {
      return {
        ok: false,
        schemaVersion,
        migratedFrom,
        tables: finalTables,
        missing,
        error: `Not a hypertroph+ backup (missing: ${missing.join(', ')}).`,
      };
    }

    const fk = db.exec('PRAGMA foreign_key_check');
    if (fk.length && (fk[0]?.values?.length ?? 0) > 0) {
      return {
        ok: false,
        schemaVersion,
        migratedFrom,
        tables: finalTables,
        missing: [],
        error: 'Backup failed its foreign-key check.',
      };
    }

    return { ok: true, schemaVersion, migratedFrom, tables: finalTables, missing: [], bytes: db.export() };
  } catch (e) {
    return none(e instanceof Error ? e.message : String(e));
  } finally {
    db.close();
  }
}

/** Validate a candidate backup without touching the live database. */
export async function inspectBackup(bytes: Uint8Array): Promise<BackupInspection> {
  const p = await prepareImport(bytes);
  return {
    ok: p.ok,
    schemaVersion: p.schemaVersion,
    targetVersion: LATEST_SCHEMA_VERSION,
    tables: p.tables,
    missing: p.missing,
    willMigrate: p.migratedFrom !== null,
    error: p.error,
  };
}

// --- Platform plumbing ----------------------------------------------------

function isCapacitorNative(): boolean {
  try {
    return typeof window !== 'undefined' && Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

interface SaveFileHandle {
  createWritable: () => Promise<{ write: (data: Uint8Array) => Promise<void>; close: () => Promise<void> }>;
}

function getSavePicker(): ((opts: unknown) => Promise<SaveFileHandle>) | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { showSaveFilePicker?: (opts: unknown) => Promise<SaveFileHandle> };
  return typeof w.showSaveFilePicker === 'function' ? w.showSaveFilePicker.bind(window) : null;
}

function backupStamp(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}

function fullStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

function downloadBlob(bytes: Uint8Array, filename: string): void {
  const copy = new Uint8Array(bytes);
  const blob = new Blob([copy.buffer], { type: 'application/vnd.sqlite3' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Export the current database image as `nutrition-backup-YYYYMMDD.sqlite`.
 * On native it is handed to the OS share sheet (user chooses the destination);
 * on the web/desktop we prefer the File System Access API (a real "save as"
 * dialog) and fall back to a plain download. No network is involved.
 */
export async function exportBackup(bytes: Uint8Array): Promise<ExportResult> {
  const stamp = backupStamp();
  const filename = `nutrition-backup-${stamp}.sqlite`;

  if (isCapacitorNative()) {
    // Mobile path — never touches showSaveFilePicker / anchor-download / Blob URLs.
    // Write the image to the app cache, then hand the *file* to the OS share sheet
    // so the user can save it to Files/Drive or send it anywhere.
    try {
      const written = await Filesystem.writeFile({
        path: filename,
        data: bytesToBase64(bytes),
        directory: Directory.Cache,
        recursive: true,
      });
      const uri =
        written.uri || (await Filesystem.getUri({ path: filename, directory: Directory.Cache })).uri;

      const canShare = await Share.canShare().catch(() => ({ value: true }));
      if (!canShare.value) {
        const saved = await exportBackupToFolder(bytes);
        if (saved.ok) return 'saved';
        throw new Error(saved.error ?? 'Sharing is unavailable and the backup could not be saved.');
      }

      // Share the file only (no `text`): passing text forces a text/plain intent and
      // can make receivers drop the .sqlite stream. With just `url` the plugin sends
      // EXTRA_STREAM + a */* type, so every file-save/share target is offered.
      await Share.share({
        title: `hypertroph+ backup (${stamp})`,
        url: uri,
        dialogTitle: 'Save backup',
      });
      return 'shared';
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // The Capacitor Share plugin rejects with "Share canceled" when the user
      // dismisses the sheet; that is not an error.
      if (/cancel/i.test(message)) return 'cancelled';
      console.error('Mobile backup export failed', e);
      throw new Error(message);
    }
  }

  const desktop = getDesktopBridge();
  if (desktop?.saveBackup) {
    try {
      const res = await desktop.saveBackup(bytes, filename);
      if (res.ok) return 'saved';
      if (res.canceled) return 'cancelled';
    } catch {
      // Older shell or IPC failure: fall back to a browser download.
    }
  }

  const picker = getSavePicker();
  if (picker) {
    try {
      const handle = await picker({
        suggestedName: filename,
        types: [{ description: 'SQLite database', accept: { 'application/vnd.sqlite3': ['.sqlite'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(bytes);
      await writable.close();
      return 'saved';
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return 'cancelled';
      // Any other failure (unsupported/denied) falls back to a download.
    }
  }

  downloadBlob(bytes, filename);
  return 'downloaded';
}

export interface FolderSaveResult {
  ok: boolean;
  /** Where the file landed (a file:// URI on Android/iOS). */
  uri?: string;
  error?: string;
}

/** True when running inside the Capacitor native shell (Android/iOS). */
export function isNativeMobile(): boolean {
  return isCapacitorNative();
}

/**
 * Mobile "Save to folder".
 *
 * Expo's Storage Access Framework has no Capacitor binding, so we write the
 * backup straight into the device file area with the Filesystem plugin:
 *   • Android: public Documents, falling back to the app's own external files
 *     directory if the public folder is not writable (Android 11+ scoping);
 *   • iOS: the app's Documents directory.
 * On Android the public-storage permission is requested first; if every target
 * fails we return the real error instead of silently doing nothing. Everything is
 * wrapped, so the caller always gets a concrete success/failure message.
 */
export async function exportBackupToFolder(bytes: Uint8Array): Promise<FolderSaveResult> {
  if (!isCapacitorNative()) {
    return { ok: false, error: 'Saving to a folder is only available on the mobile app.' };
  }
  const filename = `nutrition-backup-${backupStamp()}.sqlite`;
  const targets: Directory[] = [Directory.Documents, Directory.External];
  let lastError = 'Could not write the backup file.';
  for (const directory of targets) {
    try {
      if (directory === Directory.Documents) {
        try {
          const status = await Filesystem.checkPermissions();
          if (status.publicStorage !== 'granted') await Filesystem.requestPermissions();
        } catch (permError) {
          console.warn('Storage permission request failed; attempting the write anyway', permError);
        }
      }
      const res = await Filesystem.writeFile({
        path: filename,
        data: bytesToBase64(bytes),
        directory,
        recursive: true,
      });
      return { ok: true, uri: res.uri };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      console.error(`Saving backup to ${directory} failed`, e);
    }
  }
  return { ok: false, error: lastError };
}

// Best-effort copy of the live database, written non-interactively before a
// destructive "replace" import so the user can always roll back.
async function saveSafetyCopy(bytes: Uint8Array): Promise<string | null> {
  const filename = `nutrition-backup-before-import-${fullStamp()}.sqlite`;
  try {
    if (isCapacitorNative()) {
      await Filesystem.writeFile({
        path: filename,
        data: bytesToBase64(bytes),
        directory: Directory.Data,
        recursive: true,
      });
      return filename;
    }
    if (typeof document !== 'undefined') {
      downloadBlob(bytes, filename);
      return filename;
    }
  } catch {
    // Non-fatal: the user already confirmed the replace.
  }
  return null;
}

// --- Merge ----------------------------------------------------------------

function rowExists(db: DB, table: string, keys: string[], values: unknown[], cols: string[]): boolean {
  const cond = keys.map((c) => `${quoteIdent(c)} = ?`).join(' AND ');
  const params = keys.map((c) => values[cols.indexOf(c)]);
  const res = db.exec(`SELECT 1 FROM ${quoteIdent(table)} WHERE ${cond} LIMIT 1`, params as never[]);
  return res.length > 0 && res[0].values.length > 0;
}

interface MergeResult {
  ok: boolean;
  bytes?: Uint8Array;
  inserted: number;
  skipped: number;
  error?: string;
}

async function mergeImported(currentBytes: Uint8Array, importedBytes: Uint8Array): Promise<MergeResult> {
  const SQL = await getSqlStatic();
  let dest: DB | null = null;
  let src: DB | null = null;
  try {
    dest = new SQL.Database(currentBytes);
    src = new SQL.Database(importedBytes);
    migrateToLatest(dest);
    dest.run('PRAGMA foreign_keys = OFF');

    const destTables = new Set(listTables(dest));
    const srcTables = listTables(src).filter((t) => destTables.has(t));
    let inserted = 0;
    let skipped = 0;

    for (const t of srcTables) {
      if (t === 'schema_migrations') continue;
      const destCols = columnsOf(dest, t);
      const res = src.exec(`SELECT * FROM ${quoteIdent(t)}`);
      if (!res.length || !res[0].values.length || !destCols.length) continue;
      const srcCols = res[0].columns;
      const cols = srcCols.filter((c) => destCols.includes(c));
      if (!cols.length) continue;

      const rows = res[0].values;
      const nat = naturalKey(destCols);
      const before = countRows(dest, t);
      const colList = cols.map(quoteIdent).join(', ');
      const bound = cols.map(() => '?').join(', ');
      const stmt = dest.prepare(`INSERT OR IGNORE INTO ${quoteIdent(t)} (${colList}) VALUES (${bound})`);

      for (const row of rows) {
        const values = cols.map((c) => row[srcCols.indexOf(c)]);
        if (nat && rowExists(dest, t, nat, values, cols)) continue;
        stmt.run(values as unknown as never[]);
      }
      stmt.free();

      const after = countRows(dest, t);
      inserted += after - before;
      skipped += rows.length - (after - before);
    }

    const violations = dest.exec('PRAGMA foreign_key_check');
    if (violations.length && (violations[0]?.values?.length ?? 0) > 0) {
      return { ok: false, inserted: 0, skipped: 0, error: 'Merged data failed its foreign-key check; nothing was saved.' };
    }

    return { ok: true, bytes: dest.export(), inserted, skipped };
  } catch (e) {
    return { ok: false, inserted: 0, skipped: 0, error: e instanceof Error ? e.message : String(e) };
  } finally {
    src?.close();
    dest?.close();
  }
}

// --- Import ---------------------------------------------------------------

/**
 * Validate (and upgrade) a backup, then apply it to the persisted image.
 *
 * - `replace`: overwrite everything, saving a safety copy of the current image
 *   first.
 * - `merge`: add records the device does not already have, skipping duplicates
 *   by id (or name + date where a table has no stable id).
 *
 * Nothing is written unless the whole operation (including a post-merge
 * foreign-key check) succeeds. The caller should reload afterwards so the
 * repository is rebuilt from the restored database.
 */
export async function importBackup(
  bytes: Uint8Array,
  mode: ImportMode = 'replace',
  currentBytes?: Uint8Array | null,
): Promise<ImportReport> {
  const prep = await prepareImport(bytes);
  const base = {
    mode,
    schemaVersion: prep.schemaVersion,
    migratedFrom: prep.migratedFrom,
    inserted: 0,
    skipped: 0,
    safetyCopy: null as string | null,
  };
  if (!prep.ok || !prep.bytes) {
    return { ok: false, ...base, error: prep.error ?? 'Invalid backup file.' };
  }

  try {
    if (mode === 'merge' && currentBytes && currentBytes.length) {
      const merged = await mergeImported(currentBytes, prep.bytes);
      if (!merged.ok || !merged.bytes) {
        return { ok: false, ...base, error: merged.error ?? 'Merge failed.' };
      }
      storage.save(merged.bytes);
      await storage.flush();
      return { ok: true, ...base, inserted: merged.inserted, skipped: merged.skipped };
    }

    let safetyCopy: string | null = null;
    if (mode === 'replace' && currentBytes && currentBytes.length) {
      safetyCopy = await saveSafetyCopy(currentBytes);
    }
    storage.save(prep.bytes);
    await storage.flush();
    return { ok: true, ...base, safetyCopy };
  } catch (e) {
    return { ok: false, ...base, error: e instanceof Error ? e.message : String(e) };
  }
}

// --- SQL import -----------------------------------------------------------

/**
 * Import a plain-text `.sql` script (schema + data) as a backup.
 *
 * The script is executed against a throwaway in-memory database inside a single
 * transaction, so a broken script can never partially write anything. If it
 * succeeds we hand the resulting image to the normal backup pipeline, which
 * applies the same version checks, migration and merge/replace logic.
 */
export async function importSqlBackup(
  sql: string,
  mode: ImportMode = 'replace',
  currentBytes?: Uint8Array | null,
): Promise<ImportReport> {
  const base = {
    mode,
    schemaVersion: 0,
    migratedFrom: null,
    inserted: 0,
    skipped: 0,
    safetyCopy: null as string | null,
  };
  const text = sql.trim();
  if (!text) return { ok: false, ...base, error: 'The SQL file is empty.' };

  let db: DB | null = null;
  let bytes: Uint8Array | null = null;
  try {
    const SQL = await getSqlStatic();
    db = new SQL.Database();
    db.run('BEGIN');
    try {
      db.run(text);
      db.run('COMMIT');
    } catch (e) {
      try {
        db.run('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw e;
    }
    bytes = db.export();
  } catch (e) {
    return { ok: false, ...base, error: `Invalid SQL: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }

  if (!bytes) return { ok: false, ...base, error: 'The SQL script produced no database.' };
  return importBackup(bytes, mode, currentBytes);
}

// --- AI prompt ------------------------------------------------------------

function readUserVersion(db: DB): number {
  const row = db.exec('PRAGMA user_version')[0]?.values?.[0]?.[0];
  return typeof row === 'number' ? row : Number(row) || 0;
}

function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return `X'${Array.from(value, (b) => b.toString(16).padStart(2, '0')).join('')}'`;
  return `'${String(value).replace(/'/g, "''")}'`;
}

function schemaDdl(db: DB): string {
  const res = db.exec(
    "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY (type = 'table') DESC, name",
  );
  if (!res.length) return '';
  return res[0].values.map((r) => `${String(r[0]).trim()};`).join('\n\n');
}

// A few real seeded rows, shown so an AI can mirror the exact insert format.
const SEED_SAMPLE_TABLES = ['protein_source', 'micronutrient_target', 'foods', 'food_nutrients'];

function sampleSeed(db: DB): string {
  const tables = new Set(listTables(db));
  const lines: string[] = [];
  for (const t of SEED_SAMPLE_TABLES) {
    if (!tables.has(t)) continue;
    const cols = columnsOf(db, t);
    if (!cols.length) continue;
    const res = db.exec(`SELECT ${cols.map(quoteIdent).join(', ')} FROM ${quoteIdent(t)} LIMIT 3`);
    if (!res.length || !res[0].values.length) continue;
    for (const row of res[0].values) {
      lines.push(`INSERT INTO ${t} (${cols.join(', ')}) VALUES (${row.map(sqlLiteral).join(', ')});`);
    }
  }
  return lines.join('\n');
}

// Column-list templates for the tables that describe a meal plan, so the AI
// knows exactly which rows to write for the requested plan.
const PLAN_TEMPLATE_TABLES = ['diet_plan', 'diet_plan_meal', 'diet_plan_item', 'diet_plan_protein_item'];

function insertTemplate(db: DB, table: string): string {
  const res = db.exec(`PRAGMA table_info(${quoteIdent(table)})`);
  if (!res.length) return '';
  const cols = res[0].values.map((r) => ({ name: String(r[1]), type: String(r[2] ?? '') }));
  if (!cols.length) return '';
  const names = cols.map((c) => c.name).join(', ');
  const vals = cols.map((c) => (/INT|REAL|NUM|FLOA|DOUB/i.test(c.type) ? '<number>' : "'<text>'")).join(', ');
  return `INSERT INTO ${table} (${names}) VALUES (${vals});`;
}

/**
 * Build a ready-to-paste AI prompt describing this exact database. It embeds
 * the live CREATE statements, the current schema version and an example of the
 * seed/insert format, then asks for a matching `.sqlite` (or `.sql`) file.
 */
export function buildAiPrompt(db: DB): string {
  const version = readUserVersion(db);
  const schema = schemaDdl(db) || '-- (schema unavailable)';
  const seed = sampleSeed(db) || '-- (no sample rows)';
  const templates = PLAN_TEMPLATE_TABLES.map((t) => insertTemplate(db, t))
    .filter(Boolean)
    .join('\n');

  return [
    'I use "hypertroph+", an offline-first nutrition & hypertrophy tracker. I want you to create a database file that I can import into it.',
    '',
    'It MUST use exactly this schema (same tables, columns, types and constraints):',
    '',
    schema,
    '',
    `Declare the schema version exactly once: PRAGMA user_version = ${version};`,
    '',
    'Here is the row/insert format (real sample values):',
    '',
    seed,
    '',
    'To describe a diet / meal plan, write rows like these:',
    '',
    templates,
    '',
    'Rules:',
    '- Keep every table, column, type and constraint exactly as shown — do not add, remove or rename anything.',
    "- TEXT primary keys are ids; any unique string is fine (e.g. 'diet_plan_1').",
    '- Timestamps are UTC epoch milliseconds (INTEGER).',
    '- Nutrient amounts are fixed-point integers: amount_milli = amount * 1000 (so 12.5 g -> 12500). NULL means unknown, never 0.',
    '- If you can produce a binary file, export a real SQLite database named "nutrition-backup.sqlite".',
    '- If you can only return text, output a single .sql script of plain statements (no BEGIN/COMMIT) that creates and populates this schema.',
    '',
    'create a .sqlite file with this exact schema containing my meal plan: <describe your needs>',
  ].join('\n');
}
