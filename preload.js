const { contextBridge, ipcRenderer } = require('electron');
const names = ['cfg', 'restore', 'status', 'signUp', 'signIn', 'google', 'complete', 'signOut', 'reset', 'saveProfile', 'addLibrary',
  'catalog', 'setToken', 'clearToken', 'pickFile', 'publish', 'removeGame', 'download'];
const api = { onProgress: cb => ipcRenderer.on('progress', (_e, d) => cb(d)) };
for (const n of names) api[n] = (...a) => ipcRenderer.invoke(n, ...a);
contextBridge.exposeInMainWorld('creations', api);
