const { app, BrowserWindow, Menu, shell, dialog, ipcMain, safeStorage } = require('electron');
const fs = require('fs'), path = require('path');
const gh = require('./github.js'), auth = require('./auth.js');
if (!app.requestSingleInstanceLock()) app.quit();

const cfg = { branch: 'main', ...JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')) };
const U = f => path.join(app.getPath('userData'), f);
const enc = t => safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(t) : Buffer.from(t);
const dec = b => safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(b) : b.toString('utf8');
const readSecret = f => { try { return dec(fs.readFileSync(U(f))); } catch { return ''; } };
const ownerEmail = () => String(cfg.ownerEmail || '').trim().toLowerCase();
const authReady = () => !!(cfg.firebaseApiKey && cfg.firebaseProjectId);
const ghReady = () => cfg.githubOwner && !cfg.githubOwner.startsWith('YOUR');
const prefix = () => `https://github.com/${cfg.githubOwner}/${cfg.githubRepo}/releases/download/`;
let win, S = null;                                   // S = current signed-in session

const handle = (name, fn) => ipcMain.handle(name, async (_e, ...a) => {
  try { return { ok: true, data: await fn(...a) }; } catch (e) { return { ok: false, error: e.message || String(e) }; }
});
const isOwner = () => !!S && !!ownerEmail() && S.email === ownerEmail();
const needOwner = () => { if (!isOwner()) throw new Error('Only the Creations owner can do that.'); };
async function live() {                              // valid session, refreshing the token when needed
  if (!S) throw new Error('Please log in.');
  if (Date.now() > S.exp) S = { ...S, ...(await auth.refresh(cfg, S.refreshToken)), email: S.email };
  fs.writeFileSync(U('session.bin'), enc(JSON.stringify({ refreshToken: S.refreshToken, email: S.email })));
  return S;
}
const start = async s => { S = s; await live(); return status(); };
async function status() {
  if (!S) return { signedIn: false };
  const s = await live(), profile = await auth.getDoc(cfg, s, 'profiles'), priv = await auth.getDoc(cfg, s, 'private');
  let library = {}; try { library = JSON.parse((priv && priv.library) || '{}'); } catch {}
  return { signedIn: true, uid: s.uid, email: s.email, profile, age: auth.ageOf(priv && priv.birthday), library,
    needsProfile: !profile || !priv || !priv.birthday, isOwner: isOwner(), hasToken: isOwner() && !!readSecret('owner-token.bin') };
}
const clean = (v, n) => String(v || '').trim().slice(0, n);
const profileFields = p => ({ name: clean(p.name, 40), bio: clean(p.bio, 200), avatar: clean(p.avatar, 8) || '🎮', color: /^#[0-9a-f]{6}$/i.test(p.color) ? p.color : '#7c5cff' });

handle('cfg', () => ({ version: app.getVersion(), authReady: authReady(), googleReady: !!cfg.googleClientId, githubReady: ghReady(), repo: `${cfg.githubOwner}/${cfg.githubRepo}`, ownerEmail: ownerEmail() }));
handle('restore', async () => {
  try { const j = JSON.parse(readSecret('session.bin')); if (j.refreshToken) return await start({ refreshToken: j.refreshToken, email: j.email, exp: 0, uid: '' }); } catch {}
  S = null; return { signedIn: false };
});
handle('status', status);
handle('signUp', async ({ email, password, name, birthday }) => {
  if (!authReady()) throw new Error('Accounts are not set up yet (see GUIDE.txt).');
  auth.checkBirthday(birthday); if (!clean(name, 40)) throw new Error('Enter a display name.');
  const s = await auth.signUp(cfg, String(email).trim(), String(password)); S = s;
  await auth.setDoc(cfg, s, 'profiles', { ...profileFields({ name }), created: Date.now() });
  await auth.setDoc(cfg, s, 'private', { birthday, library: '{}' });
  return start(s);
});
handle('signIn', async ({ email, password }) => { if (!authReady()) throw new Error('Accounts are not set up yet (see GUIDE.txt).'); return start(await auth.signIn(cfg, String(email).trim(), String(password))); });
handle('google', async () => start(await auth.googleSignIn(cfg, url => shell.openExternal(url))));
handle('complete', async ({ name, birthday }) => {      // first Google sign-in: name + birthday
  const s = await live();
  try { auth.checkBirthday(birthday); } catch (e) { if (/13/.test(e.message)) { await auth.deleteAccount(cfg, s.idToken).catch(() => {}); S = null; fs.rmSync(U('session.bin'), { force: true }); } throw e; }
  if (!clean(name, 40)) throw new Error('Enter a display name.');
  await auth.setDoc(cfg, s, 'profiles', { ...profileFields({ name }), created: Date.now() });
  await auth.setDoc(cfg, s, 'private', { birthday, library: '{}' });
  return status();
});
handle('signOut', () => { S = null; fs.rmSync(U('session.bin'), { force: true }); return true; });
handle('reset', email => auth.resetPassword(cfg, String(email).trim()).then(() => true));
handle('saveProfile', async p => { const s = await live(), f = profileFields(p); if (!f.name) throw new Error('Enter a display name.'); await auth.setDoc(cfg, s, 'profiles', f); return status(); });
handle('addLibrary', async ({ id, version }) => {
  const s = await live(), priv = await auth.getDoc(cfg, s, 'private'); let lib = {}; try { lib = JSON.parse((priv && priv.library) || '{}'); } catch {}
  lib[String(id)] = { version: String(version) }; await auth.setDoc(cfg, s, 'private', { library: JSON.stringify(lib) }); return lib;
});

handle('catalog', async () => { if (!ghReady()) throw new Error('This copy of the app is not connected to a GitHub repository yet.'); return gh.readCatalog(cfg, ''); });
handle('setToken', async t => {
  needOwner(); t = String(t || '').trim(); if (!t) throw new Error('Paste your token first.');
  await gh.validateToken(cfg, t); fs.writeFileSync(U('owner-token.bin'), enc(t)); return true;
});
handle('clearToken', () => { fs.rmSync(U('owner-token.bin'), { force: true }); return true; });
handle('pickFile', async kind => {
  needOwner();
  const r = await dialog.showOpenDialog(win, kind === 'cover'
    ? { properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }] } : { properties: ['openFile'] });
  if (r.canceled || !r.filePaths[0]) return null;
  const f = r.filePaths[0]; return { path: f, name: path.basename(f), size: fs.statSync(f).size };
});
handle('publish', async p => {
  needOwner(); const t = readSecret('owner-token.bin'); if (!t) throw new Error('Turn on publishing first (Owner page).');
  return gh.publish(cfg, t, p, (text, pct) => win.webContents.send('progress', { text, pct }));
});
handle('removeGame', async id => {
  needOwner(); const t = readSecret('owner-token.bin'); if (!t) throw new Error('Turn on publishing first (Publish page).');
  return gh.removeGame(cfg, t, String(id), (text, pct) => win.webContents.send('progress', { text, pct }));
});
handle('download', url => {
  if (!S) throw new Error('Please log in to download.');
  if (!String(url).startsWith(prefix())) throw new Error('That download link is not from this store.');
  win.webContents.downloadURL(url); return true;
});

function setupAutoUpdate() {
  if (!app.isPackaged) return;
  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-downloaded', info => dialog.showMessageBox(win, { type: 'info', buttons: ['Restart now', 'Later'], defaultId: 0,
    title: 'Update ready', message: `Creations ${info.version} is ready to install.`, detail: 'Restart the app to finish updating.' })
    .then(r => { if (r.response === 0) autoUpdater.quitAndInstall(); }));
  autoUpdater.on('error', () => {});
  const check = () => autoUpdater.checkForUpdates().catch(() => {}); check(); setInterval(check, 4 * 3600 * 1000);
}
function createWindow() {
  win = new BrowserWindow({ width: 1320, height: 840, minWidth: 560, minHeight: 600, title: 'Creations', backgroundColor: '#0b0d14',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  Menu.setApplicationMenu(null);
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.session.on('will-download', (_e, item) => item.once('done', (_v, st) => { if (st === 'completed') dialog.showMessageBox(win, { type: 'info', message: 'Download finished', detail: item.getSavePath() }); }));
  win.loadFile(path.join(__dirname, 'public', 'index.html'));
  setupAutoUpdate();
}
app.whenReady().then(() => { createWindow(); app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); }); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
