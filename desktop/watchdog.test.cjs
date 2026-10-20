const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { monitor } = require('./watchdog.cjs');
const { DesktopRecovery } = require('./recovery.cjs');

test('watchdog rejects invalid ownership and control paths', async () => {
  await assert.rejects(monitor({pid: -1, token:'bad'}), /owner/);
  await assert.rejects(monitor({pid: 999999999, token:randomUUID(), root:'C:\\test', control:'C:\\outside'}), /storage/);
});

test('normal exit marker prevents watchdog recovery', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-watchdog-'));
  t.after(() => fs.rmSync(root, { recursive:true, force:true }));
  fs.mkdirSync(path.join(root, 'official-recovery'));
  const token = randomUUID(); const control = path.join(root, 'official-recovery', 'test.control');
  fs.writeFileSync(control, token);
  await monitor({pid:999999999, token, control, root, version:'0.5.0', executable:path.join(root, 'DeepSeekHarness.exe')});
  assert.equal(fs.existsSync(path.join(root, 'official-recovery', 'state.json')), false);
});

test('third unclean exit without stable snapshot does not spawn another process', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-watchdog-'));
  t.after(() => fs.rmSync(root, { recursive:true, force:true }));
  const executable = path.join(root, 'install', 'DeepSeekHarness.exe');
  const recovery = new DesktopRecovery(root, '0.5.0', path.dirname(executable)); await recovery.prepare();
  recovery.failure(); recovery.failure();
  await monitor({pid:999999999, token:randomUUID(), control:path.join(root, 'official-recovery', 'missing.control'),
    root, version:'0.5.0', executable});
  assert.equal(new DesktopRecovery(root, '0.5.0', path.dirname(executable)).state.failures, 3);
});

async function restartFixture(t, stable = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-watchdog-launch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, 'data'); const installation = path.join(root, 'install');
  fs.mkdirSync(installation); const executable = path.join(installation, 'DeepSeekHarness.exe');
  fs.writeFileSync(executable, 'fixture only: never execute');
  if (stable) {
    const previous = new DesktopRecovery(data, '0.5.0', installation);
    await previous.prepare(); await previous.healthy();
  }
  const current = new DesktopRecovery(data, '0.6.0', installation); await current.prepare();
  const token = randomUUID();
  return {
    root, current, executable,
    options: { pid: 999999999, token, control: path.join(data, 'official-recovery', `watchdog-${token}.control`),
      root: data, version: '0.6.0', executable }
  };
}

function fakeSpawn(outcome) {
  const calls = [];
  const spawnChild = (executable, args, options) => {
    const child = new EventEmitter();
    const call = { executable, args, options, child, unref: false, signal: undefined };
    calls.push(call);
    child.unref = () => { assert.equal(call.signal, 'spawn'); call.unref = true; };
    child.kill = () => { call.killed = true; };
    queueMicrotask(() => {
      call.signal = outcome(call, calls.length);
      if (call.signal === 'spawn') child.emit('spawn');
      else { const error = new Error('simulated OS launch failure'); error.code = 'ENOENT'; child.emit('error', error); }
    });
    return child;
  };
  return { spawnChild, calls };
}

test('a valid normal exit marker stops monitoring while the owner is still alive', async t => {
  const f = await restartFixture(t, false);
  fs.writeFileSync(f.options.control, f.options.token);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let alive = true;
  const probe = t.mock.method(process, 'kill', (pid, signal) => {
    assert.equal(pid, f.options.pid); assert.equal(signal, 0);
    if (!alive) throw new Error('simulated missing owner');
    return true;
  });
  const mock = fakeSpawn(() => 'spawn');
  let settled = false;
  const pending = monitor(f.options, mock.spawnChild).then(() => { settled = true; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, true);
    assert.equal(probe.mock.callCount(), 0);
    assert.equal(mock.calls.length, 0);
    assert.equal(f.current.read().failures, 0);
  } finally {
    alive = false; t.mock.timers.tick(2000); await pending;
  }
});

test('a normal exit marker received during a live-owner poll stops the next probe', async t => {
  const f = await restartFixture(t, false);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let alive = true;
  const probe = t.mock.method(process, 'kill', (pid, signal) => {
    assert.equal(pid, f.options.pid); assert.equal(signal, 0);
    if (!alive) throw new Error('simulated missing owner');
    return true;
  });
  const mock = fakeSpawn(() => 'spawn');
  let settled = false;
  const pending = monitor(f.options, mock.spawnChild).then(() => { settled = true; });
  try {
    assert.equal(probe.mock.callCount(), 1);
    t.mock.timers.tick(1999);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    fs.writeFileSync(f.options.control, f.options.token);
    t.mock.timers.tick(1);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, true);
    assert.equal(probe.mock.callCount(), 1);
    assert.deepEqual(probe.mock.calls.map(call => call.arguments), [[f.options.pid, 0]]);
    assert.equal(mock.calls.length, 0);
    assert.equal(f.current.read().failures, 0);
  } finally {
    alive = false; t.mock.timers.tick(2000); await pending;
  }
});

test('an incorrect normal exit token does not suppress unclean-exit recovery', async t => {
  const f = await restartFixture(t, false);
  fs.writeFileSync(f.options.control, randomUUID());
  const probe = t.mock.method(process, 'kill', (pid, signal) => {
    assert.equal(pid, f.options.pid); assert.equal(signal, 0);
    throw new Error('simulated missing owner');
  });
  const mock = fakeSpawn(() => 'spawn');
  await monitor(f.options, mock.spawnChild);
  assert.equal(probe.mock.callCount(), 1);
  assert.deepEqual(probe.mock.calls.map(call => call.arguments), [[f.options.pid, 0]]);
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0].unref, true);
  assert.equal(f.current.read().failures, 1);
});

test('missing current executable advances bounded failures and starts only a fully verified fallback', async t => {
  const f = await restartFixture(t); fs.unlinkSync(f.executable);
  const mock = fakeSpawn(call => call.executable === f.executable ? 'error' : 'spawn');
  await monitor(f.options, mock.spawnChild);
  assert.equal(mock.calls.length, 3);
  assert.equal(mock.calls[0].unref, false); assert.equal(mock.calls[1].unref, false); assert.equal(mock.calls[2].unref, true);
  assert.equal(mock.calls[0].executable, f.executable); assert.equal(mock.calls[1].executable, f.executable);
  assert.equal(mock.calls[2].executable, path.join(f.options.root, 'stable-releases', '0.5.0', 'DeepSeekHarness.exe'));
  assert.equal(mock.calls[1].options.env.DSH_COMMUNITY_RESET_PLUGINS, '1');
  assert.equal(mock.calls[2].options.env.DSH_COMMUNITY_RESET_PLUGINS, undefined);
  assert.equal(mock.calls[2].options.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(f.current.read().active, '0.5.0');
  assert.equal(f.current.read().rejected, '0.6.0');
});

test('successful launch exits after spawn, without speculative extra recovery attempts', async t => {
  const f = await restartFixture(t); const mock = fakeSpawn(() => 'spawn');
  await monitor(f.options, mock.spawnChild);
  assert.equal(mock.calls.length, 1); assert.equal(mock.calls[0].unref, true);
  assert.equal(f.current.read().failures, 1);
  assert.equal(mock.calls[0].options.detached, true); assert.equal(mock.calls[0].options.windowsHide, true);
  assert.equal(mock.calls[0].options.stdio, 'ignore');
});

test('when both current and cached installations cannot launch, record cached failure and stop', async t => {
  const f = await restartFixture(t); const mock = fakeSpawn(() => 'error');
  await monitor(f.options, mock.spawnChild);
  assert.equal(mock.calls.length, 3);
  assert.equal(mock.calls.some(call => call.unref), false);
  assert.equal(f.current.read().active, '0.5.0');
  assert.equal(f.current.read().failures, 1);
  for (const call of mock.calls) assert.equal(call.child.listenerCount('error'), 1); // late errors remain harmless
});

test('without a verified fallback, launch errors stop instead of repeatedly spawning the missing installation', async t => {
  const f = await restartFixture(t, false); const mock = fakeSpawn(() => 'error');
  await monitor(f.options, mock.spawnChild);
  assert.equal(mock.calls.length, 2);
  assert.equal(f.current.read().failures, 3);
});

test('damaged cache is never launched even after both current-installation attempts fail', async t => {
  const f = await restartFixture(t);
  fs.appendFileSync(path.join(f.options.root, 'stable-releases', '0.5.0', 'DeepSeekHarness.exe'), 'damage');
  const mock = fakeSpawn(() => 'error'); await monitor(f.options, mock.spawnChild);
  assert.equal(mock.calls.length, 2);
  assert.equal(mock.calls.every(call => call.executable === f.executable), true);
  assert.equal(f.current.read().active, '0.6.0'); assert.equal(f.current.read().failures, 3);
});

test('synchronous spawn failures are caught and still advance to the verified fallback', async t => {
  const f = await restartFixture(t); const calls = [];
  const successful = fakeSpawn(() => 'spawn');
  await monitor(f.options, (executable, args, options) => {
    calls.push(executable);
    if (executable === f.executable) throw new Error('simulated synchronous spawn failure');
    return successful.spawnChild(executable, args, options);
  });
  assert.equal(calls.length, 3); assert.equal(successful.calls.length, 1); assert.equal(successful.calls[0].unref, true);
});

test('a stale inherited plugin-reset flag does not reach retry or fallback', async t => {
  const f = await restartFixture(t);
  const previous = process.env.DSH_COMMUNITY_RESET_PLUGINS;
  process.env.DSH_COMMUNITY_RESET_PLUGINS = '1';
  try {
    const mock = fakeSpawn(call => call.executable === f.executable ? 'error' : 'spawn');
    await monitor(f.options, mock.spawnChild);
    assert.equal(mock.calls[0].options.env.DSH_COMMUNITY_RESET_PLUGINS, undefined);
    assert.equal(mock.calls[1].options.env.DSH_COMMUNITY_RESET_PLUGINS, '1');
    assert.equal(mock.calls[2].options.env.DSH_COMMUNITY_RESET_PLUGINS, undefined);
  } finally {
    if (previous === undefined) delete process.env.DSH_COMMUNITY_RESET_PLUGINS;
    else process.env.DSH_COMMUNITY_RESET_PLUGINS = previous;
  }
});

test('late child error after successful spawn remains handled without starting another process', async t => {
  const f = await restartFixture(t); const mock = fakeSpawn(() => 'spawn');
  await monitor(f.options, mock.spawnChild);
  assert.doesNotThrow(() => mock.calls[0].child.emit('error', new Error('simulated late child error')));
  assert.doesNotThrow(() => mock.calls[0].child.emit('error', new Error('simulated second late child error')));
  assert.equal(mock.calls.length, 1);
});

test('spawn with no success or error event times out, stops its own children and remains bounded', async t => {
  const f = await restartFixture(t); const calls = [];
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = monitor(f.options, (executable, args, options) => {
    const child = new EventEmitter(); const call = { executable, args, options, child, killed: false, unref: false };
    child.kill = () => { call.killed = true; }; child.unref = () => { call.unref = true; };
    calls.push(call); return child;
  });
  for (let i = 0; i < 3; i++) {
    assert.equal(calls.length, i + 1);
    t.mock.timers.tick(10000);
    await new Promise(resolve => setImmediate(resolve));
  }
  await pending;
  assert.equal(calls.length, 3); assert.equal(calls.every(call => call.killed), true);
  assert.equal(calls.some(call => call.unref), false);
  assert.equal(f.current.read().active, '0.5.0'); assert.equal(f.current.read().failures, 1);
});
