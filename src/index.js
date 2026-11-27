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

const SCHEDULER_LOCK_WAIT_MS = 6000;

async function acquireSchedulerLock() {
  const env = require('./env');
  const repos = require('./repos');
  const label = process.env.ACCOUNT || repos.getSetting('activeAccount', 'default') || 'default';
  const safe = String(label).replace(/[^a-zA-Z0-9._-]+/g, '_') || 'default';
  const dir = path.join(env.DATA_DIR, 'run');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `schedule-${safe}.lock`);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const parse = () => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return {}; }
  };
  const alive = (pid) => {
    if (!pid || pid === process.pid) return false;
    try { process.kill(pid, 0); return true; } catch (e) { return false; }
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, account: label, startedAt: new Date().toISOString() }));
      fs.closeSync(fd);
      const release = () => {
        try {
          const cur = parse();
          if (cur.pid === process.pid) fs.unlinkSync(file);
        } catch (e) {}
      };
      process.on('exit', release);
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const info = parse();
      if (alive(info.pid)) {
        // A stale non-host scheduler must not keep sending alongside this one.
        // Prefer the scheduler started by the currently managed host: take over the account lock.
        console.error(`scheduler lock held by pid=${info.pid} account=${info.account || label}; stopping old scheduler`);
        try { process.kill(info.pid, 'SIGTERM'); } catch (e2) {}
        const deadline = Date.now() + SCHEDULER_LOCK_WAIT_MS;
        while (Date.now() < deadline && alive(info.pid)) await sleep(250);
        if (alive(info.pid)) {
          try { process.kill(info.pid, 'SIGKILL'); } catch (e2) {}
          await sleep(300);
        }
      }
      try { fs.unlinkSync(file); } catch (e2) {}
    }
  }
  throw new Error(`无法取得排班锁：${file}`);
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
      repos.seedAccountDefaults(repos.getAccount().id);
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
        const active = require('./api-session') && repos.getSetting('activeAccount', null);
        for (const a of rows) {
          const n = repos.listSends({ accountId: a.id, limit: 100000 }).length;
          const friends = repos.listEnabledFriendNames(a.id);
          console.log(`${a.enabled ? '●' : '○'} ${(a.label === active ? '*' : ' ') + (a.display_name || a.label)}  [${a.label}] :${String(a.port).padEnd(5)} friends=${friends.join('/') || '-'} sends=${n} profile=${a.profile_dir}`);
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
        if (!label) throw new Error('usage: account add <label> [--name 显示名] [--port 9334] [--profile PATH] [--friend NAME]');
        const profile = flag('--profile', path.join(require('./env').DATA_DIR, `profile-${label.toLowerCase()}`));
        const ports = repos.listAccounts().map((a) => Number(a.port));
        const autoPort = ports.length ? Math.max(9333, ...ports) + 1 : 9334;
        const acc = repos.upsertAccount({
          label,
          profileDir: path.resolve(profile),
          port: Number(flag('--port', autoPort)),
          friend: '',
          enabled: false,
        });
        repos.updateAccountDisplayName(acc.id, flag('--name', label));
        repos.replaceBands(acc.id, [
          { name: '早间', startMin: 9 * 60, endMin: 12 * 60, minCount: 1, maxCount: 2 },
          { name: '下午', startMin: 14 * 60, endMin: 18 * 60, minCount: 2, maxCount: 4 },
          { name: '晚间', startMin: 20 * 60, endMin: 23 * 60, minCount: 2, maxCount: 4 },
        ]);
        const friend = flag('--friend', '');
        if (friend) repos.addFriend(acc.id, friend);
        repos.seedAccountDefaults(acc.id);
        console.log(`account ${acc.label} ready: name=${acc.display_name || acc.label}, port ${acc.port}, friends=${repos.listEnabledFriendNames(acc.id).join('/') || '-'}, profile ${acc.profile_dir}`);
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

      if (sub === 'rename') {
        const label = args[1];
        const name = args.slice(2).join(' ').trim();
        const acc = repos.getAccount(label);
        if (!acc) throw new Error(`no account ${label}`);
        if (!name) throw new Error('usage: account rename <label> <显示名>');
        repos.updateAccountDisplayName(acc.id, name);
        console.log(`account ${acc.label} display name = ${name}`);
        break;
      }

      if (sub === 'switch') {
        const label = args[1];
        const acc = repos.getAccount(label);
        if (!acc) throw new Error(`no account ${label}`);
        repos.setSetting('activeAccount', acc.label);
        console.log(`active account = ${acc.label} (panel only; all enabled accounts keep scheduling)`);
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
        try { require('./service').restartScheduler(); } catch (e) {}
        console.log(`removed ${acc.label} (${sends} sends deleted)`);
        break;
      }
      throw new Error('usage: account list | add | switch <label> | enable <label> | disable <label> | remove <label> [--force]');
    }

    case 'api:export': {
      dbReady();
      const out = await require('./api-export').exportSession({
        accountLabel: args.includes('--account') ? args[args.indexOf('--account') + 1] : process.env.ACCOUNT || null,
        keyword: args.includes('--keyword') ? args[args.indexOf('--keyword') + 1] : undefined,
        friend: args.includes('--friend') ? args[args.indexOf('--friend') + 1] : undefined,
      });
      console.log(JSON.stringify({
        ok: out.ok,
        file: out.file,
        account: out.account,
        accountName: out.accountName,
        friend: out.friend,
        keyword: out.keyword,
        friends: out.friends,
        hasCreateTemplate: out.hasCreateTemplate,
        hasFeedUrl: out.hasFeedUrl,
        feedPaths: out.feedPaths,
      }, null, 2));
      break;
    }

    case 'api:status': {
      dbReady();
      const repos = require('./repos');
      const apiSession = require('./api-session');
      const acc = repos.getAccount(process.env.ACCOUNT || repos.getSetting('activeAccount', null));
      const session = acc ? apiSession.load(acc.label) : null;
      const state = apiSession.status(session, null);
      console.log(JSON.stringify({
        file: acc ? apiSession.pathFor(acc.label) : null,
        present: !!session,
        account: session && session.account,
        accountName: (session && session.accountName) || (acc && (acc.display_name || acc.label)) || null,
        accountFriends: acc ? repos.listEnabledFriendNames(acc.id) : [],
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
        hasFeedUrl: !!(session && session.feedUrl),
        sendMode: acc ? repos.getAccountSetting(acc.id, 'sendMode', 'auto') : null,
        videoSource: acc ? repos.getAccountSetting(acc.id, 'videoSource', 'pool') : null,
        autoRefresh: !(repos.getSetting('apiAutoRefresh', '1') === 0 || repos.getSetting('apiAutoRefresh', '1') === '0' || repos.getSetting('apiAutoRefresh', '1') === false),
      }, null, 2));
      break;
    }

    case 'api:clear': {
      dbReady();
      const apiSession = require('./api-session');
      const acc = require('./repos').getAccount(args[0] || null);
      if (acc) apiSession.clearAccount(acc.label);
      apiSession.clearLegacy();
      console.log('api session cleared' + (acc ? ` for ${acc.label}` : ''));
      break;
    }

    case 'api:friends': {
      dbReady();
      const apiSession = require('./api-session');
      const acc = require('./repos').getAccount();
      const session = acc ? apiSession.load(acc.label) : null;
      if (!session) throw new Error('no api session');
      console.log(JSON.stringify({
        account: acc.label,
        accountName: session.accountName || acc.display_name || acc.label,
        defaultFriend: session.friend,
        accountFriends: require('./repos').listEnabledFriendNames(acc.id),
        capturedFriends: (session.friends || []).map((f) => f.name),
        canCreateConversation: !!(session.createTemplate && session.createTemplate.bodyB64),
      }, null, 2));
      break;
    }

    case 'api:mode': {
      dbReady();
      const mode = args[0];
      if (!['auto', 'browser'].includes(mode)) throw new Error('usage: node src/index.js api:mode auto|browser [account]');
      const repos = require('./repos');
      const acc = repos.getAccount(args[1] || process.env.ACCOUNT || repos.getSetting('activeAccount', null));
      if (!acc) throw new Error('no account configured');
      repos.setAccountSetting(acc.id, 'sendMode', mode);
      console.log(`sendMode = ${mode} (account ${acc.label})`);
      break;
    }

    case 'api:send': {
      dbReady();
      const apiSender = require('./api-sender');
      const apiSession = require('./api-session');
      const repos = require('./repos');
      const acc = repos.getAccount(process.env.ACCOUNT || repos.getSetting('activeAccount', null));
      if (!acc) throw new Error('no account configured');
      const session = apiSession.load(acc.label);
      const state = apiSession.status(session, null);
      if (!state.valid) throw new Error(`api session not usable: ${state.reason}`);
      const videoPicker = require('./video-picker');
      const chooseKeyword = require('./pools').chooseKeyword;
      const history = videoPicker.buildHistory(repos.listRecentSentVideos(acc.id, videoPicker.DEFAULT_HISTORY_DAYS));
      const source = repos.getAccountSetting(acc.id, 'videoSource', 'pool') === 'recommend' ? 'recommend' : 'pool';
      let pool = null;
      let video;
      if (source === 'recommend') {
        video = await apiSender.pickFromFeed(session, {
          banWords: repos.getAccountSetting(acc.id, 'banWords', []),
          excludeVideoIds: history.ids,
          excludeTitles: history.titles,
          maxAgeDays: Number(repos.getAccountSetting(acc.id, 'recommendMaxAgeDays', 30)),
        });
      } else {
        const enabledPools = repos.listAccountPools(acc.id).filter((p) => p.enabled);
        if (!enabledPools.length) throw new Error('no enabled pool');
        pool = enabledPools[Math.floor(Math.random() * enabledPools.length)];
        const keyword = chooseKeyword(pool);
        video = await apiSender.pick(session, {
          keyword: keyword.startsWith('@') ? pool.name : keyword,
          banWords: repos.getAccountSetting(acc.id, 'banWords', []),
          excludeVideoIds: history.ids,
          excludeTitles: history.titles,
          maxAgeDays: Number(repos.getAccountSetting(acc.id, 'maxVideoAgeDays', 7)),
        });
      }
      const raw = args.includes('--friends') ? args[args.indexOf('--friends') + 1]
        : args.includes('--friend') ? args[args.indexOf('--friend') + 1]
        : repos.listEnabledFriendNames(acc.id)[0];
      const targets = String(raw || '').split(',').map((x) => x.trim()).filter(Boolean);
      console.log(JSON.stringify({ picked: video.title, source, bucket: source === 'recommend' ? '默认推荐' : pool.name, awemeId: video.awemeId, friends: targets }, null, 2));
      if (args.includes('--dry')) break;
      const results = [];
      for (const friend of targets) {
        if (!apiSession.canSendTo(session, friend)) { results.push({ friend, ok: false, error: 'friend not in captured session list' }); continue; }
        results.push(await apiSender.sendVideo(session, video, { friend }));
      }
      console.log(JSON.stringify({ results, allOk: results.every((r) => r.ok) }, null, 2));
      if (!results.length || !results.every((r) => r.ok)) process.exitCode = 1;
      break;
    }

    case 'api:feed': {
      dbReady();
      const apiSender = require('./api-sender');
      const apiSession = require('./api-session');
      const repos = require('./repos');
      const acc = repos.getAccount(process.env.ACCOUNT || repos.getSetting('activeAccount', null));
      if (!acc) throw new Error('no account configured');
      const session = apiSession.load(acc.label);
      const state = apiSession.status(session, null);
      if (!state.valid) throw new Error(`api session not usable: ${state.reason}`);
      if (!session.feedUrl) throw new Error('会话没有捕获到首页推荐 feed，请重新导出会话');
      const out = await apiSender.collectFeedCandidates(session, {
        banWords: repos.getAccountSetting(acc.id, 'banWords', []),
        maxAgeDays: Number(repos.getAccountSetting(acc.id, 'recommendMaxAgeDays', 30)),
      });
      console.log(JSON.stringify({
        ok: true,
        account: acc.label,
        rawCount: out.rawCount,
        candidates: out.candidates.length,
        sample: out.candidates.slice(0, 5).map((v) => ({ id: v.awemeId, title: v.title, author: v.author })),
      }, null, 2));
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
      const { runtimeConfig } = require('./scheduler');
      const acc = repos.getAccount(process.env.ACCOUNT || repos.getSetting('activeAccount', null));
      const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
      const cfg = acc ? runtimeConfig(acc.label) : null;
      const plan = cfg && cfg.schedule ? cfg.schedule : { points: [], totalCount: 0, minSec: 10, maxSec: 50 };
      console.log(JSON.stringify({
        db: require('./env').DB_FILE,
        account: acc && acc.label,
        friend: acc && acc.friend,
        enabled: acc ? !!acc.enabled : null,
        poolsOn: acc ? repos.listAccountPools(acc.id).filter((p) => p.enabled).length : 0,
        schedulePoints: plan.points,
        scheduleTotal: plan.totalCount,
        minSec: plan.minSec,
        maxSec: plan.maxSec,
        sendMode: acc ? repos.getAccountSetting(acc.id, 'sendMode', 'auto') : null,
        videoSource: acc ? repos.getAccountSetting(acc.id, 'videoSource', 'pool') : null,
        today,
        doneToday: acc ? repos.countSendsByDay(today, acc.id) : 0,
        sendsTotal: repos.listSends({ limit: 100000 }).length,
      }, null, 2));
      break;
    }

    case 'plan': {
      dbReady();
      const { runtimeConfig } = require('./scheduler');
      const repos = require('./repos');
      const cfg = runtimeConfig();
      const acc = repos.getAccount(process.env.ACCOUNT || repos.getSetting('activeAccount', null));
      const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
      console.log(JSON.stringify({
        day: today,
        schedule: cfg.schedule,
        state: repos.getBurstState(acc.id),
      }, null, 2));
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
      await acquireSchedulerLock();
      const { runLoop, startAutoReadLoop } = require('./scheduler');
      if (args.includes('--once')) {
        const out = await runLoop({ once: true });
        console.log(JSON.stringify(out));
        break;
      }
      console.log('scheduler started (config from SQLite)');
      startAutoReadLoop();
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
