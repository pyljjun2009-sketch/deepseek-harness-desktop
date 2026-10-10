const { test } = require('node:test');
const assert = require('node:assert/strict');
const { HealthWindow } = require('./health-window.cjs');
test('requires continuous fresh samples throughout probation', () => {
  const window = new HealthWindow(45000, 5000);
  window.record(true, 0);
  assert.equal(window.healthy(45000), false);
  for (let time = 5000; time <= 45000; time += 5000) window.record(true, time);
  assert.equal(window.healthy(45000), true);
  assert.equal(window.healthy(56000), false);
});
test('a single failed sample resets promotion but three failures recover', () => {
  const window = new HealthWindow(10000, 5000);
  window.record(true, 0); window.record(true, 5000); window.record(false, 10000);
  assert.equal(window.healthy(10000), false);
  assert.equal(window.failed(), false);
  window.record(false, 15000); window.record(false, 20000);
  assert.equal(window.failed(), true);
  window.record(true, 25000); window.record(true, 30000); window.record(true, 35000);
  assert.equal(window.failed(), false);
  assert.equal(window.healthy(35000), true);
});
test('a long suspended timer cannot promote a stale backend', () => {
  const window = new HealthWindow(10000, 5000);
  window.record(true, 0); window.record(true, 5000); window.record(true, 60000);
  assert.equal(window.healthy(60000), false);
});
