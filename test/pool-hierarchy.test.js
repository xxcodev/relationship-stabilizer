const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dyf-pools-ai-'));
process.env.DATA_DIR = tmp;
process.env.DB_FILE = path.join(tmp, 'app.db');

const repos = require('../src/repos');
const { POOLS } = require('../src/pools');
const aiPools = require('../src/ai/pools');

test.after(() => {
  try { require('../src/db').close(); } catch (e) {}
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('AI child pool keeps its parent and is enabled only for the selected account', () => {
  repos.seedPools(POOLS);
  const a = repos.upsertAccount({ label: 'A', profileDir: path.join(tmp, 'a'), port: 9334, friend: 'Hime', enabled: true });
  const b = repos.upsertAccount({ label: 'B', profileDir: path.join(tmp, 'b'), port: 9335, friend: 'Other', enabled: true });
  repos.seedAccountDefaults(a.id); repos.seedAccountDefaults(b.id);
  const added = repos.addPool({ name: '洛丽塔', keyword: '洛丽塔穿搭', parentName: '二次元', enabled: false });
  assert.equal(added.name, '洛丽塔');
  repos.setAccountPoolEnabled(a.id, '洛丽塔', true);
  const forA = repos.listAccountPools(a.id).find((p) => p.name === '洛丽塔');
  const forB = repos.listAccountPools(b.id).find((p) => p.name === '洛丽塔');
  assert.equal(forA.parent_name, '二次元');
  assert.equal(forA.enabled, true);
  assert.equal(forB.enabled, false);
});

test('AI category expansion validates and de-duplicates names', async () => {
  const original = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify({ categories: [
      { name: 'cosplay', keyword: 'cosplay' },
      { name: 'cosplay', keyword: '重复' },
      { name: '梦女', keyword: '梦女向' },
    ] }) } }] }),
  });
  try {
    const out = await aiPools.expand({
      parent: { name: '二次元', keyword: '@acg' },
      existing: ['二次元', '韩剧'],
      cfg: { enabled: true, baseUrl: 'https://ai.test/v1', model: 'm', apiKey: 'k', assistantEnabled: true },
    });
    assert.deepEqual(out.categories.map((c) => c.name), ['cosplay', '梦女']);
  } finally { global.fetch = original; }
});
