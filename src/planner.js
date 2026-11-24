/**
 * @file Pure scheduling math: turns time bands + totals into concrete send times. No IO, fully unit-tested.
 */
// Pure scheduling math: bands -> concrete times. No IO, no side effects.
const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const toMin = (s) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

// Total governs: when the per-band sums cannot hold the requested total,
// scale the band caps (and floors) proportionally instead of refusing.
function fitBands(bands, totalMin, totalMax) {
  const out = bands.map((b) => ({ ...b }));
  const notes = [];
  if (!(totalMax > 0)) return { bands: out, notes };
  let sumMax = out.reduce((a, b) => a + b.max, 0);
  if (sumMax < totalMax && sumMax > 0) {
    const k = totalMax / sumMax;
    out.forEach((b) => { b.max = Math.max(b.min, Math.round(b.max * k)); });
    let s = out.reduce((a, b) => a + b.max, 0);
    let i = 0;
    while (s < totalMax && i < 500) { out[i % out.length].max++; s++; i++; }
    while (s > totalMax) {
      const idx = out.findIndex((b) => b.max > b.min);
      if (idx < 0) break;
      out[idx].max--;
      s--;
    }
    notes.push(`各时段上限之和 ${sumMax} 容不下总数 ${totalMax}，已按比例放宽到 ${totalMax}`);
  }
  const sumMin = out.reduce((a, b) => a + b.min, 0);
  if (sumMin > totalMin) {
    const k = totalMin / sumMin;
    out.forEach((b) => { b.min = Math.max(0, Math.floor(b.min * k)); });
    let s = out.reduce((a, b) => a + b.min, 0);
    while (s > totalMin) {
      const idx = out.findIndex((b) => b.min > 0);
      if (idx < 0) break;
      out[idx].min--;
      s--;
    }
    out.forEach((b) => { if (b.max < b.min) b.max = b.min; });
    notes.push(`各时段下限之和 ${sumMin} 超过总数下限 ${totalMin}，已按比例收紧`);
  }
  return { bands: out, notes };
}

function normalize(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  let bands = (src.bands || [])
    .map((b) => ({
      name: b.name || '时段',
      from: typeof b.from === 'number' ? b.from : toMin(b.from),
      to: typeof b.to === 'number' ? b.to : toMin(b.to),
      min: Number(b.min),
      max: Number(b.max),
    }))
    .filter((b) => b.from !== null && b.to !== null && b.to > b.from && b.max >= b.min && b.min >= 0);
  if (!bands.length) bands.push({ name: '默认', from: 7 * 60, to: 23 * 60 + 30, min: 5, max: 8 });
  const totalMin = Math.max(0, Number(src.totalMin) || 0);
  const totalMax = Math.max(totalMin, Number(src.totalMax) || 0);
  const fitted = fitBands(bands, totalMin, totalMax);
  bands = fitted.bands;
  return {
    adjustNotes: fitted.notes,
    enabled: src.enabled !== false,
    totalMin,
    totalMax,
    friend: src.friend || '',
    minGap: Math.max(1, Number(src.minGapMinutes) || 5),
    bands,
    windowStart: Math.min(...bands.map((b) => b.from)),
    windowEnd: Math.max(...bands.map((b) => b.to)),
  };
}

function pickCounts(cfg) {
  const bands = cfg.bands;
  const minSum = bands.reduce((a, b) => a + b.min, 0);
  const maxSum = bands.reduce((a, b) => a + b.max, 0);
  let total = cfg.totalMax > 0
    ? cfg.totalMin + Math.floor(Math.random() * (cfg.totalMax - cfg.totalMin + 1))
    : minSum + Math.floor(Math.random() * (maxSum - minSum + 1));
  total = Math.max(minSum, Math.min(maxSum, total));
  const counts = bands.map((b) => b.min);
  let rem = total - minSum;
  while (rem > 0) {
    const eligible = bands.map((_, i) => i).filter((i) => counts[i] < bands[i].max);
    if (!eligible.length) break;
    const weights = eligible.map((i) => bands[i].max - counts[i]);
    const sum = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * sum;
    let pick = eligible[eligible.length - 1];
    for (let k = 0; k < eligible.length; k++) {
      r -= weights[k];
      if (r <= 0) { pick = eligible[k]; break; }
    }
    counts[pick]++;
    rem--;
  }
  return counts;
}

function planBand(band, startMin, minGap, want) {
  if (want <= 0) return [];
  const from = Math.max(band.from, startMin);
  if (from >= band.to - 2) return [];
  const span = band.to - from;
  let t = Array.from({ length: want }, () => from + Math.random() * span).sort((a, b) => a - b);
  for (let i = 1; i < t.length; i++) {
    if (t[i] - t[i - 1] < minGap) t[i] = t[i - 1] + minGap + Math.random() * 10;
  }
  for (let i = t.length - 1; i >= 0; i--) {
    const ceiling = band.to - 1 - (t.length - 1 - i) * minGap;
    if (t[i] > ceiling) t[i] = Math.max(from, ceiling);
  }
  return t.map((x) => Math.round(x)).sort((a, b) => a - b);
}

function planDay(cfg, startMin) {
  const counts = pickCounts(cfg);
  const times = [];
  cfg.bands.forEach((b, i) => times.push(...planBand(b, startMin, cfg.minGap, counts[i])));
  return {
    requested: counts.reduce((a, b) => a + b, 0),
    count: times.length,
    times: times.sort((a, b) => a - b),
    allocation: cfg.bands.map((b, i) => ({ name: b.name, n: counts[i] })),
  };
}

module.exports = { hm, toMin, normalize, fitBands, pickCounts, planBand, planDay };
