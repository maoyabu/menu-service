export const SEASON_LABELS = ['春', '夏', '秋', '冬'];

export function monthToSeason(monthNumber) {
  const m = Number(monthNumber);
  if (!Number.isFinite(m)) return '';
  if ([3, 4, 5].includes(m)) return '春';
  if ([6, 7, 8, 9].includes(m)) return '夏';
  if ([10, 11].includes(m)) return '秋';
  // Default to winter for out-of-range or 12/1/2
  return '冬';
}

export function normalizeSeasonList(val) {
  return (Array.isArray(val) ? val : [val])
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .filter((s) => SEASON_LABELS.includes(s));
}

export function matchesCurrentSeason(seasonList, now = new Date()) {
  const current = monthToSeason(now.getMonth() + 1);
  if (!current) return false;
  const normalized = normalizeSeasonList(seasonList);
  if (!normalized.length) return false;
  return normalized.includes(current);
}
