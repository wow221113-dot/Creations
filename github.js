// All GitHub talking lives here (no Electron needed, so it can be tested on its own).
const http = require('http'), https = require('https'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const API = () => process.env.GH_API || 'https://api.github.com';
const UPL = () => process.env.GH_UPLOADS || 'https://uploads.github.com';
const RAW = () => process.env.GH_RAW || 'https://raw.githubusercontent.com';
const TAG = 'game-files', MAX_FILE = 2 * 1024 ** 3 - 1, MAX_COVER = 5 * 1024 ** 2;
const COVER_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

function request(method, url, { token, json, body, headers = {}, length, onData } = {}) {
  return new Promise((ok, no) => {
    const u = new URL(url), lib = u.protocol === 'http:' ? http : https;
    const h = { 'User-Agent': 'Creations-App', Accept: 'application/vnd.github+json', ...headers };
    if (token) h.Authorization = 'Bearer ' + token;
    let payload = null;
    if (json !== undefined) { payload = Buffer.from(JSON.stringify(json)); h['Content-Type'] = 'application/json'; h['Content-Length'] = payload.length; }
    else if (length !== undefined) h['Content-Length'] = length;
    const req = lib.request(u, { method, headers: h }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => { const t = Buffer.concat(chunks).toString('utf8'); let d = t; try { d = JSON.parse(t); } catch {} ok({ status: res.statusCode, data: d }); });
    });
    req.on('error', e => no(new Error('Could not reach GitHub. Check your internet connection.')));
    if (payload) req.end(payload);
    else if (body) { body.on('data', c => onData && onData(c.length)); body.on('error', no); body.pipe(req); }
    else req.end();
  });
}
const explain = (r, what) => {
  if (r.status === 401) return 'GitHub rejected the token. Make a new one and paste it again.';
  if (r.status === 403) return 'GitHub says this token is not allowed to do that (or a rate limit was hit). The token needs "Contents: Read and write" on your creations repository.';
  if (r.status === 404) return `GitHub could not find ${what}. Check the repository name and that the token can access it.`;
  if (r.status === 409) return 'The game list changed while you were publishing. Try again.';
  return `GitHub error ${r.status} while ${what}: ${typeof r.data === 'string' ? r.data.slice(0, 150) : (r.data && r.data.message) || ''}`;
};
const repoUrl = cfg => `${API()}/repos/${cfg.githubOwner}/${cfg.githubRepo}`;
const parse = x => { try { const j = typeof x === 'string' ? JSON.parse(x) : x; return { games: Array.isArray(j.games) ? j.games : [] }; } catch { return { games: [] }; } };

async function readCatalog(cfg, token) {
  if (token) {
    const r = await request('GET', `${repoUrl(cfg)}/contents/games.json?ref=${encodeURIComponent(cfg.branch)}`, { token });
    if (r.status === 404) return { games: [], sha: null };
    if (r.status !== 200) throw new Error(explain(r, 'the game list'));
    return { ...parse(Buffer.from(r.data.content, 'base64').toString('utf8')), sha: r.data.sha };
  }
  const r = await request('GET', `${RAW()}/${cfg.githubOwner}/${cfg.githubRepo}/${cfg.branch}/games.json?t=${Date.now()}`, { headers: { Accept: '*/*' } });
  if (r.status === 404) return { games: [], sha: null };
  if (r.status !== 200) throw new Error(`Could not load the store (GitHub error ${r.status}). Check your internet connection.`);
  return { ...parse(r.data), sha: null };
}
async function validateToken(cfg, token) {
  const r = await request('GET', repoUrl(cfg), { token });
  if (r.status !== 200) throw new Error(explain(r, `the repository ${cfg.githubOwner}/${cfg.githubRepo}`));
  if (!(r.data.permissions && r.data.permissions.push)) throw new Error(`This token can read but not change ${cfg.githubOwner}/${cfg.githubRepo}. Give it "Contents: Read and write".`);
  return true;
}
async function ensureRelease(cfg, token) {
  let r = await request('GET', `${repoUrl(cfg)}/releases/tags/${TAG}`, { token });
  if (r.status === 200) return r.data;
  if (r.status !== 404) throw new Error(explain(r, 'the game files release'));
  r = await request('POST', `${repoUrl(cfg)}/releases`, { token, json: { tag_name: TAG, target_commitish: cfg.branch, name: 'Game files (do not delete)', body: 'Game downloads used by the Creations app.', prerelease: true } });
  if (r.status !== 201) throw new Error(explain(r, 'creating the game files release'));
  return r.data;
}
async function uploadAsset(cfg, token, rel, filePath, name, type, label, progress) {
  const old = (rel.assets || []).find(a => a.name === name);
  if (old) await request('DELETE', `${repoUrl(cfg)}/releases/assets/${old.id}`, { token });
  const size = fs.statSync(filePath).size; let sent = 0;
  const r = await request('POST', `${UPL()}/repos/${cfg.githubOwner}/${cfg.githubRepo}/releases/${rel.id}/assets?name=${encodeURIComponent(name)}`,
    { token, body: fs.createReadStream(filePath), length: size, headers: { 'Content-Type': type }, onData: n => { sent += n; progress(`Uploading ${label}…`, Math.round(sent / size * 100)); } });
  if (r.status !== 201) throw new Error(explain(r, 'uploading ' + label));
  return r.data.browser_download_url;
}

async function publish(cfg, token, p, progress = () => {}) {
  const s = (v, n) => String(v || '').trim().slice(0, n), isUpdate = p.mode === 'update';
  const title = s(p.title, 80), description = s(p.description, 4000), version = s(p.version, 20) || '1.0.0', notes = s(p.notes, 1000);
  if (!title || !description) throw new Error('Title and description are required.');
  if (!/^[\w.+-]+$/.test(version)) throw new Error('Version can only use letters, numbers, dots and dashes (example: 1.0.1).');
  if (isUpdate && !notes) throw new Error('Describe what changed in this update.');
  if (!isUpdate && !p.filePath) throw new Error('Choose the game file to upload.');
  if (p.filePath && fs.statSync(p.filePath).size > MAX_FILE) throw new Error('GitHub only accepts files smaller than 2 GB.');
  let coverType = '';
  if (p.coverPath) {
    coverType = COVER_TYPES[path.extname(p.coverPath).toLowerCase()];
    if (!coverType) throw new Error('Cover must be a PNG, JPG, WEBP or GIF image.');
    if (fs.statSync(p.coverPath).size > MAX_COVER) throw new Error('Cover image must be under 5 MB.');
  }
  progress('Checking GitHub…', 0);
  const cat = await readCatalog(cfg, token);
  let g;
  if (isUpdate) { g = cat.games.find(x => x.id === p.id); if (!g) throw new Error('Game not found.'); }
  else { g = { id: (title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20) || 'game') + '-' + crypto.randomBytes(2).toString('hex'), publishedAt: Date.now(), history: [] }; }
  const rel = await ensureRelease(cfg, token), safe = n => n.replace(/[^A-Za-z0-9._-]+/g, '-');
  if (p.filePath) {
    const base = path.basename(p.filePath), name = `${g.id}-${version}-${safe(base)}`;
    g.fileUrl = await uploadAsset(cfg, token, rel, p.filePath, name, 'application/octet-stream', 'game file', progress);
    g.assets = [...(g.assets || []), name];
    g.fileName = base; g.fileSize = fs.statSync(p.filePath).size;
  }
  if (p.coverPath) {
    const name = `cover-${g.id}-${Date.now()}${path.extname(p.coverPath).toLowerCase()}`;
    g.coverUrl = await uploadAsset(cfg, token, rel, p.coverPath, name, coverType, 'cover', progress);
    g.assets = [...(g.assets || []), name];
  }
  Object.assign(g, { title, tagline: s(p.tagline, 140), genre: s(p.genre, 30), description,
    color: /^#[0-9a-f]{6}$/i.test(p.color) ? p.color : '#3b5bdb', ageRating: [0, 13, 17].includes(Number(p.ageRating)) ? Number(p.ageRating) : 0, version, updatedAt: Date.now() });
  g.history.unshift({ version, notes: isUpdate ? notes : 'Initial release', date: Date.now() });
  if (!isUpdate) cat.games.unshift(g);
  progress('Saving the game list…', 100);
  const r = await request('PUT', `${repoUrl(cfg)}/contents/games.json`, { token, json: {
    message: `${isUpdate ? 'Update' : 'Publish'} ${title} ${version}`, branch: cfg.branch,
    content: Buffer.from(JSON.stringify({ games: cat.games }, null, 2)).toString('base64'), ...(cat.sha ? { sha: cat.sha } : {}) } });
  if (r.status !== 200 && r.status !== 201) throw new Error(explain(r, 'saving the game list'));
  return g;
}

// Remove a game: first take it off the public list, then delete its files from GitHub.
async function removeGame(cfg, token, id, progress = () => {}) {
  progress('Checking GitHub…', 0);
  const cat = await readCatalog(cfg, token), g = cat.games.find(x => x.id === id);
  if (!g) throw new Error('Game not found (it may already be removed).');
  progress('Removing from the store…', 30);
  const r = await request('PUT', `${repoUrl(cfg)}/contents/games.json`, { token, json: {
    message: `Remove ${g.title}`, branch: cfg.branch, sha: cat.sha,
    content: Buffer.from(JSON.stringify({ games: cat.games.filter(x => x.id !== id) }, null, 2)).toString('base64') } });
  if (r.status !== 200 && r.status !== 201) throw new Error(explain(r, 'removing the game'));
  const names = new Set(g.assets || []);
  for (const u of [g.fileUrl, g.coverUrl]) if (u) { try { names.add(decodeURIComponent(String(u).split('/').pop())); } catch {} }
  let failed = 0;
  progress('Deleting files…', 60);
  const rel = await request('GET', `${repoUrl(cfg)}/releases/tags/${TAG}`, { token });
  if (rel.status === 200) for (const a of rel.data.assets || []) if (names.has(a.name)) {
    const d = await request('DELETE', `${repoUrl(cfg)}/releases/assets/${a.id}`, { token }); if (d.status !== 204) failed++;
  }
  return { title: g.title, failed };
}
module.exports = { readCatalog, validateToken, publish, removeGame };
