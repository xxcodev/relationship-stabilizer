/**
 * @file Reads the unified schedule config for an account.
 *
 * The new source of truth is `account_settings.schedulePoints`. Databases written by 0.27 and
 * earlier have no such key, so their config (burst points, or the old daily-total/bands setup)
 * is converted on read. Nothing is written until the user saves the config.
 */
const repos = require('./repos');
const burst = require('./burst');

function legacyRawPoints(acc) {
  return {
    burstPoints: repos.getAccountSetting(acc.id, 'burstPoints', null),
    burstStart: repos.getAccountSetting(acc.id, 'burstStart', null),
    burstCount: repos.getAccountSetting(acc.id, 'burstCount', null),
    bands: repos.listBands(acc.id),
    dailyTotal: repos.getAccountSetting(acc.id, 'dailyTotal', 0),
    mode: repos.getAccountSetting(acc.id, 'scheduleMode', null),
  };
}

/** Raw point list: stored schedulePoints, or a conversion of the previous config. */
function pointsForAccount(acc) {
  const stored = repos.getAccountSetting(acc.id, 'schedulePoints', null);
  if (Array.isArray(stored) && stored.length) return burst.normalizePoints(stored);
  return burst.pointsFromLegacy(legacyRawPoints(acc));
}

/** Normalized schedule for one account (points + shared interval settings). */
function fromAccount(acc) {
  const weekendRaw = repos.getAccountSetting(acc.id, 'weekendRandomEnabled', true);
  return burst.normalizeConfig({
    points: pointsForAccount(acc),
    minSec: repos.getAccountSetting(acc.id, 'burstMinSec', burst.DEFAULTS.minSec),
    maxSec: repos.getAccountSetting(acc.id, 'burstMaxSec', burst.DEFAULTS.maxSec),
    floor: repos.getAccountSetting(acc.id, 'burstDurationFloor', burst.DEFAULTS.floor),
    fallbackSec: repos.getAccountSetting(acc.id, 'burstFallbackSec', burst.DEFAULTS.fallbackSec),
    weekendRandom: !(weekendRaw === false || weekendRaw === 0 || weekendRaw === '0' || weekendRaw === 'false'),
  });
}

module.exports = { legacyRawPoints, pointsForAccount, fromAccount };
