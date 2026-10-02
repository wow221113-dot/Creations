const { app, BrowserWindow, Menu, shell, dialog, ipcMain, safeStorage } = require('electron');
const fs = require('fs'), path = require('path');
const gh = require('./github.js');
if (!app.requestSingleInstanceLock()) app.quit();

const cfg = { branch: 'main', ...JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')) };
const tokenFile = () => path.join(app.getPath('userData'), 'owner-token.bin');
let win;
function getToken() {
  try {
    const raw = fs.readFileSync(tokenFile());
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString('utf8');
  } catch { return ''; }
}
const handle = (name, fn) => ipcMain.handle(name, async (_e, ...a) => {
  try { return { ok: true, data: await fn(...a) }; } catch (e) { return { ok: false, error: e.message || String(e) }; }
});
const configured = () => cfg.githubOwner && !cfg.githubOwner.startsWith('YOUR');
const prefix = () => `https://github.com/${cfg.githubOwner}/${cfg.githubRepo}/releases/download/`;

handle('cfg', () => ({ owner: cfg.githubOwner, repo: cfg.githubRepo, version: app.getVersion(), hasToken: !!getToken(), configured: configured() }));
handle('catalog', async () => { if (!configured()) throw new Error('This copy of the app is not connected to a GitHub repository yet.'); return gh.readCatalog(cfg, getToken()); });
handle('setToken', async t => {
  t = String(t || '').trim(); if (!t) throw new Error('Paste your token first.');
  await gh.validateToken(cfg, t);
  fs.writeFileSync(tokenFile(), safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(t) : Buffer.from(t));
  return true;
});
handle('clearToken', () => { fs.rmSync(tokenFile(), { force: true }); return true; });
handle('pickFile', async kind => {
  const r = await dialog.showOpenDialog(win, kind === 'cover'
    ? { properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }] }
    : { properties: ['openFile'] });
  if (r.canceled || !r.filePaths[0]) return null;
  const f = r.filePaths[0]; return { path: f, name: path.basename(f), size: fs.statSync(f).size };
});
handle('publish', async p => {
  const t = getToken(); if (!t) throw new Error('Owner mode is not set up on this computer.');
  return gh.publish(cfg, t, p, (text, pct) => win.webContents.send('progress', { text, pct }));
});
handle('download', (url, name) => {
  if (!String(url).startsWith(prefix())) throw new Error('That download link is not from this store.');
  win.webContents.downloadURL(url); return true;
});

function setupAutoUpdate() {
  if (!app.isPackaged) return;
  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-downloaded', info => dialog.showMessageBox(win, {
    type: 'info', buttons: ['Restart now', 'Later'], defaultId: 0, title: 'Update ready',
    message: `Creations ${info.version} is ready to install.`, detail: 'Restart the app to finish updating.'
  }).then(r => { if (r.response === 0) autoUpdater.quitAndInstall(); }));
  autoUpdater.on('error', () => {});
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check(); setInterval(check, 4 * 3600 * 1000);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 480, minHeight: 560, title: 'Creations', backgroundColor: '#0f1117',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  Menu.setApplicationMenu(null);
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.session.on('will-download', (_e, item) => {
    item.once('done', (_ev, state) => { if (state === 'completed') dialog.showMessageBox(win, { type: 'info', message: 'Download finished', detail: item.getSavePath() }); });
  });
  win.loadFile(path.join(__dirname, 'public', 'index.html'));
  setupAutoUpdate();
}
app.whenReady().then(() => { createWindow(); app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); }); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
