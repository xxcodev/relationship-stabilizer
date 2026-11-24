/**
 * @file Process supervision helpers for launchd / systemd (status + restart), with graceful degradation.
 */
// Service supervision helpers. Platform specific, but every call degrades to a no-op
// with a reason instead of throwing.
const { execFileSync } = require('child_process');
const env = require('./env');

const LABEL = process.env.SERVICE_LABEL || 'com.dsh.douyin-forwarder';

function schedulerStatus() {
  if (env.platform === 'darwin') {
    try {
      const out = execFileSync('launchctl', ['print', `gui/${process.getuid()}/${LABEL}`], {
        encoding: 'utf8',
        timeout: 8000,
      });
      return { running: /state = running/.test(out), detail: (out.match(/pid = (\d+)/) || [])[1] || null, kind: 'launchd' };
    } catch (e) {
      return { running: false, detail: 'not loaded', kind: 'launchd' };
    }
  }
  if (env.platform === 'linux') {
    try {
      const out = execFileSync('systemctl', ['--user', 'is-active', 'douyin-forwarder'], { encoding: 'utf8', timeout: 8000 }).trim();
      return { running: out === 'active', detail: out, kind: 'systemd' };
    } catch (e) {
      return { running: false, detail: 'not loaded', kind: 'systemd' };
    }
  }
  return { running: null, detail: 'unsupported platform', kind: 'none' };
}

function restartScheduler() {
  if (env.platform === 'darwin') {
    try {
      execFileSync('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${LABEL}`], { timeout: 15000 });
      return { ok: true, kind: 'launchd' };
    } catch (e) {
      return { ok: false, kind: 'launchd', error: e.message.split('\n')[0] };
    }
  }
  if (env.platform === 'linux') {
    try {
      execFileSync('systemctl', ['--user', 'restart', 'douyin-forwarder'], { timeout: 15000 });
      return { ok: true, kind: 'systemd' };
    } catch (e) {
      return { ok: false, kind: 'systemd', error: e.message.split('\n')[0] };
    }
  }
  return { ok: false, kind: 'none', error: 'restart this process manually' };
}

async function browserStatus(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/state`, { signal: AbortSignal.timeout(3500) });
    const d = await r.json();
    const title = d.title || '';
    const challenge = !!d.challenge || /验证码中间页|请完成下列验证|点击两个形状相同的物体/.test(title);
    return { up: true, challenge, title, loggedIn: !!d.loggedIn, url: d.url || '' };
  } catch (e) {
    return { up: false, challenge: false };
  }
}

module.exports = { schedulerStatus, restartScheduler, browserStatus, LABEL };
