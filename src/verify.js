/**
 * @file Cross-layer smoke test: environment + schema + planner + HTTP API, on an ephemeral port.
 */
// End-to-end smoke check that a fresh machine can run: DB, planner, HTTP API.
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
    const tables = conn.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    const needed = ['accounts', 'bands', 'plans', 'pools', 'sends', 'settings', 'events'];
    const missing = needed.filter((t) => !tables.includes(t));
    if (missing.length) bad('schema', 'missing ' + missing.join(','));
    else ok('schema', `${needed.length} tables`);

    const acc = repos.getAccount();
    if (!acc) bad('account', 'none configured');
    else ok('account', `${acc.label} → ${acc.friend || '(none)'} :${acc.port}`);

    const bands = acc ? repos.listBands(acc.id) : [];
    if (!bands.length) bad('bands', 'no time bands');
    else ok('bands', bands.map((b) => `${b.name} ${String(Math.floor(b.start_min / 60)).padStart(2, '0')}:${String(b.start_min % 60).padStart(2, '0')}`).join(' / '));

    const pools = repos.listPools();
    ok('pools', `${pools.filter((p) => p.enabled).length}/${pools.length} enabled`);
  } catch (e) {
    bad('database', e.message.split('\n')[0]);
  }

  // 3. planner reaches a sane plan
  try {
    const planner = require('./planner');
    const acc = repos.getAccount();
    const bands = repos.listBands(acc.id).map((b) => ({
      name: b.name,
      from: b.start_min,
      to: b.end_min,
      min: b.min_count,
      max: b.max_count,
    }));
    const cfg = planner.normalize({
      bands,
      totalMin: repos.getSetting('totalMin', 0),
      totalMax: repos.getSetting('totalMax', 0),
      minGapMinutes: repos.getSetting('minGapMinutes', 5),
    });
    const p = planner.planDay(cfg, cfg.windowStart);
    const inWindow = p.times.every((t) => t >= cfg.windowStart && t < cfg.windowEnd);
    if (!p.count) bad('planner', 'produced an empty plan');
    else if (!inWindow) bad('planner', 'produced times outside the window');
    else ok('planner', `${p.count} slots in ${planner.hm(cfg.windowStart)}-${planner.hm(cfg.windowEnd)}`);
  } catch (e) {
    bad('planner', e.message.split('\n')[0]);
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
    ok('GET /api/config', `${cfg.bands.length} bands, ${Object.keys(cfg.pools).length} pools`);

    const status = await get('/api/status');
    ok('GET /api/status', `scheduler=${status.scheduler.running} challenge=${status.browser.challenge}`);

    const prev = await fetch(base + '/api/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...cfg, totalMin: 9, totalMax: 9 }),
    }).then((r) => r.json());
    if (!prev.ok) bad('POST /api/preview', prev.error || 'failed');
    else ok('POST /api/preview', `${prev.count} slots, bands=${prev.bands.map((b) => b.n).join('/')}`);
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
