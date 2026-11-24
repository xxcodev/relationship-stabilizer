/**
 * @file Local session bundle for the pure-HTTP send path: cookies + one captured send template.
 *
 * The file contains login credentials (cookies) and a session ticket, so it is created with
 * 0600 permissions, lives under DATA_DIR (gitignored) and should be refreshed periodically by
 * running `node src/index.js api:export` (which briefly opens the logged-in browser).
 */
const fs = require('fs');
const path = require('path');
const env = require('./env');

const FILE = path.join(env.DATA_DIR, 'api-session.json');
const DEFAULT_MAX_AGE_HOURS = Number(process.env.API_SESSION_MAX_HOURS || 12);

function load(file = FILE) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

function save(session, file = FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(session, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch (e) {}
  return file;
}

function clear(file = FILE) {
  try {
    fs.rmSync(file, { force: true });
  } catch (e) {}
}

function ageHours(session) {
  const created = session && session.createdAt ? Date.parse(session.createdAt) : NaN;
  if (!Number.isFinite(created)) return null;
  return Math.round(((Date.now() - created) / 3600000) * 10) / 10;
}

/** @returns {{valid:boolean, reason?:string, ageHours:number|null}} */
function status(session, friend, { maxAgeHours = DEFAULT_MAX_AGE_HOURS } = {}) {
  if (!session) return { valid: false, reason: 'no session', ageHours: null };
  const age = ageHours(session);
  if (!session.template || !session.template.bodyB64) return { valid: false, reason: 'template missing', ageHours: age };
  if (!Array.isArray(session.cookies) || !session.cookies.length) return { valid: false, reason: 'cookies missing', ageHours: age };
  if (friend && session.friend && session.friend !== friend) {
    return { valid: false, reason: `session friend "${session.friend}" != "${friend}"`, ageHours: age };
  }
  if (age !== null && age > maxAgeHours) return { valid: false, reason: `session is ${age}h old (max ${maxAgeHours}h)`, ageHours: age };
  return { valid: true, ageHours: age };
}

module.exports = { FILE, load, save, clear, status, ageHours, DEFAULT_MAX_AGE_HOURS };
