const test = require('node:test');
const assert = require('node:assert/strict');
const { ceilPercent, formatUsdFromCents, remainingPercent } = require('../src/usage-format.cjs');

test('remaining percent rounds up', () => {
  assert.equal(remainingPercent(46.444), 54);
  assert.equal(remainingPercent(30), 70);
  assert.equal(remainingPercent(100), 0);
  assert.equal(remainingPercent(0), 100);
});

test('ceil percent rounds up for API fields', () => {
  assert.equal(ceilPercent(46.444), 47);
  assert.equal(ceilPercent(0.1), 1);
});