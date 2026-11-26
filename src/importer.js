/**
 * @file One-off importer that moves the legacy JSON/JSONL state into SQLite (idempotent).
 */
// One-off importer: brings the legacy JSON/JSONL files of browser-test/ into SQLite.
const fs = require('fs');
const path = require('path');
const repos = require('./repos');
const { POOLS } = require('./pools');

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function readJsonl(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean);
  } catch (e) {
    return [];
  }
}

function importLegacy(legacyDir, { force = false } = {}) {
  const dir = path.resolve(legacyDir);
  if (!fs.existsSync(dir)) throw new Error(`legacy dir not found: ${dir}`);

  const cfg = readJson(path.join(dir, 'config.json'), {});
  const accountsCfg = readJson(path.join(dir, 'accounts.json'), { accounts: {} });
  const state = readJson(path.join(dir, 'scheduler-state.json'), { days: {} });
  const log = readJsonl(path.join(dir, 'send-log.jsonl'));

  const b = (accountsCfg.accounts && accountsCfg.accounts.B) || {};
  // `enabled` is operational state (pause switch), not importable config:
  // keep whatever the account already has, only seed it on first creation
  const existing = repos.getAccount('B');
  const account = repos.upsertAccount({
    label: 'B',
    profileDir: path.join(dir, b.profile || 'profile-B'),
    port: b.port || 9334,
    friend: cfg.friend || b.friend || '',
    enabled: existing ? !!existing.enabled : cfg.enabled !== false,
  });

  // snapshot the plan that is being executed right now, then wipe derived rows
  const todayKey = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  const runningPlan = repos.getPlan(account.id, todayKey);
  const conn = require('./db').open();
  conn.prepare('DELETE FROM plans WHERE account_id = ?').run(account.id);
  conn.prepare('DELETE FROM sends WHERE account_id = ?').run(account.id);
  // drop placeholder accounts that were auto-created by `init`
  conn
    .prepare(
      `DELETE FROM accounts WHERE id != ?
         AND id NOT IN (SELECT account_id FROM plans)
         AND id NOT IN (SELECT account_id FROM sends)`
    )
    .run(account.id);

  repos.setSetting('minGapMinutes', cfg.minGapMinutes || 5);
  repos.setSetting('totalMin', cfg.totalMin || 0);
  repos.setSetting('totalMax', cfg.totalMax || 0);
  repos.setSetting('banWords', cfg.banWords || []);

  // pools: keep the seed catalogue, apply enabled flags from the legacy config
  repos.seedPools(POOLS.map((p) => ({ ...p, enabled: !(cfg.pools && cfg.pools[p.name] === false) })));
  for (const [name, on] of Object.entries(cfg.pools || {})) repos.setPoolEnabled(name, on !== false);

  // bands
  const bands = (cfg.bands || []).map((b2) => ({
    name: b2.name,
    startMin: toMin(b2.from),
    endMin: toMin(b2.to),
    minCount: b2.min,
    maxCount: b2.max,
  }));
  if (bands.length) repos.replaceBands(account.id, bands);
  // make the imported settings account-specific (the legacy config was global)
  repos.seedAccountDefaults(account.id, { overwrite: true });

  // plans + sends
  let planCount = 0;
  let sendCount = 0;
  for (const [day, rec] of Object.entries(state.days || {})) {
    if (!rec || !Array.isArray(rec.times)) continue;
    // today's plan is operational state: never overwrite a plan that is already being executed
    const running = runningPlan && day === todayKey && (runningPlan.done.length || runningPlan.failed.length);
    if (running && !force) {
      repos.savePlan(account.id, day, {
        times: runningPlan.times,
        done: runningPlan.done,
        failed: runningPlan.failed,
        skipped: runningPlan.skipped,
      });
      repos.logEvent('import-skipped-today', { day });
      planCount++;
      continue;
    }
    repos.savePlan(account.id, day, { times: rec.times, done: rec.done || [], failed: [], skipped: !!rec.skipped });
    planCount++;
  }
  for (const e of log) {
    if (e.event === 'send') {
      const ts = e.ts || repos.nowIso();
      repos.insertSend({
        accountId: account.id,
        ts,
        day: dayOf(ts),
        bucket: e.bucket,
        title: e.title,
        author: e.author,
        likes: e.likes,
        friend: e.friend,
        ok: !!(e.result && e.result.ok),
        toast: (e.result && (e.result.toast || e.result.error)) || '',
        shot: e.result && e.result.shot ? path.basename(e.result.shot) : null,
        videoId: e.id || null,
      });
      sendCount++;
    } else {
      repos.logEvent(e.event, e, e.ts || null);
    }
  }

  return { account, bands: bands.length, plans: planCount, sends: sendCount, pools: repos.listPools().length };
}

const toMin = (s) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

const dayOf = (iso) => new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });

module.exports = { importLegacy };
