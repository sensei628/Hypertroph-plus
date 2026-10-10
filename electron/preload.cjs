// Preload: exposes the minimal, typed surface the renderer needs. Runs in an
// isolated world with context isolation on and node integration off.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  loadDb: () => ipcRenderer.invoke('db:load'),
  saveDb: (bytes) => ipcRenderer.invoke('db:save', bytes),
  resetDb: () => ipcRenderer.invoke('db:reset'),
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  onUpdateStatus: (cb) => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on('update-status', listener);
    return () => ipcRenderer.removeListener('update-status', listener);
  },
});
