/**
 * @file Cross-layer smoke test: environment + schema + schedule config + HTTP API, on an ephemeral port.
 */
// End-to-end smoke check that a fresh machine can run: DB, schedule config, HTTP API.
// Never touches the live scheduler or the browser; the dashboard is started on port 0.
const results = [];
const ok = (label, detail) => results.push({ ok: true, label, detail });
const bad = (label, detail) => results.push({ ok: false, label, detail });

async function main() {
  // 1. environment
  const doctor = await require('./doctor').run();
  for (const r of doctor) {
    if (r.label === 'port 9400') continue; // the live dashboard may own it
    if (r.label === 'account') continue; // re-checked below against the repositories
    results.push(r);
  }

  // 2. database
  let repos;
  try {
    const db = require('./db');
    const conn = db.open();
    repos = require('./repos');
    const needed = ['accounts', 'bands', 'plans', 'pools', 'sends', 'settings', 'events', 'friends', 'account_settings', 'account_pools'];
    const missing = [];
    for (const table of needed) {
      try { conn.prepare(`SELECT 1 FROM ${table} LIMIT 1`).all(); } catch (e) { missing.push(table); }
    }
    if (missing.length) bad('schema', 'missing ' + missing.join(','));
    else ok('schema', `${needed.length} tables`);

    const acc = repos.getAccount();
    if (!acc) bad('account', 'none configured');
    else ok('account', `${acc.label} → ${acc.friend || '(none)'} :${acc.port}`);


    const pools = repos.listPools();
    ok('pools', `${pools.filter((p) => p.enabled).length}/${pools.length} enabled`);
  } catch (e) {
    bad('database', e.message.split('\n')[0]);
  }

  // 3. schedule config is coherent
  try {
    const { runtimeConfig } = require('./scheduler');
    const acc = repos.getAccount();
    const cfg = runtimeConfig(acc.label);
    const plan = cfg.schedule || {};
    const points = Array.isArray(plan.points) ? plan.points : [];
    const problems = [];
    if (!points.length) problems.push('触发点');
    if (points.some((p) => {
      if (!(p.count >= 1 && p.count <= 50)) return true;
      if (p.mode === 'random') return !(p.from && p.to && p.to > p.from);
      return !/^\d{2}:\d{2}$/.test(p.time || '');
    })) problems.push('触发点时间/条数');
    if (!(plan.minSec >= 1 && plan.maxSec >= plan.minSec)) problems.push('间隔');
    if (problems.length) bad('schedule', `计划配置异常：${problems.join('、')}`);
    else {
      const describe = points.map((p) => `${p.mode === 'random' ? `${p.from}-${p.to}随机` : p.time}×${p.count}`);
      ok('schedule', `${points.length} 个触发点（${describe.join('、')}），间隔 ${plan.minSec}-${plan.maxSec}s`);
    }
  } catch (e) {
    bad('schedule', e.message.split('\n')[0]);
  }

  // 4. HTTP API on an ephemeral port
  let server;
  try {
    const dash = require('./dashboard');
    const started = await dash.startServer({ port: 0, host: '127.0.0.1' });
    server = started.server;
    const base = started.url;
    const get = async (p) => (await fetch(base + p)).json();

    const data = await get('/api/data');
    ok('GET /api/data', `plan=${data.todayPlan} done=${data.todayDone} history=${data.sends.length}`);

    const cfg = await get('/api/config');
    ok('GET /api/config', `${(cfg.schedulePoints || []).length} triggers, ${Object.keys(cfg.pools || {}).length} pools`);

    const status = await get('/api/status');
    ok('GET /api/status', `scheduler=${status.scheduler.running} challenge=${status.browser.challenge}`);

    const prev = await fetch(base + '/api/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...cfg, totalMin: 9, totalMax: 9 }),
    }).then((r) => r.json());
    if (!prev.ok) bad('POST /api/preview', prev.error || 'failed');
    else ok('POST /api/preview', `${prev.pointCount} 个触发点，共 ${prev.count} 条`);
  } catch (e) {
    bad('http api', e.message.split('\n')[0]);
  } finally {
    if (server) server.close();
  }

  // report
  for (const r of results) console.log(`${r.ok ? '✔' : '✖'} ${String(r.label).padEnd(18)} ${r.detail || ''}`);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('verify crashed:', e.message);
  process.exit(1);
});
