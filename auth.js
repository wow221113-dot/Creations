// Accounts: Firebase Auth (email + Google) and Firestore (profiles). Plain REST, no extra packages.
const http = require('http'), https = require('https'), crypto = require('crypto');
const IDT = () => process.env.FB_IDT || 'https://identitytoolkit.googleapis.com/v1';
const STS = () => process.env.FB_STS || 'https://securetoken.googleapis.com/v1';
const FSB = () => process.env.FB_FS || 'https://firestore.googleapis.com/v1';
const GTOKEN = () => process.env.G_TOKEN || 'https://oauth2.googleapis.com/token';
const GAUTH = 'https://accounts.google.com/o/oauth2/v2/auth';

function req(method, url, { json, form, token } = {}) {
  return new Promise((ok, no) => {
    const u = new URL(url), lib = u.protocol === 'http:' ? http : https, h = { 'User-Agent': 'Creations-App' };
    let body = null;
    if (json !== undefined) { body = Buffer.from(JSON.stringify(json)); h['Content-Type'] = 'application/json'; }
    if (form) { body = Buffer.from(new URLSearchParams(form).toString()); h['Content-Type'] = 'application/x-www-form-urlencoded'; }
    if (body) h['Content-Length'] = body.length;
    if (token) h.Authorization = 'Bearer ' + token;
    const r = lib.request(u, { method, headers: h }, res => {
      const c = []; res.on('data', x => c.push(x));
      res.on('end', () => { const t = Buffer.concat(c).toString('utf8'); let d = t; try { d = JSON.parse(t); } catch {} ok({ status: res.statusCode, data: d }); });
    });
    r.on('error', () => no(new Error('Could not connect. Check your internet connection.')));
    r.end(body);
  });
}
const FRIENDLY = {
  EMAIL_EXISTS: 'That email already has an account. Try logging in.', INVALID_LOGIN_CREDENTIALS: 'Wrong email or password.',
  INVALID_PASSWORD: 'Wrong email or password.', EMAIL_NOT_FOUND: 'Wrong email or password.', INVALID_EMAIL: 'Enter a valid email address.',
  WEAK_PASSWORD: 'Password must be at least 6 characters.', MISSING_PASSWORD: 'Enter a password.',
  TOO_MANY_ATTEMPTS_TRY_LATER: 'Too many tries. Wait a few minutes and try again.', USER_DISABLED: 'This account has been disabled.',
  OPERATION_NOT_ALLOWED: 'This sign-in method is turned off in Firebase. Enable it in Authentication > Sign-in method.',
  CREDENTIAL_TOO_OLD_LOGIN_AGAIN: 'Please log in again.', TOKEN_EXPIRED: 'Your session expired. Please log in again.'
};
const fbErr = r => { const code = String((r.data && r.data.error && r.data.error.message) || '').split(' ')[0];
  return new Error(FRIENDLY[code] || (code ? `Sign-in failed (${code}).` : `Sign-in failed (HTTP ${r.status}).`)); };
const keyQ = cfg => 'key=' + encodeURIComponent(cfg.firebaseApiKey);
const mkSession = d => ({ idToken: d.idToken || d.id_token, refreshToken: d.refreshToken || d.refresh_token, uid: d.localId || d.user_id,
  email: (d.email || '').toLowerCase(), exp: Date.now() + (Number(d.expiresIn || d.expires_in) || 3600) * 1000 - 60000, isNew: !!d.isNewUser });
async function fb(cfg, op, body) {
  const r = await req('POST', `${IDT()}/accounts:${op}?${keyQ(cfg)}`, { json: body });
  if (r.status !== 200) throw fbErr(r); return r.data;
}
const signUp = async (cfg, email, password) => mkSession(await fb(cfg, 'signUp', { email, password, returnSecureToken: true }));
const signIn = async (cfg, email, password) => mkSession(await fb(cfg, 'signInWithPassword', { email, password, returnSecureToken: true }));
const signInGoogle = async (cfg, idt) => mkSession(await fb(cfg, 'signInWithIdp', { postBody: `id_token=${encodeURIComponent(idt)}&providerId=google.com`, requestUri: 'http://localhost', returnIdpCredential: true, returnSecureToken: true }));
const resetPassword = (cfg, email) => fb(cfg, 'sendOobCode', { requestType: 'PASSWORD_RESET', email });
const deleteAccount = (cfg, idToken) => fb(cfg, 'delete', { idToken });
async function refresh(cfg, refreshToken) {
  const r = await req('POST', `${STS()}/token?${keyQ(cfg)}`, { form: { grant_type: 'refresh_token', refresh_token: refreshToken } });
  if (r.status !== 200) throw new Error('Your session expired. Please log in again.');
  return mkSession(r.data);
}

// Google "installed app" sign-in: system browser + local callback + PKCE.
async function googleSignIn(cfg, openUrl, timeoutMs = 180000) {
  if (!cfg.googleClientId) throw new Error('Google sign-in is not set up yet.');
  const verifier = crypto.randomBytes(32).toString('base64url'), state = crypto.randomBytes(16).toString('hex');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  let redirect = '';
  const code = await new Promise((ok, no) => {
    let timer;
    const srv = http.createServer((rq, rs) => {
      const u = new URL(rq.url, 'http://127.0.0.1');
      if (u.pathname !== '/callback') { rs.writeHead(404); return rs.end(); }
      const page = t => { rs.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); rs.end(`<body style="font:20px sans-serif;text-align:center;margin-top:20vh">${t}</body>`); clearTimeout(timer); srv.close(); };
      const c = u.searchParams.get('code');
      if (u.searchParams.get('state') !== state) { page('Sign-in failed. Close this tab and try again.'); return no(new Error('Google sign-in was interrupted. Try again.')); }
      if (!c) { page('Sign-in cancelled. You can close this tab.'); return no(new Error('Google sign-in was cancelled.')); }
      page('You are signed in. You can close this tab and go back to Creations.'); ok(c);
    });
    timer = setTimeout(() => { srv.close(); no(new Error('Google sign-in timed out. Try again.')); }, timeoutMs);
    srv.listen(0, '127.0.0.1', () => {
      redirect = `http://127.0.0.1:${srv.address().port}/callback`;
      openUrl(`${GAUTH}?` + new URLSearchParams({ client_id: cfg.googleClientId, redirect_uri: redirect, response_type: 'code', scope: 'openid email profile',
        code_challenge: challenge, code_challenge_method: 'S256', state, prompt: 'select_account' }));
    });
  });
  const r = await req('POST', GTOKEN(), { form: { code, client_id: cfg.googleClientId, client_secret: cfg.googleClientSecret || '', code_verifier: verifier, redirect_uri: redirect, grant_type: 'authorization_code' } });
  if (r.status !== 200 || !r.data.id_token) throw new Error('Google did not accept the sign-in. Check the Google client ID and secret in config.json.');
  return signInGoogle(cfg, r.data.id_token);
}

// Firestore documents (profiles/{uid} is public to signed-in users, private/{uid} only to its owner).
const docUrl = (cfg, col, uid) => `${FSB()}/projects/${cfg.firebaseProjectId}/databases/(default)/documents/${col}/${uid}`;
const toFs = o => ({ fields: Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? { integerValue: String(v) } : { stringValue: String(v) }])) });
const fromFs = d => Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, v.stringValue !== undefined ? v.stringValue : Number(v.integerValue || v.doubleValue || 0)]));
const fsErr = r => new Error(r.status === 403 ? 'The database refused this. Paste the rules from firestore.rules into Firebase > Firestore > Rules.' : `Database error (HTTP ${r.status}). Is Firestore created in your Firebase project?`);
async function getDoc(cfg, s, col) {
  const r = await req('GET', docUrl(cfg, col, s.uid), { token: s.idToken });
  if (r.status === 404) return null; if (r.status !== 200) throw fsErr(r); return fromFs(r.data);
}
async function setDoc(cfg, s, col, obj) {
  const mask = Object.keys(obj).map(k => 'updateMask.fieldPaths=' + encodeURIComponent(k)).join('&');
  const r = await req('PATCH', `${docUrl(cfg, col, s.uid)}?${mask}`, { json: toFs(obj), token: s.idToken });
  if (r.status !== 200) throw fsErr(r);
}

function ageOf(b) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(b || ''); if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]); if (isNaN(d) || d.getMonth() !== +m[2] - 1 || d.getDate() !== +m[3]) return null;
  const n = new Date(); let a = n.getFullYear() - d.getFullYear();
  if (n.getMonth() < d.getMonth() || (n.getMonth() === d.getMonth() && n.getDate() < d.getDate())) a--;
  return a < 0 ? null : a;
}
function checkBirthday(b) {
  const a = ageOf(b);
  if (a === null || a > 120) throw new Error('Enter a valid birthday.');
  if (a < 13) throw new Error('You must be at least 13 years old to use Creations.');
  return a;
}
module.exports = { signUp, signIn, signInGoogle, googleSignIn, resetPassword, deleteAccount, refresh, getDoc, setDoc, ageOf, checkBirthday };
