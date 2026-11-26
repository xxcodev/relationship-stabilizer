/**
 * @file Pure-API session freshness policy and browser hand-off helpers.
 *
 * The session export needs exclusive use of the Chrome profile. These helpers decide when a
 * refresh is due and close a running browser-server (viewer or leftover process) before the
 * export starts, so a long-lived browser cannot block refresh forever.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const DEFAULT_BEFORE_HOURS = 2;

/** True when the session is missing, invalid, or within `beforeHours` of expiry. */
function needsRefresh(state, { maxAgeHours = 12, beforeHours = DEFAULT_BEFORE_HOURS } = {}) {
  if (!state) return true;
  if (!state.valid) return true;
  const age = Number(state.ageHours);
  const current = Number.isFinite(age) ? age : 0;
  const max = Number.isFinite(Number(maxAgeHours)) ? Number(maxAgeHours) : 12;
  const before = Number.isFinite(Number(beforeHours)) ? Number(beforeHours) : DEFAULT_BEFORE_HOURS;
  return max - current <= before;
}

async function isBrowserUp(port, { fetchImpl = global.fetch, timeoutMs = 2000 } = {}) {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/state`, { signal: AbortSignal.timeout(timeoutMs) });
    return !!(res && res.ok);
  } catch (e) {
    return false;
  }
}

/**
 * Close the account's browser-server so the export can own the Chrome profile.
 * Returns true when the port is free (including when it was never up).
 */
async function closeBrowser(port, { fetchImpl = global.fetch, attempts = 40, intervalMs = 250 } = {}) {
  if (!(await isBrowserUp(port, { fetchImpl }))) return true;
  try {
    await fetchImpl(`http://127.0.0.1:${port}/quit`, {
      method: 'POST',
      signal: AbortSignal.timeout(3000),
    });
  } catch (e) {
    // The server may exit before it can reply.
  }
  for (let i = 0; i < attempts; i++) {
    await sleep(intervalMs);
    if (!(await isBrowserUp(port, { fetchImpl }))) {
      // Give Chrome a moment to release the profile's singleton lock.
      await sleep(300);
      return true;
    }
  }
  return false;
}

module.exports = { DEFAULT_BEFORE_HOURS, needsRefresh, isBrowserUp, closeBrowser };
