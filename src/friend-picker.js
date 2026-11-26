/**
 * @file Pure helper: pick the friend with the fewest successful sends today.
 *
 * Ties are broken randomly so several fresh friends rotate instead of always hitting the
 * first one. When every friend has already received a message, the next round starts from
 * the least-used friend (the caller decides whether to allow that round).
 */
function chooseFriend(names, counts = {}, random = Math.random, lastFriend = null) {
  const unique = [...new Set(
    (Array.isArray(names) ? names : [])
      .map((name) => String(name == null ? '' : name).trim())
      .filter(Boolean)
  )];
  if (!unique.length) return null;

  const sentToday = (name) => {
    const n = Number(counts[name]);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const min = Math.min(...unique.map(sentToday));
  let pool = unique.filter((name) => sentToday(name) === min);
  // Avoid sending to the same friend twice in a row when another equally-fresh friend exists.
  if (lastFriend && pool.length > 1) {
    const next = pool.filter((name) => name !== lastFriend);
    if (next.length) pool = next;
  }
  const r = Number(random());
  const index = Number.isFinite(r) ? Math.min(pool.length - 1, Math.max(0, Math.floor(r * pool.length))) : 0;
  return pool[index];
}

module.exports = { chooseFriend };
