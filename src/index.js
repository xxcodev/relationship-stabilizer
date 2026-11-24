#!/usr/bin/env node
/**
 * @file CLI entry point: init / migrate / status / plan / dashboard / schedule / send-once / doctor / verify / account.
 */
// CLI entry point.
const path = require('path');
const fs = require('fs');

const cmd = process.argv[2] || 'help';
const args = process.argv.slice(3);

function dbReady() {
  const db = require('./db');
  db.open();
  return db;
}

async function main() {
  switch (cmd) {
    case 'init': {
      dbReady();
      const repos = require('./repos');
      const { POOLS } = require('./pools');
      repos.seedPools(POOLS);
      if (!repos.getAccount()) {
        repos.upsertAccount({
          label: 'A',
          profileDir: path.resolve(process.env.PROFILE_DIR || path.join(require('./env').DATA_DIR, 'profile-a')),
          port: Number(process.env.ACCOUNT_PORT || 9333),
          friend: process.env.FRIEND || '',
          enabled: true,
        });
      }
      if (!repos.listBands(repos.getAccount().id).length) {
        repos.replaceBands(repos.getAccount().id, [
          { name: '早上', startMin: 7 * 60, endMin: 10 * 60, minCount: 1, maxCount: 3 },
          { name: '中午', startMin: 12 * 60, endMin: 14 * 60, minCount: 1, maxCount: 2 },
          { name: '晚上', startMin: 21 * 60, endMin: 23 * 60 + 30, minCount: 8, maxCount: 13 },
        ]);
      }
      console.log(`initialised: ${require('./env').DB_FILE}`);
      console.log(`account: ${repos.getAccount().label}, pools: ${repos.listPools().length}`);
      break;
    }

    case 'migrate': {
      dbReady();
      const dir = args[0] || process.env.LEGACY_DIR;
      if (!dir) throw new Error('usage: npm run migrate -- <legacyDir>');
      const out = require('./importer').importLegacy(dir, { force: args.includes('--force') });
      console.log(JSON.stringify(out, null, 2));
      break;
    }

    case 'account': {
      dbReady();
      const repos = require('./repos');
      const sub = args[0] || 'list';
      if (sub === 'list') {
        const rows = require('./db').open().prepare('SELECT * FROM accounts ORDER BY id').all();
        for (const a of rows) {
          const n = repos.listSends({ accountId: a.id, limit: 100000 }).length;
          console.log(`${a.enabled ? '●' : '○'} ${a.label.padEnd(10)} :${String(a.port).padEnd(5)} friend=${a.friend || '-'} sends=${n} profile=${a.profile_dir}`);
        }
        if (!rows.length) console.log('(no accounts)');
        break;
      }
      if (sub === 'add') {
        const label = args[1];
        const flag = (name, dflt) => {
          const i = args.indexOf(name);
          return i > 0 ? args[i + 1] : dflt;
        };
        if (!label) throw new Error('usage: account add <label> [--port 9334] [--profile PATH] [--friend NAME]');
        const profile = flag('--profile', path.join(require('./env').DATA_DIR, `profile-${label.toLowerCase()}`));
        const acc = repos.upsertAccount({
          label,
          profileDir: path.resolve(profile),
          port: Number(flag('--port', 9334)),
          friend: flag('--friend', ''),
          enabled: true,
        });
        console.log(`account ${acc.label} ready: port ${acc.port}, profile ${acc.profile_dir}`);
        console.log('next: start the browser and scan the QR once — `node src/index.js send-once --dry` opens it');
        break;
      }
      if (sub === 'move-profile') {
        const label = args[1];
        const acc = repos.getAccount(label);
        if (!acc) throw new Error(`no account ${label}`);
        const toIdx = args.indexOf('--to');
        const explicitTo = toIdx >= 0 ? args[toIdx + 1] : null;
        const to = path.resolve(explicitTo || path.join(require('./env').DATA_DIR, `profile-${acc.label.toLowerCase()}`));
        const fs = require('fs');
        const lock = path.join(acc.profile_dir, 'SingletonLock');
        if (fs.existsSync(lock)) throw new Error(`profile is in use (${lock}); close the browser first`);
        let listening = false;
        try {
          listening = !!(await fetch(`http://127.0.0.1:${acc.port}/state`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok));
        } catch (e) {}
        if (listening) throw new Error(`browser still serving on port ${acc.port}; stop it first`);
        if (!fs.existsSync(acc.profile_dir)) throw new Error(`profile dir missing: ${acc.profile_dir}`);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        try {
          fs.renameSync(acc.profile_dir, to);
        } catch (e) {
          fs.cpSync(acc.profile_dir, to, { recursive: true });
          fs.rmSync(acc.profile_dir, { recursive: true, force: true });
        }
        require('./db').open().prepare('UPDATE accounts SET profile_dir = ? WHERE id = ?').run(to, acc.id);
        console.log(`moved ${acc.label}: ${acc.profile_dir} → ${to}`);
        break;
      }

      if (sub === 'enable' || sub === 'disable') {
        const label = args[1];
        const acc = repos.getAccount(label);
        if (!acc) throw new Error(`no account ${label}`);
        require('./db').open().prepare('UPDATE accounts SET enabled = ? WHERE id = ?').run(sub === 'enable' ? 1 : 0, acc.id);
        console.log(`${acc.label} ${sub}d`);
        break;
      }
      if (sub === 'remove') {
        const label = args[1];
        const acc = repos.getAccount(label);
        if (!acc) throw new Error(`no account ${label}`);
        const sends = repos.listSends({ accountId: acc.id, limit: 100000 }).length;
        const force = args.includes('--force');
        if (sends && !force) throw new Error(`${acc.label} has ${sends} sends; pass --force to delete them too`);
        require('./db').open().prepare('DELETE FROM accounts WHERE id = ?').run(acc.id);
        console.log(`removed ${acc.label} (${sends} sends deleted)`);
        break;
      }
      throw new Error('usage: account list | add | enable <label> | disable <label> | remove <label> [--force]');
    }

    case 'api:export': {
      dbReady();
      const out = await require('./api-export').exportSession({
        accountLabel: args.includes('--account') ? args[args.indexOf('--account') + 1] : process.env.ACCOUNT || null,
        keyword: args.includes('--keyword') ? args[args.indexOf('--keyword') + 1] : undefined,
      });
      console.log(JSON.stringify({
        ok: out.ok,
        file: out.file,
        account: out.account,
        friend: out.friend,
        keyword: out.keyword,
        friends: out.friends,
        hasCreateTemplate: out.hasCreateTemplate,
      }, null, 2));
      break;
    }

    case 'api:status': {
      dbReady();
      const repos = require('./repos');
      const apiSession = require('./api-session');
      const acc = repos.getAccount();
      const session = apiSession.load();
      const state = apiSession.status(session, acc && acc.friend);
      console.log(JSON.stringify({
        file: apiSession.FILE,
        present: !!session,
        account: session && session.account,
        friend: session && session.friend,
        keyword: session && session.keyword,
        createdAt: session && session.createdAt,
        ageHours: state.ageHours,
        valid: state.valid,
        reason: state.reason,
        templateBytes: session && session.template ? session.template.bodyB64.length : 0,
        cookies: session ? (session.cookies || []).length : 0,
        friends: session ? (session.friends || []).length : 0,
        hasCreateTemplate: !!(session && session.createTemplate),
        sendMode: repos.getSetting('sendMode', 'auto'),
        autoRefresh: !(repos.getSetting('apiAutoRefresh', '1') === 0 || repos.getSetting('apiAutoRefresh', '1') === '0' || repos.getSetting('apiAutoRefresh', '1') === false),
      }, null, 2));
      break;
    }

    case 'api:clear': {
      dbReady();
      require('./api-session').clear();
      console.log('api session cleared');
      break;
    }

    case 'api:friends': {
      dbReady();
      const apiSession = require('./api-session');
      const session = apiSession.load();
      if (!session) throw new Error('no api session');
      console.log(JSON.stringify({
        defaultFriend: session.friend,
        friends: (session.friends || []).map((f) => f.name),
        canCreateConversation: !!(session.createTemplate && session.createTemplate.bodyB64),
      }, null, 2));
      break;
    }

    case 'api:mode': {
      dbReady();
      const mode = args[0];
      if (!['auto', 'browser'].includes(mode)) throw new Error('usage: node src/index.js api:mode auto|browser');
      require('./repos').setSetting('sendMode', mode);
      console.log(`sendMode = ${mode}`);
      break;
    }

    case 'api:send': {
      dbReady();
      const apiSender = require('./api-sender');
      const apiSession = require('./api-session');
      const repos = require('./repos');
      const acc = repos.getAccount();
      if (!acc) throw new Error('no account configured');
      const session = apiSession.load();
      const state = apiSession.status(session, acc.friend);
      if (!state.valid) throw new Error(`api session not usable: ${state.reason}`);
      const pool = repos.listPools().find((p) => p.enabled);
      if (!pool) throw new Error('no enabled pool');
      const video = await apiSender.pick(session, { keyword: pool.keyword, banWords: repos.getSetting('banWords', []) });
      const friend = args.includes('--friend') ? args[args.indexOf('--friend') + 1] : acc.friend;
      console.log(JSON.stringify({ picked: video.title, pool: pool.name, awemeId: video.awemeId, friend }, null, 2));
      if (args.includes('--dry')) break;
      const res = await apiSender.sendVideo(session, video, { friend });
      console.log(JSON.stringify(res, null, 2));
      if (!res.ok) process.exitCode = 1;
      break;
    }

    case 'doctor': {
      const rs = await require('./doctor').run();
      for (const r of rs) console.log(`${r.ok ? '✔' : '✖'} ${r.label.padEnd(16)} ${r.detail}`);
      if (!rs.every((r) => r.ok)) process.exitCode = 1;
      break;
    }

    case 'status': {
      dbReady();
      const repos = require('./repos');
      const acc = repos.getAccount();
      const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
      const plan = acc ? repos.getPlan(acc.id, today) : null;
      console.log(JSON.stringify({
        db: require('./env').DB_FILE,
        account: acc && acc.label,
        friend: acc && acc.friend,
        enabled: acc ? !!acc.enabled : null,
        bands: acc ? repos.listBands(acc.id).length : 0,
        poolsOn: repos.listPools().filter((p) => p.enabled).length,
        today,
        planTimes: plan ? plan.times.length : 0,
        doneToday: acc ? repos.countSendsByDay(today, acc.id) : 0,
        sendsTotal: repos.listSends({ limit: 100000 }).length,
      }, null, 2));
      break;
    }

    case 'plan': {
      dbReady();
      const planner = require('./planner');
      const { runtimeConfig } = require('./scheduler');
      const cfg = runtimeConfig();
      const acc = require('./repos').getAccount();
      const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
      const plan = require('./repos').getPlan(acc.id, today);
      if (plan && plan.times.length) {
        console.log(JSON.stringify({ day: today, source: 'stored', count: plan.times.length, times: plan.times.map(planner.hm), done: plan.done.map(planner.hm) }, null, 2));
      } else {
        const p = planner.planDay(cfg, cfg.windowStart);
        console.log(JSON.stringify({ day: today, source: 'generated', count: p.count, allocation: p.allocation, times: p.times.map(planner.hm) }, null, 2));
      }
      break;
    }

    case 'dashboard': {
      dbReady();
      const { startServer } = require('./dashboard');
      const env = require('./env');
      const port = args.includes('--port') ? Number(args[args.indexOf('--port') + 1]) : env.dashboard.port;
      const { url } = await startServer({ port });
      console.log(`dashboard ${url}`);
      break;
    }

    case 'schedule': {
      dbReady();
      const { runLoop } = require('./scheduler');
      if (args.includes('--once')) {
        const out = await runLoop({ once: true });
        console.log(JSON.stringify(out));
        break;
      }
      console.log('scheduler started (config from SQLite)');
      await runLoop({});
      break;
    }

    case 'send-once': {
      dbReady();
      const { runtimeConfig, sendOne } = require('./scheduler');
      const cfg = runtimeConfig();
      const dry = args.includes('--dry');
      const res = await sendOne(cfg, { dryRun: dry }).catch((e) => ({ ok: false, error: e.message }));
      console.log(JSON.stringify(res, null, 2));
      break;
    }

    default:
      console.log(fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8').split('## Usage')[1] || 'see README');
  }
}

main().catch((e) => {
  console.error('error:', e.message);
  process.exit(1);
});
