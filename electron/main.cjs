// Electron main process for the hypertroph+ desktop build.
//
// The app is the *same* web bundle the PWA and mobile builds use. Everything is
// served from a privileged custom scheme (app://) instead of file:// so that
// the renderer can `fetch()` the bundled reference pack and load the sql.js
// WASM (file:// URLs cannot be fetched). The SQLite image is persisted to a
// real file in the OS user-data directory through IPC, and electron-updater
// keeps already-installed copies current via GitHub Releases.
const { app, BrowserWindow, protocol, net, ipcMain, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');

const SCHEME = 'app';
const HOST = 'hypertroph';
const DIST = path.join(__dirname, '..', 'dist');
const INDEX = path.join(DIST, 'index.html');

protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  },
]);

let mainWindow = null;
let autoUpdater = null;

const dbPath = () => path.join(app.getPath('userData'), 'hypertroph.db');

function toBuffer(data) {
  if (data == null) return null;
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data);
}

// Serve the built bundle from disk. Relative asset URLs resolve here, so the
// renderer's fetch('./hypertroph-ref.sqlite.gz') and WASM loads just work.
function registerAppProtocol() {
  protocol.handle(SCHEME, async (request) => {
    try {
      const { pathname } = new URL(request.url);
      let rel = decodeURIComponent(pathname).replace(/^\/+/, '');
      if (rel === '') rel = 'index.html';
      let filePath = path.join(DIST, rel);
      if (filePath !== DIST && !filePath.startsWith(DIST + path.sep)) {
        return new Response('Forbidden', { status: 403 });
      }
      let stat = null;
      try {
        stat = await fs.stat(filePath);
      } catch {
        /* missing */
      }
      if (stat && stat.isDirectory()) filePath = path.join(filePath, 'index.html');
      const res = await net.fetch(pathToFileURL(filePath).toString());
      // SPA fallback: unknown navigation paths return the shell.
      if (res.status === 404 && (request.headers.get('accept') || '').includes('text/html')) {
        return net.fetch(pathToFileURL(INDEX).toString());
      }
      return res;
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 380,
    minHeight: 560,
    backgroundColor: '#fffdec',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  return mainWindow.loadURL(`${SCHEME}://${HOST}/index.html`);
}

function sendUpdateStatus(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-status', payload);
}

// electron-updater exposes release notes as a markdown string, or as an array of
// { version, note } entries for a ranged update. Flatten either into plain text.
function normalizeNotes(releaseNotes) {
  if (!releaseNotes) return '';
  if (typeof releaseNotes === 'string') return releaseNotes;
  if (Array.isArray(releaseNotes)) {
    return releaseNotes
      .map((n) => (n && typeof n === 'object' ? n.note : String(n ?? '')))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

// Auto-update: download in the background, install on quit. `publish` in
// electron-builder.yml points at this repo's GitHub Releases, which is where
// the app looks for new versions after install.
function setupAutoUpdater() {
  if (!app.isPackaged) return;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (e) {
    console.warn('electron-updater unavailable; updates disabled.', e);
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => sendUpdateStatus({ state: 'checking' }));
  autoUpdater.on('update-available', (info) =>
    sendUpdateStatus({
      state: 'available',
      version: info?.version ?? '',
      notes: normalizeNotes(info?.releaseNotes),
    }),
  );
  autoUpdater.on('update-not-available', (info) => sendUpdateStatus({ state: 'not-available', version: info?.version }));
  autoUpdater.on('download-progress', (p) => sendUpdateStatus({ state: 'downloading', percent: Math.round(p?.percent ?? 0) }));
  autoUpdater.on('update-downloaded', (info) =>
    sendUpdateStatus({
      state: 'downloaded',
      version: info?.version ?? '',
      notes: normalizeNotes(info?.releaseNotes),
    }),
  );
  autoUpdater.on('error', (err) => sendUpdateStatus({ state: 'error', message: String(err?.message || err) }));
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {
      /* offline or no release yet */
    });
  }, 4000);
}

ipcMain.handle('db:load', async () => {
  try {
    const buf = await fs.readFile(dbPath());
    return new Uint8Array(buf);
  } catch {
    return null;
  }
});

ipcMain.handle('db:save', async (_event, data) => {
  const buf = toBuffer(data);
  if (!buf) return;
  const target = dbPath();
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, buf);
  await fs.rename(tmp, target); // atomic replace
});

ipcMain.handle('db:reset', async () => {
  try {
    await fs.unlink(dbPath());
  } catch {
    /* already absent */
  }
});

ipcMain.handle('app:info', () => ({ version: app.getVersion(), platform: process.platform }));

// Native backup dialogs. The renderer sends the raw image over IPC; the main
// process owns the OS dialogs and the actual disk write (no native modules).
function parentWindow() {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
}

ipcMain.handle('backup:save', async (_event, data, defaultName) => {
  const buf = toBuffer(data);
  if (!buf) return { ok: false, error: 'No data to save.' };
  const suggested = typeof defaultName === 'string' && defaultName ? defaultName : 'nutrition-backup.sqlite';
  try {
    const options = {
      title: 'Save backup',
      defaultPath: suggested,
      filters: [
        { name: 'SQLite database', extensions: ['sqlite'] },
        { name: 'All files', extensions: ['*'] },
      ],
    };
    const win = parentWindow();
    const res = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    await fs.writeFile(res.filePath, buf);
    return { ok: true, path: res.filePath };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
});

ipcMain.handle('backup:open', async () => {
  try {
    const options = {
      title: 'Open backup',
      properties: ['openFile'],
      filters: [
        { name: 'Backups', extensions: ['sqlite', 'db', 'sql'] },
        { name: 'SQLite database', extensions: ['sqlite', 'db'] },
        { name: 'SQL script', extensions: ['sql'] },
        { name: 'All files', extensions: ['*'] },
      ],
    };
    const win = parentWindow();
    const res = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (res.canceled || !res.filePaths?.length) return { ok: false, canceled: true };
    const filePath = res.filePaths[0];
    const buf = await fs.readFile(filePath);
    return { ok: true, name: path.basename(filePath), data: new Uint8Array(buf) };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
});

ipcMain.handle('updates:check', async () => {
  if (!app.isPackaged) return { ok: false, reason: 'Updates are disabled in development builds.' };
  if (!autoUpdater) return { ok: false, reason: 'Updater is unavailable.' };
  try {
    await autoUpdater.checkForUpdates();
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  }
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    registerAppProtocol();
    void createWindow();
    setupAutoUpdater();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
