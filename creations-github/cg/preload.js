const { contextBridge, ipcRenderer } = require('electron');
const call = n => (...a) => ipcRenderer.invoke(n, ...a);
contextBridge.exposeInMainWorld('creations', {
  cfg: call('cfg'), catalog: call('catalog'), setToken: call('setToken'), clearToken: call('clearToken'),
  pickFile: call('pickFile'), publish: call('publish'), download: call('download'),
  onProgress: cb => ipcRenderer.on('progress', (_e, d) => cb(d))
});
