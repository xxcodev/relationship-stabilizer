/**
 * @file Local session bundle for the pure-HTTP send path: cookies + one captured send template.
 *
 * Sessions are stored per account under DATA_DIR/api-sessions/ (the old single
 * DATA_DIR/api-session.json is migrated automatically). The file contains login credentials
 * (cookies) and a session ticket, so it is created with 0600 permissions under the gitignored
 * data directory and should be refreshed periodically by `node src/index.js api:export`.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const env = require('./env');

// legacy single-account file (still accepted as a fallback)
const FILE = path.join(env.DATA_DIR, 'api-session.json');
const SESSION_DIR = path.join(env.DATA_DIR, 'api-sessions');
const DEFAULT_MAX_AGE_HOURS = Number(process.env.API_SESSION_MAX_HOURS || 12);

const looksLikePath = (value) => typeof value === 'string' && (value.includes('/') || value.includes('\\') || value.endsWith('.json'));

function safeName(label) {
  const raw = String(label || 'account');
  const slug = raw.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'account';
  const hash = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 8);
  return `${slug}-${hash}.json`;
}

function pathFor(label) {
  return path.join(SESSION_DIR, safeName(label));
}

function resolveFile(target) {
  if (!target) return FILE;
  return looksLikePath(target) ? path.resolve(target) : pathFor(target);
}

function read(file) {
  try {
    const session = JSON.parse(fs.readFileSync(file, 'utf8'));
    session._file = file;
    return session;
  } catch (e) {
    return null;
  }
}

/** Load a session by account label (recommended) or explicit file path (legacy). */
function load(target) {
  const file = resolveFile(target);
  const session = read(file);
  if (session) return session;
  // migrate the old single session file for this account
  if (target && !looksLikePath(target)) {
    const legacy = read(FILE);
    if (legacy && (!legacy.account || legacy.account === String(target))) {
      delete legacy._file;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.copyFileSync(FILE, file);
        try { fs.chmodSync(file, 0o600); } catch (e) {}
        return { ...legacy, _file: file };
      } catch (e) {}
    }
  }
  return null;
}

function save(session, target) {
  const file = resolveFile(target || (session && session.account));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const data = { ...session };
  delete data._file;
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch (e) {}
  return file;
}

function clear(target) {
  try { fs.rmSync(resolveFile(target || FILE || (arguments[1] && arguments[1])), { force: true }); } catch (e) {}
}
function clearAccount(label) {
  try { fs.rmSync(pathFor(label), { force: true }); } catch (e) {}
}
function clearLegacy() {
  try { fs.rmSync(FILE, { force: true }); } catch (e) {}
}

function ageHours(session) {
  const created = session && session.createdAt ? Date.parse(session.createdAt) : NaN;
  if (!Number.isFinite(created)) return null;
  return Math.round(((Date.now() - created) / 3600000) * 10) / 10;
}

/** Whether the session can send to a friend: its default friend, or one captured at export. */
function canSendTo(session, friend) {
  if (!session) return false;
  if (!friend) return false;
  if (session.friend && friend === session.friend) return true;
  if (!session.createTemplate || !session.createTemplate.bodyB64) return false;
  return Array.isArray(session.friends) && session.friends.some((f) => f.name === friend);
}

/**
 * @returns {{valid:boolean, reason?:string, ageHours:number|null}}
 * Pass friend only to require that specific recipient; omit it for a general session check.
 */
function status(session, friend, { maxAgeHours = DEFAULT_MAX_AGE_HOURS } = {}) {
  if (!session) return { valid: false, reason: 'no session', ageHours: null };
  const age = ageHours(session);
  if (!session.template || !session.template.bodyB64) return { valid: false, reason: 'template missing', ageHours: age };
  if (!Array.isArray(session.cookies) || !session.cookies.length) return { valid: false, reason: 'cookies missing', ageHours: age };
  if (friend && !canSendTo(session, friend)) {
    return { valid: false, reason: `好友「${friend}」不在会话好友列表里`, ageHours: age };
  }
  if (age !== null && age > maxAgeHours) return { valid: false, reason: `session is ${age}h old (max ${maxAgeHours}h)`, ageHours: age };
  return { valid: true, ageHours: age };
}

module.exports = {
  FILE,
  SESSION_DIR,
  pathFor,
  load,
  save,
  clear,
  clearAccount,
  clearLegacy,
  status,
  canSendTo,
  ageHours,
  DEFAULT_MAX_AGE_HOURS,
};
