// Importer tests: a synthetic legacy folder, imported twice, must be idempotent.
const os = require('os');
const path = require('path');
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dyf-import-'));
process.env.DB_FILE = path.join(tmpRoot, 'test.db');
process.env.DATA_DIR = tmpRoot;

const legacyDir = path.join(tmpRoot, 'legacy');
fs.mkdirSync(legacyDir, { recursive: true });

const write = (name, data) => fs.writeFileSync(path.join(legacyDir, name), typeof data === 'string' ? data : JSON.stringify(data, null, 2));

write('config.json', {
  enabled: true,
  friend: 'Hime',
  minGapMinutes: 5,
  totalMin: 10,
  totalMax: 18,
  bands: [
    { name: '早上', from: '07:00', to: '10:00', min: 1, max: 3 },
    { name: '晚上', from: '21:00', to: '23:30', min: 8, max: 13 },
  ],
  pools: { 韩剧: true, 发癫: false },
  banWords: ['国漫'],
});
write('accounts.json', { accounts: { B: { profile: 'profile-B', port: 9334, friend: 'Hime' } } });
write('scheduler-state.json', {
  days: { '2026-11-23': { count: 2, times: [660, 780], done: [660] } },
});
fs.writeFileSync(
  path.join(legacyDir, 'send-log.jsonl'),
  [
    { ts: '2026-11-23T04:00:00.000Z', event: 'send', bucket: '韩剧', title: 't1', author: '@a', likes: 1000, friend: 'Hime', result: { ok: true, toast: '分享成功', shot: '/x/sent-a.png' } },
    { ts: '2026-11-23T05:00:00.000Z', event: 'send', bucket: '搞笑', title: 't2', author: '@b', likes: 2000, friend: 'Hime', result: { ok: false, error: 'boom' } },
    { ts: '2026-11-23T05:30:00.000Z', event: 'day-plan', count: 2 },
  ].map((o) => JSON.stringify(o)).join('\n') + '\n'
);

const db = require('../src/db');
const repos = require('../src/repos');
const { importLegacy } = require('../src/importer');

test.after(() => {
  db.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('first import fills the database', () => {
  const out = importLegacy(legacyDir);
  assert.equal(out.account.label, 'B');
  assert.equal(out.bands, 2);
  assert.equal(out.plans, 1);
  assert.equal(out.sends, 2);

  assert.equal(repos.getSetting('totalMax'), 18);
  assert.deepEqual(repos.getSetting('banWords'), ['国漫']);

  const acc = repos.getAccount('B');
  assert.equal(acc.friend, 'Hime');
  assert.equal(acc.port, 9334);

  const plan = repos.getPlan(acc.id, '2026-11-23');
  assert.deepEqual(plan.times, [660, 780]);
  assert.deepEqual(plan.done, [660]);

  assert.equal(repos.listSends({ accountId: acc.id, limit: 50 }).length, 2);
  assert.equal(repos.countSendsByDay('2026-11-23', acc.id), 1); // only the ok=1 row counts
});

test('pool toggles from the legacy config survive', () => {
  const pools = Object.fromEntries(repos.listPools().map((p) => [p.name, !!p.enabled]));
  assert.equal(pools['韩剧'], true);
  assert.equal(pools['发癫'], false);
});

test('re-importing does not duplicate rows', () => {
  const before = repos.listSends({ accountId: repos.getAccount('B').id, limit: 100 }).length;
  importLegacy(legacyDir);
  importLegacy(legacyDir);
  const after = repos.listSends({ accountId: repos.getAccount('B').id, limit: 100 }).length;
  assert.equal(after, before);
  assert.equal(repos.getPlan(repos.getAccount('B').id, '2026-11-23').times.length, 2);
});

test('re-importing never flips the pause switch', () => {
  db.open().prepare('UPDATE accounts SET enabled = 0 WHERE label = ?').run('B');
  importLegacy(legacyDir);
  assert.equal(repos.getAccount('B').enabled, 0, 'enabled is operational state, not imported config');
});

test('a running plan for today is not overwritten by a re-import', () => {
  const acc = repos.getAccount('B');
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });

  // give the legacy fixture a plan for today so the conflict is real
  const stateFile = path.join(legacyDir, 'scheduler-state.json');
  const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  st.days[today] = { count: 2, times: [900, 1000], done: [] };
  fs.writeFileSync(stateFile, JSON.stringify(st));

  repos.savePlan(acc.id, today, { times: [600, 700], done: [600], failed: [700] });

  importLegacy(legacyDir); // no --force
  const kept = repos.getPlan(acc.id, today);
  assert.deepEqual(kept.times, [600, 700], 'the executed plan must survive a re-import');
  assert.deepEqual(kept.done, [600]);

  importLegacy(legacyDir, { force: true });
  const replaced = repos.getPlan(acc.id, today);
  assert.deepEqual(replaced.times, [900, 1000], 'force replaces it with the legacy plan');
});
