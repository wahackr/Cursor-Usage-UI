const test = require('node:test');
const assert = require('node:assert/strict');
const { looksLikeJwt, unwrapStoredValue } = require('../src/cursor-auth-decrypt.cjs');

test('unwrapStoredValue parses JSON strings from ItemTable', () => {
  assert.equal(unwrapStoredValue('"eyJhbGci.test"'), 'eyJhbGci.test');
  assert.equal(unwrapStoredValue('cursor-safe-storage:v1:abc'), 'cursor-safe-storage:v1:abc');
});

test('looksLikeJwt accepts three-segment tokens', () => {
  assert.equal(looksLikeJwt('eyJhbGci.eyJzdWI.signature'), true);
  assert.equal(looksLikeJwt('cursor-safe-storage:v1:abc'), false);
});