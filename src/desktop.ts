/**
 * Desktop (Electron) bridge.
 *
 * The Electron shell injects `window.desktop` via its preload script. When it
 * is present the app is running as a packaged desktop build: the SQLite image
 * is stored in a real file (through IPC) and auto-update is available. On the
 * web / mobile builds this object is undefined and those paths use their own
 * storage + update mechanisms.
 */

export type UpdateStatus =
  | { state: 'checking' }
  | { state: 'available'; version: string }
  | { state: 'downloading'; percent: number }
  | { state: 'downloaded'; version: string }
  | { state: 'not-available'; version?: string }
  | { state: 'error'; message: string };

export interface DesktopBridge {
  /** Read the persisted database image, or null on first launch. */
  loadDb(): Promise<Uint8Array | null>;
  /** Persist the database image to disk. */
  saveDb(bytes: Uint8Array): Promise<void>;
  /** Delete the persisted database image. */
  resetDb(): Promise<void>;
  /** Ask the main process to check for updates now. */
  checkForUpdates(): Promise<{ ok: boolean; reason?: string }>;
  /** App version + platform, for the Settings card. */
  getAppInfo(): Promise<{ version: string; platform: string }>;
  /** Subscribe to update lifecycle events. Returns an unsubscribe function. */
  onUpdateStatus(cb: (status: UpdateStatus) => void): () => void;
}

export function getDesktopBridge(): DesktopBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.desktop;
}

declare global {
  interface Window {
    desktop?: DesktopBridge;
  }
}
