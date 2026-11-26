/** Whole-number “% left” from API used-percent (Cursor returns long floats). */
function remainingPercent(usedPercent) {
  if (!Number.isFinite(Number(usedPercent))) return null;
  const used = Math.max(0, Math.min(100, Number(usedPercent)));
  return Math.ceil(100 - used);
}

function ceilPercent(value) {
  if (!Number.isFinite(Number(value))) return null;
  return Math.ceil(Number(value));
}

function formatUsdFromCents(cents) {
  if (!Number.isFinite(Number(cents))) return null;
  return (Math.ceil(Number(cents)) / 100).toFixed(2);
}

module.exports = { ceilPercent, formatUsdFromCents, remainingPercent };