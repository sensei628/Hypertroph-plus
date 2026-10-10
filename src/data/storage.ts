import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';

/**
 * Where the SQLite image lives.
 *
 * The tracking logic and SQLite schema are unchanged from the web build; only
 * the byte store differs by platform:
 *   • web    -> localStorage (base64 image, the original behavior)
 *   • native -> a real file in the app's private data directory (Capacitor
 *               Filesystem), so the database survives restarts, is not capped
 *               by the WebView localStorage quota, and can be backed up.
 *
 * `save()` keeps the original synchronous signature so the repository never
 * had to change. On native the (potentially large) write is debounced and
 * coalesced; call `flush()` before the app is backgrounded or closed.
 */

const WEB_KEY = 'hypertroph.db.v1';
export const NATIVE_DB_FILE = 'hypertroph.db';

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export interface DbStorage {
  readonly kind: 'web' | 'native';
  /** Current persisted image, or null if none exists yet. */
  load(): Promise<Uint8Array | null>;
  /** Queue a write. Sync signature preserved for the repository. */
  save(bytes: Uint8Array): void;
  /** Remove the persisted image. */
  reset(): Promise<void>;
  /** Wait for any queued/in-flight native write to finish. */
  flush(): Promise<void>;
}

class WebDbStorage implements DbStorage {
  readonly kind = 'web' as const;

  async load(): Promise<Uint8Array | null> {
    try {
      if (typeof localStorage === 'undefined') return null;
      const stored = localStorage.getItem(WEB_KEY);
      return stored ? base64ToBytes(stored) : null;
    } catch {
      return null;
    }
  }

  save(bytes: Uint8Array): void {
    try {
      localStorage.setItem(WEB_KEY, bytesToBase64(bytes));
    } catch {
      /* quota or unavailable storage - non-fatal for the base model */
    }
  }

  async reset(): Promise<void> {
    try {
      localStorage.removeItem(WEB_KEY);
    } catch {
      /* ignore */
    }
  }

  async flush(): Promise<void> {
    /* writes are synchronous */
  }
}

class NativeDbStorage implements DbStorage {
  readonly kind = 'native' as const;
  private pending: Uint8Array | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> | null = null;

  async load(): Promise<Uint8Array | null> {
    try {
      const res = await Filesystem.readFile({ path: NATIVE_DB_FILE, directory: Directory.Data });
      const data = res.data;
      const b64 = typeof data === 'string' ? data : await data.text();
      return b64 ? base64ToBytes(b64) : null;
    } catch {
      // First launch: no file yet.
      return null;
    }
  }

  save(bytes: Uint8Array): void {
    this.pending = bytes;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, 200);
  }

  private async drain(): Promise<void> {
    if (this.writing || !this.pending) return;
    const bytes = this.pending;
    this.pending = null;
    this.writing = this.writeNow(bytes).finally(() => {
      this.writing = null;
    });
    await this.writing;
    if (this.pending) await this.drain();
  }

  private async writeNow(bytes: Uint8Array): Promise<void> {
    try {
      await Filesystem.writeFile({
        path: NATIVE_DB_FILE,
        data: bytesToBase64(bytes),
        directory: Directory.Data,
        recursive: true,
      });
    } catch (e) {
      console.error('Failed to persist database to device storage', e);
    }
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.writing) await this.writing;
    if (this.pending) await this.drain();
  }

  async reset(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = null;
    try {
      await Filesystem.deleteFile({ path: NATIVE_DB_FILE, directory: Directory.Data });
    } catch {
      /* already absent */
    }
  }
}

function detectNative(): boolean {
  try {
    return typeof window !== 'undefined' && Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

export const storage: DbStorage = detectNative() ? new NativeDbStorage() : new WebDbStorage();
