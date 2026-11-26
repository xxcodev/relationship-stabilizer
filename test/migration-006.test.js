// Upgrade path: a 0.24-era SQLite database (migrations 001-005) gains 006/007 cleanly.
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dyf-mig-'));
const file = path.join(tmp, 'app.db');
const schemaDir = path.join(__dirname, '..', 'schema');
const old = new DatabaseSync(file);
for (const name of ['001_init.sql', '002_plan_failed.sql', '003_events_unique.sql', '004_account_name_friends.sql', '005_friend_userid.sql']) {
  old.exec(fs.readFileSync(path.join(schemaDir, name), 'utf8'));
}
old.prepare("INSERT INTO accounts (label, profile_dir, port, friend, enabled) VALUES ('A','/tmp/a',9334,'Hime',1)").run();
const accountId = old.prepare("SELECT id FROM accounts WHERE label='A'").get().id;
old.prepare("INSERT INTO bands (account_id,name,start_min,end_min,min_count,max_count,sort) VALUES (?,?,?,?,?,?,?)").run(accountId, '晚', 1200, 1410, 4, 8, 0);
old.prepare("INSERT INTO settings (key,value) VALUES ('totalMax','8')").run();
old.prepare("INSERT INTO pools (name,keyword,enabled,sort) VALUES ('测试','测试',1,0)").run();
for (const name of ['001_init.sql', '002_plan_failed.sql', '003_events_unique.sql', '004_account_name_friends.sql', '005_friend_userid.sql']) {
  old.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema:' + name, name);
}
old.close();

process.env.DATA_DIR = tmp;
process.env.DB_FILE = file;
const db = require('../src/db');
const repos = require('../src/repos');

test.after(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('006/007 upgrade backfills per-account config and send source', () => {
  const conn = db.open();
  const acc = repos.getAccount('A');
  assert.equal(repos.getAccountSetting(acc.id, 'dailyTotal'), 8);
  assert.equal(repos.getAccountSetting(acc.id, 'sendMode'), 'auto');
  assert.equal(repos.listAccountPools(acc.id).length, 1);
  assert.equal(repos.listAccountPools(acc.id)[0].enabled, true);
  const columns = conn.prepare('PRAGMA table_info(sends)').all().map((c) => c.name);
  assert.ok(columns.includes('source'));
  const meta = conn.prepare("SELECT value FROM meta WHERE key='schema:006_account_config.sql'").get();
  assert.equal(meta.value, '006_account_config.sql');
});
