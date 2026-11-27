/**
 * @file Standalone read receipts with a multi-friend, random-interval schedule.
 *
 * Each account selects one or more friends. A scheduler-side poll (every 5s) only performs a
 * read when the persisted `nextAt` is due. The next time is chosen from:
 *   - outside a fixed window: a random value in [minMin, maxMin] minutes, or wait for the next
 *     window when outsideMode = 'pause';
 *   - inside the fixed window: a fixed `windowIntervalMin` frequency.
 * The scheduler keeps running while the account is paused and does not depend on the daily plan
 * or slow-mail. Each due check marks every selected friend's 1:1 conversation read.
 */
const repos = require('./repos');
const apiSession = require('./api-session');
const apiRead = require('./api-read');
const apiSender = require('./api-sender');

const DEFAULT_MIN_MIN = 10;
const DEFAULT_MAX_MIN = 60;
const DEFAULT_WINDOW_START = '09:00';
const DEFAULT_WINDOW_END = '23:00';
const DEFAULT_WINDOW_INTERVAL_MIN = 15;
const MIN_MIN_MIN = 1;
const MAX_MIN_MIN = 720;
const POLL_MS = 5 * 1000;

function asBool(value, def = false) {
  if (value === undefined || value === null || value === '') return def;
  return !(value === false || value === 0 || value === '0' || value === 'false');
}

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function normalizeTime(value, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!m) return fallback;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return fallback;
  return String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0');
}

function timeToMin(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

function localMinutes(now = new Date()) {
  return now.getHours() * 60 + now.getMinutes();
}

function normalizeFriends(raw, fallbackUid, fallbackName) {
  const source = Array.isArray(raw) ? raw : [];
  const list = source.length ? source : (fallbackUid ? [{ uid: fallbackUid, name: fallbackName }] : []);
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const uid = String((item && (item.uid || item.userid)) || '').trim();
    if (!/^\d+$/.test(uid) || seen.has(uid)) continue;
    seen.add(uid);
    out.push({ uid, name: String((item && item.name) || uid).trim() });
  }
  return out;
}

function config(acc) {
  const oldUid = String(repos.getAccountSetting(acc.id, 'autoReadFriendUid', '') || '').trim();
  const oldName = String(repos.getAccountSetting(acc.id, 'autoReadFriend', '') || '').trim();
  const friends = normalizeFriends(repos.getAccountSetting(acc.id, 'autoReadFriends', null), oldUid, oldName);
  const minMin = clampInt(repos.getAccountSetting(acc.id, 'autoReadMinMin', DEFAULT_MIN_MIN), MIN_MIN_MIN, MAX_MIN_MIN, DEFAULT_MIN_MIN);
  const maxMin = clampInt(repos.getAccountSetting(acc.id, 'autoReadMaxMin', DEFAULT_MAX_MIN), minMin, MAX_MIN_MIN, DEFAULT_MAX_MIN);
  const start = normalizeTime(repos.getAccountSetting(acc.id, 'autoReadWindowStart', DEFAULT_WINDOW_START), DEFAULT_WINDOW_START);
  const end = normalizeTime(repos.getAccountSetting(acc.id, 'autoReadWindowEnd', DEFAULT_WINDOW_END), DEFAULT_WINDOW_END);
  const windowIntervalMin = clampInt(repos.getAccountSetting(acc.id, 'autoReadWindowIntervalMin', DEFAULT_WINDOW_INTERVAL_MIN), 1, MAX_MIN_MIN, DEFAULT_WINDOW_INTERVAL_MIN);
  const outside = String(repos.getAccountSetting(acc.id, 'autoReadOutside', 'random') || 'random') === 'pause' ? 'pause' : 'random';
  return {
    enabled: asBool(repos.getAccountSetting(acc.id, 'autoReadEnabled', '0'), false),
    friends,
    minMin,
    maxMin: Math.max(minMin, maxMin),
    windowEnabled: asBool(repos.getAccountSetting(acc.id, 'autoReadWindowEnabled', '0'), false),
    windowStart: start,
    windowEnd: end,
    windowIntervalMin,
    outside,
  };
}

function configKey(cfg) {
  return JSON.stringify({
    enabled: !!cfg.enabled,
    friends: (cfg.friends || []).map((f) => f.uid),
    minMin: cfg.minMin,
    maxMin: cfg.maxMin,
    windowEnabled: !!cfg.windowEnabled,
    windowStart: cfg.windowStart,
    windowEnd: cfg.windowEnd,
    windowIntervalMin: cfg.windowIntervalMin,
    outside: cfg.outside,
  });
}

function state(acc) {
  const raw = repos.getAccountSetting(acc.id, 'autoReadState', null);
  return raw && typeof raw === 'object' ? raw : {};
}

function saveState(acc, next) {
  repos.setAccountSetting(acc.id, 'autoReadState', next);
}

function clearState(acc) {
  repos.setAccountSetting(acc.id, 'autoReadState', {});
}

function inWindow(now, cfg) {
  if (!cfg.windowEnabled) return true;
  const s = timeToMin(cfg.windowStart);
  const e = timeToMin(cfg.windowEnd);
  if (s === e) return true; // 24h window
  const m = localMinutes(now);
  if (s < e) return m >= s && m < e;
  return m >= s || m < e; // overnight
}

function windowEndAt(now, cfg) {
  const s = timeToMin(cfg.windowStart);
  const e = timeToMin(cfg.windowEnd);
  const date = new Date(now.getTime());
  date.setSeconds(0, 0);
  if (s === e) {
    date.setDate(date.getDate() + 1);
    date.setHours(Math.floor(s / 60), s % 60, 0, 0);
    return date;
  }
  if (s < e) {
    date.setHours(Math.floor(e / 60), e % 60, 0, 0);
    return date;
  }
  if (localMinutes(now) >= s) date.setDate(date.getDate() + 1);
  date.setHours(Math.floor(e / 60), e % 60, 0, 0);
  return date;
}

function nextWindowStart(now, cfg) {
  const s = timeToMin(cfg.windowStart);
  const date = new Date(now.getTime());
  date.setSeconds(0, 0);
  date.setHours(Math.floor(s / 60), s % 60, 0, 0);
  if (date.getTime() <= now.getTime()) date.setDate(date.getDate() + 1);
  return date;
}

function randomMinutes(cfg, rnd = Math.random) {
  const min = Math.max(1, cfg.minMin);
  const max = Math.max(min, cfg.maxMin);
  return min + Math.floor(Math.min(0.999999, Math.max(0, rnd())) * (max - min + 1));
}

function nextCheckAt(cfg, now = new Date(), rnd = Math.random) {
  if (!cfg || !cfg.enabled || !cfg.friends || !cfg.friends.length) return null;
  const randomAt = (base) => new Date(base.getTime() + randomMinutes(cfg, rnd) * 60000);
  if (!cfg.windowEnabled) return randomAt(now);
  if (!inWindow(now, cfg)) {
    return cfg.outside === 'pause' ? nextWindowStart(now, cfg) : randomAt(now);
  }
  const candidate = new Date(now.getTime() + Math.max(1, cfg.windowIntervalMin) * 60000);
  const end = windowEndAt(now, cfg);
  if (candidate.getTime() < end.getTime()) return candidate;
  return cfg.outside === 'pause' ? nextWindowStart(end, cfg) : randomAt(end);
}

function view(acc, { friends = [], api = null } = {}) {
  return {
    ok: true,
    account: acc.label,
    accountName: acc.display_name || acc.label,
    config: config(acc),
    state: state(acc),
    friends: Array.isArray(friends) ? friends : [],
    api: api || apiSession.status(apiSession.load(acc.label), null),
  };
}

function scheduleState(acc, cfg, now, previous, nextAt) {
  const next = {
    ...previous,
    configKey: configKey(cfg),
    nextAt: nextAt ? nextAt.toISOString() : null,
    nextIntervalMin: nextAt ? Math.max(1, Math.round((nextAt.getTime() - now.getTime()) / 60000)) : null,
    updatedAt: now.toISOString(),
  };
  saveState(acc, next);
  return next;
}

function tickOnlyState(acc, cfg, now) {
  const previous = state(acc);
  const key = configKey(cfg);
  if (!cfg.enabled || !cfg.friends.length) {
    const next = { ...previous, configKey: key, nextAt: null, nextIntervalMin: null, updatedAt: now.toISOString() };
    saveState(acc, next);
    return { ok: false, skipped: !cfg.enabled ? 'disabled' : 'no-friends', state: next };
  }
  if (!previous.nextAt || previous.configKey !== key) {
    const nextAt = nextCheckAt(cfg, now);
    const next = scheduleState(acc, cfg, now, previous, nextAt);
    return { ok: false, scheduled: true, nextAt: next.nextAt, state: next };
  }
  const due = Date.parse(previous.nextAt);
  if (!Number.isFinite(due) || now.getTime() >= due) {
    return { ok: false, due: true, state: previous };
  }
  return { ok: false, waiting: true, nextAt: previous.nextAt, state: previous };
}

async function runCheck(acc, cfg, now = new Date()) {
  const previous = state(acc);
  const previousFriends = new Map(
    (Array.isArray(previous.friends) ? previous.friends : [])
      .map((f) => [String(f.uid || ''), f])
      .filter(([uid]) => uid),
  );
  const session = apiSession.load(acc.label);
  const api = apiSession.status(session, null);
  const results = [];
  let firstError = '';
  if (!api.valid) {
    firstError = `纯 API 会话不可用：${api.reason || '未导出'}`;
    for (const friend of cfg.friends) {
      results.push({ ...friend, ok: false, error: firstError, lastReadAt: previousFriends.get(friend.uid)?.lastReadAt || null });
    }
  } else {
    for (const friend of cfg.friends) {
      const cached = previousFriends.get(friend.uid) || {};
      let conversationId = String(cached.conversationId || '');
      let conversationShortId = String(cached.conversationShortId || '');
      let error = '';
      if (!conversationId || !conversationShortId) {
        if (!session.createTemplate || !session.createTemplate.bodyB64) {
          error = '会话缺少 conversation/create 模板，请重新导出纯 API 会话';
        } else {
          try {
            const created = await apiSender.createConversation(session, friend.uid);
            if (created && created.ok) {
              conversationId = created.conversationId;
              conversationShortId = created.conversationShortId;
            } else {
              error = (created && created.error) || '建立会话失败';
            }
          } catch (e) {
            error = e.message || '建立会话失败';
          }
        }
      }
      if (!error && !/^0:1:/.test(String(conversationId))) error = '目标不是 1:1 会话，已跳过';
      let read = null;
      if (!error) {
        try {
          read = await apiRead.markConversationRead(session, {
            conversationId,
            conversationShortId,
            conversationType: 1,
            readIndex: apiRead.READ_INDEX,
          });
        } catch (e) {
          read = { ok: false, error: e.message || '已读请求失败' };
        }
        if (!read || !read.ok) error = (read && read.error) || '已读请求失败';
      }
      if (error && !firstError) firstError = error;
      results.push({
        ...friend,
        conversationId,
        conversationShortId,
        ok: !error,
        status: read && read.status ? read.status : 0,
        error,
        lastReadAt: !error ? now.toISOString() : (cached.lastReadAt || null),
      });
    }
  }
  const okResults = results.filter((r) => r.ok);
  const nextAt = nextCheckAt(cfg, now);
  const next = {
    configKey: configKey(cfg),
    lastCheckAt: now.toISOString(),
    lastReadAt: okResults.length ? now.toISOString() : (previous.lastReadAt || null),
    lastOk: results.length > 0 && okResults.length === results.length,
    lastError: firstError,
    nextAt: nextAt ? nextAt.toISOString() : null,
    nextIntervalMin: nextAt ? Math.max(1, Math.round((nextAt.getTime() - now.getTime()) / 60000)) : null,
    friends: results,
    updatedAt: now.toISOString(),
  };
  saveState(acc, next);

  if (okResults.length) {
    repos.logEvent('auto-read', {
      account: acc.label,
      count: okResults.length,
      friends: okResults.map((f) => f.name),
      friendUids: okResults.map((f) => f.uid),
      nextAt: next.nextAt,
    });
  }
  if (results.length !== okResults.length) {
    repos.logEvent('auto-read-fail', {
      account: acc.label,
      count: results.length - okResults.length,
      friends: results.filter((r) => !r.ok).map((r) => r.name),
      errors: results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.error}`),
      nextAt: next.nextAt,
    });
  }
  return { ok: okResults.length > 0, checked: results, state: next };
}

/**
 * Poll entry: schedule the next check when config changed, run all selected friends when due.
 * `force` is used by the dashboard's "立即已读" button and runs regardless of the switch.
 */
async function tick(acc, { force = false, now = new Date() } = {}) {
  const cfg = config(acc);
  if (!force) {
    const status = tickOnlyState(acc, cfg, now);
    if (!status.due) return status;
  }
  if (!cfg.friends.length) {
    return { ok: false, error: '还没有配置自动已读好友', state: tickOnlyState(acc, cfg, now).state };
  }
  return runCheck(acc, cfg, now);
}

module.exports = {
  DEFAULT_MIN_MIN,
  DEFAULT_MAX_MIN,
  DEFAULT_WINDOW_START,
  DEFAULT_WINDOW_END,
  DEFAULT_WINDOW_INTERVAL_MIN,
  MIN_MIN_MIN,
  MAX_MIN_MIN,
  POLL_MS,
  config,
  configKey,
  state,
  clearState,
  view,
  nextCheckAt,
  inWindow,
  tick,
  runCheck,
};
