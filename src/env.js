/**
 * @file Environment and path resolution: reads .env, exposes DATA_DIR / DB_FILE / dashboard / browser settings.
 */
// Environment + path resolution. No external deps: reads .env if present.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function loadDotEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const key = m[1];
    let val = m[2].replace(/^["']|["']$/g, '');
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadDotEnv();

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const bool = (v, d) => (v === undefined ? d : /^(1|true|yes|on)$/i.test(String(v)));

const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || 'data');

module.exports = {
  ROOT,
  DATA_DIR,
  DB_FILE: path.resolve(ROOT, process.env.DB_FILE || path.join(DATA_DIR, 'app.db')),

  dashboard: {
    host: process.env.DASH_HOST || '127.0.0.1',
    port: num(process.env.DASH_PORT, 9400),
  },

  browser: {
    // 'chrome' = the installed Google Chrome, 'chromium' = Playwright's bundled build
    channel: process.env.BROWSER_CHANNEL || 'chrome',
    executablePath: process.env.BROWSER_EXECUTABLE || null,
    headless: bool(process.env.BROWSER_HEADLESS, false),
    locale: process.env.BROWSER_LOCALE || 'zh-CN',
    viewportWidth: num(process.env.BROWSER_WIDTH, 1280),
    viewportHeight: num(process.env.BROWSER_HEIGHT, 900),
    windowPosition: process.env.BROWSER_POS || '80,80',
  },

  // daemon control is platform specific; core code only shells out when configured
  platform: process.platform,
};
