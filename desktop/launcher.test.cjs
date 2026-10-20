const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { HealthWindow } = require('./health-window.cjs');

const launcherSource = fs.readFileSync(path.join(__dirname, 'launcher.cjs'), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; }

function harness(t, { lock = true, packaged = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-launcher-life-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ctx = { root, order: [], timers: new Map(), snapshots: [], promotions: 0, failures: 0,
    probes: 0, relaunches: [], exits: [], spawns: [], messages: [], decisions: [], bootstrap: deferred() };
  let now = 0; let timerId = 0;
  ctx.advance = async duration => {
    const end = now + duration;
    for (;;) {
      const next = [...ctx.timers.entries()].filter(([, timer]) => timer.due <= end).sort((left, right) => left[1].due - right[1].due)[0];
      if (!next) break;
      now = next[1].due; ctx.timers.delete(next[0]);
      await next[1].callback(); await flush();
    }
    now = end;
  };
  class ClockHealth extends HealthWindow {
    record(ok) { super.record(ok, now); }
    healthy() { return super.healthy(now); }
  }
  class RecoveryMock {
    constructor(data, version, installation) { ctx.recovery = this; this.root = data; this.version = version; this.installation = installation; }
    prepare() {
      return ctx.bootstrap.promise.then(result => {
        // Mirror the real recovery prepare's owned-directory setup, without reading any existing state.
        fs.mkdirSync(path.join(this.root, 'official-recovery'), { recursive: true });
        fs.mkdirSync(this.home(), { recursive: true });
        return result;
      });
    }
    home() { return path.join(this.root, 'official-homes', 'fixture'); }
    failure() { ctx.failures++; return ctx.decisions.shift() ?? { action: 'retry' }; }
    healthy(stillHealthy) {
      const pending = deferred();
      ctx.snapshots.push({ stillHealthy, complete() {
        const success = stillHealthy(); if (success) ctx.promotions++;
        pending.resolve(success); return success;
      } });
      return pending.promise;
    }
  }
  const app = new EventEmitter();
  Object.assign(app, {
    isPackaged: packaged,
    getPath(name) { assert.equal(name, 'userData'); return path.join(root, 'data'); },
    setPath(name, value) { ctx.order.push(['setPath', name, value]); },
    requestSingleInstanceLock() { ctx.order.push(['lock']); return lock; },
    exit(code) { ctx.exits.push(code); },
    relaunch(options) { ctx.relaunches.push(options); },
    whenReady: () => Promise.resolve(),
    commandLine: { appendSwitch(...args) { ctx.order.push(['switch', ...args]); } }
  });
  const processMock = new EventEmitter();
  Object.assign(processMock, { env: {}, execPath: path.join(root, 'install', 'DeepSeekHarness.exe'),
    resourcesPath: path.join(root, 'resources'), pid: 123456 });
  const document = { url: 'dsh-app://app/', destroyed: false };
  const window = { isDestroyed: () => document.destroyed, isVisible: () => true, getTitle: () => 'fixture',
    webContents: { isDestroyed: () => document.destroyed, getURL: () => document.url } };
  const dependencies = {
    electron: { app, BrowserWindow: { getAllWindows: () => [window] },
      protocol: { registerSchemesAsPrivileged(schemes) { ctx.order.push(['scheme', schemes]); } },
      dialog: { async showMessageBox(value) { ctx.messages.push(value); return { response: 0 }; } } },
    'node:path': path, 'node:fs': fs, 'node:url': require('node:url'), 'node:crypto': require('node:crypto'),
    './recovery.cjs': { DesktopRecovery: RecoveryMock }, './health-window.cjs': { HealthWindow: ClockHealth },
    '../package.json': { version: '0.5.0' },
    'node:child_process': { spawn(executable, args, options) {
      const child = new EventEmitter(); const call = { executable, args, options, child, unref: false };
      child.unref = () => { call.unref = true; }; ctx.spawns.push(call); return child;
    } }
  };
  const sandbox = {
    process: processMock, __dirname,
    require(name) { if (!Object.hasOwn(dependencies, name)) throw new Error('Unexpected launcher dependency in mock'); return dependencies[name]; },
    console: { error(message) { ctx.messages.push(message); } },
    setTimeout(callback, delay) { const id = ++timerId; ctx.timers.set(id, { callback, due: now + delay }); return id; },
    clearTimeout(id) { ctx.timers.delete(id); }
  };
  // Dynamic import is deliberately rejected inside the VM: no real official/legacy application can load.
  const script = new vm.Script(launcherSource, { filename: path.join(__dirname, 'launcher.cjs'),
    importModuleDynamically: () => Promise.reject(new Error('Mock official Desktop import intentionally unavailable')) });
  script.runInNewContext(sandbox);
  Object.assign(ctx, { app, process: processMock, document });
  ctx.ready = (probe = async () => { ctx.probes++; return true; }, unhealthy = () => {}) => processMock.emit('community:ready', probe, unhealthy);
  return ctx;
}

test('userData selection precedes the single-instance lock and enforces Chinese plus immutable Python runtime', t => {
  const ctx = harness(t);
  assert.equal(ctx.order[0][0], 'setPath'); assert.equal(ctx.order[1][0], 'lock');
  assert.equal(ctx.order.some(entry => entry[0] === 'switch' && entry[1] === 'lang' && entry[2] === 'zh-CN'), true);
  assert.equal(ctx.process.env.PYTHONDONTWRITEBYTECODE, '1');
  assert.equal(ctx.process.env.DSH_HOME, undefined);
  assert.equal(ctx.spawns.length, 0);
});

test('single-instance loser exits without preparing data, starting a watchdog or registering recovery handlers', t => {
  const ctx = harness(t, { lock: false });
  assert.deepEqual(ctx.exits, [0]); assert.equal(ctx.recovery, undefined);
  assert.equal(ctx.spawns.length, 0); assert.equal(ctx.process.listenerCount('community:ready'), 0);
  assert.equal(ctx.order.some(entry => entry[0] === 'scheme'), false);
});

test('privileged app scheme is registered synchronously before asynchronous recovery completes', t => {
  const ctx = harness(t);
  const registration = ctx.order.find(entry => entry[0] === 'scheme');
  assert.equal(registration[1].length, 1);
  assert.equal(registration[1][0].scheme, 'dsh-app');
  assert.deepEqual(Object.keys(registration[1][0].privileges).sort(),
    ['codeCache', 'corsEnabled', 'secure', 'standard', 'stream', 'supportFetchAPI']);
  assert.equal(Object.values(registration[1][0].privileges).every(value => value === true), true);
  assert.equal(ctx.process.env.DSH_HOME, undefined);
  let acknowledged = false;
  ctx.process.emit('community:scheme-registered', () => { acknowledged = true; });
  assert.equal(acknowledged, true);
});

test('continuous HTTP sampling continues throughout an asynchronous snapshot and promotes only once', async t => {
  const ctx = harness(t); ctx.ready(); await flush();
  await ctx.advance(45000);
  assert.equal(ctx.snapshots.length, 1); assert.equal(ctx.promotions, 0);
  const probesAtCopy = ctx.probes;
  await ctx.advance(20000);
  assert.ok(ctx.probes > probesAtCopy); assert.equal(ctx.snapshots.length, 1);
  assert.equal(ctx.snapshots[0].complete(), true); await flush();
  await ctx.advance(10000);
  assert.equal(ctx.promotions, 1); assert.equal(ctx.snapshots.length, 1);
});

test('fatal pending immediately invalidates an in-flight snapshot and removes its future health timer', async t => {
  const ctx = harness(t); ctx.ready(); await flush(); await ctx.advance(45000);
  ctx.process.emit('community:pending');
  assert.equal(ctx.timers.size, 0); assert.equal(ctx.snapshots[0].stillHealthy(), false);
  assert.equal(ctx.snapshots[0].complete(), false); await flush();
  assert.equal(ctx.promotions, 0);
});

test('pending during an unresolved probe prevents stale completion from recording or rescheduling', async t => {
  const ctx = harness(t); const probe = deferred(); ctx.ready(() => probe.promise);
  ctx.process.emit('community:pending'); probe.resolve(true); await flush();
  assert.equal(ctx.timers.size, 0); assert.equal(ctx.snapshots.length, 0);
  await ctx.advance(60000); assert.equal(ctx.promotions, 0);
});

test('a replacement ready generation cannot be promoted by the previous generation snapshot', async t => {
  const ctx = harness(t); ctx.ready(); await flush(); await ctx.advance(45000);
  const old = ctx.snapshots[0];
  ctx.process.emit('community:pending'); ctx.ready(); await flush();
  assert.equal(old.complete(), false); await flush();
  await ctx.advance(45000);
  assert.equal(ctx.snapshots.length, 2); assert.equal(ctx.snapshots[1].complete(), true); await flush();
  assert.equal(ctx.promotions, 1);
});

test('three failed Host samples request one recovery and cannot schedule an infinite health loop', async t => {
  const ctx = harness(t); let failures = 0; let probes = 0;
  ctx.ready(async () => { probes++; return false; }, () => { failures++; ctx.process.emit('community:pending'); });
  await flush(); await ctx.advance(60000);
  assert.equal(probes, 3); assert.equal(failures, 1); assert.equal(ctx.timers.size, 0);
  assert.equal(ctx.snapshots.length, 0);
});

test('even one failed sample during copying prevents a stale snapshot promotion', async t => {
  const ctx = harness(t); let healthy = true;
  ctx.ready(async () => healthy); await flush(); await ctx.advance(45000);
  healthy = false; await ctx.advance(5000);
  assert.equal(ctx.snapshots[0].complete(), false); await flush();
  assert.equal(ctx.promotions, 0);
});

test('actual quit invalidates a pending copy while a cancelled before-quit does not pretend to have exited', async t => {
  const ctx = harness(t); ctx.ready(); await flush(); await ctx.advance(45000);
  ctx.app.emit('before-quit');
  assert.equal(ctx.snapshots[0].stillHealthy(), true);
  ctx.app.emit('quit');
  assert.equal(ctx.timers.size, 0); assert.equal(ctx.snapshots[0].complete(), false); await flush();
  assert.equal(ctx.promotions, 0);
});

test('community recovery cancels probation and binds the fallback executable without starting another process itself', async t => {
  const ctx = harness(t); ctx.ready(); await flush();
  const executable = path.join(ctx.root, 'verified-stable', 'DeepSeekHarness.exe');
  ctx.decisions.push({ action: 'fallback', executable }); let action;
  ctx.process.emit('community:recover', value => { action = value; });
  assert.equal(action, 'fallback'); assert.equal(ctx.failures, 1);
  assert.equal(ctx.process.env.DSH_COMMUNITY_RELAUNCH_PATH, executable);
  assert.equal(ctx.timers.size, 0); assert.equal(ctx.spawns.length, 0); assert.equal(ctx.relaunches.length, 0);
});

test('bootstrap import failure marks its watchdog clean before the bounded relaunch', async t => {
  const ctx = harness(t); ctx.bootstrap.resolve(undefined); await flush(); await flush();
  assert.equal(ctx.spawns.length, 1); const watchdog = ctx.spawns[0];
  assert.equal(watchdog.options.env.ELECTRON_RUN_AS_NODE, '1'); assert.equal(watchdog.options.windowsHide, true);
  assert.equal(watchdog.unref, true);
  assert.equal(fs.readFileSync(watchdog.args[3], 'utf8'), watchdog.args[2]);
  assert.equal(ctx.failures, 1); assert.equal(ctx.relaunches.length, 1); assert.deepEqual(ctx.exits, [0]);
});

test('prepare-selected fallback relaunches before any new Host or watchdog is started', async t => {
  const ctx = harness(t); const executable = path.join(ctx.root, 'verified-stable', 'DeepSeekHarness.exe');
  ctx.bootstrap.resolve(executable); await flush();
  assert.equal(ctx.spawns.length, 0); assert.equal(ctx.relaunches.length, 1);
  assert.equal(ctx.relaunches[0].execPath, executable); assert.deepEqual(ctx.exits, [0]);
});
