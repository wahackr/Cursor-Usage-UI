const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeUsage, readCachedSnapshot } = require('../src/cursor-client.cjs');

test('normalizes the live Cursor quota snapshot', () => {
  const result = normalizeUsage({
    source: 'live',
    planType: 'pro',
    billingCycleEnd: '2000000',
    planUsage: {
      totalPercentUsed: 30,
      autoPercentUsed: 12,
      apiPercentUsed: 46,
      limit: 40000,
      remaining: 28000
    }
  }, 1000);
  assert.equal(result.planType, 'Pro');
  assert.equal(result.primary.usedPercent, 30);
  assert.equal(result.primary.resetsAt, 2_000_000);
  assert.equal(result.secondary.usedPercent, 12);
  assert.equal(result.resetCredits, 46);
  assert.match(result.credits.balance, /\$/);
});

test('clamps usage percentages', () => {
  const result = normalizeUsage({
    planUsage: {
      totalPercentUsed: 140,
      autoPercentUsed: -5,
      apiPercentUsed: 0
    }
  });
  assert.equal(result.primary.usedPercent, 100);
  assert.equal(result.secondary.usedPercent, 0);
});

test('rejects an empty response', () => {
  assert.throws(() => normalizeUsage({}), /usage snapshot/);
});

test('reads a cached snapshot as an offline fallback', () => {
  const cacheFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-usage-')), 'usage-cache.json');
  fs.writeFileSync(cacheFile, JSON.stringify({
    cachedAt: 42,
    planType: 'pro',
    billingCycleEnd: '3000',
    planUsage: {
      totalPercentUsed: 44,
      autoPercentUsed: 21,
      apiPercentUsed: 8,
      limit: 10000,
      remaining: 5600
    }
  }));
  const usage = readCachedSnapshot(cacheFile);
  assert.equal(usage.source, 'local-cache');
  assert.equal(usage.primary.usedPercent, 44);
  fs.rmSync(path.dirname(cacheFile), { recursive: true });
});