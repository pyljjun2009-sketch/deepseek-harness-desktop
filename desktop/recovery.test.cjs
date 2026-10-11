const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DesktopRecovery, safeId } = require('./recovery.cjs');

function fixture(t, version = '0.5.0') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-official-recovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const install = path.join(root, 'install');
  fs.mkdirSync(install);
  fs.writeFileSync(path.join(install, 'DeepSeekHarness.exe'), 'test executable, never launched');
  return { root, install, create: v => new DesktopRecovery(path.join(root, 'data'), v || version, install) };
}

test('reject traversal and unsafe release identifiers', () => {
  for (const value of ['../x', 'C:\\x', '..', 'x/y', null, '', 'x..y']) assert.equal(safeId(value), false);
  assert.equal(safeId('0.5.0-rc.1'), true);
});

test('bounded retries survive process reconstruction', async t => {
  const f = fixture(t);
  const r = f.create(); await r.prepare();
  assert.equal(r.failure().action, 'retry');
  assert.equal(f.create().failure().action, 'disable-plugins');
  assert.equal(f.create().failure().action, 'manual');
  assert.equal(f.create().failure().action, 'manual');
});

test('atomically recover corrupted state from backup', async t => {
  const f = fixture(t); const r = f.create(); await r.prepare(); r.failure(); r.failure();
  fs.writeFileSync(r.file, '{incomplete');
  assert.equal(f.create().state.failures, 1);
});

test('persist after backup recovery never overwrites the last good backup with a corrupt primary', async t => {
  const f = fixture(t); const r = f.create(); await r.prepare(); r.failure(); r.failure();
  const backup = fs.readFileSync(`${r.file}.bak`, 'utf8');
  for (const damaged of ['{incomplete', JSON.stringify({ ...r.state, home: '../unsafe' })]) {
    fs.writeFileSync(r.file, damaged);
    const recovered = f.create();
    assert.equal(recovered.state.failures, 1);
    recovered.persist();
    assert.equal(fs.readFileSync(`${r.file}.bak`, 'utf8'), backup);
    assert.equal(f.create().state.failures, 1);
  }
});

test('an interrupted recovered primary replacement preserves a readable backup', async t => {
  const f = fixture(t); const r = f.create(); await r.prepare(); r.failure(); r.failure();
  const backup = fs.readFileSync(`${r.file}.bak`, 'utf8');
  fs.writeFileSync(r.file, '{interrupted');
  const recovered = f.create();
  const originalRename = fs.renameSync;
  const rename = t.mock.method(fs, 'renameSync', (source, destination) => {
    if (destination === recovered.file) throw new Error('simulated interrupted primary commit');
    return originalRename(source, destination);
  });
  assert.throws(() => recovered.persist(), /interrupted primary commit/);
  rename.mock.restore();
  assert.equal(fs.readFileSync(`${r.file}.bak`, 'utf8'), backup);
  assert.equal(f.create().state.failures, 1);
});

test('corrupt and malicious metadata cannot select paths outside data root', async t => {
  const f = fixture(t); const r = f.create(); await r.prepare();
  fs.writeFileSync(r.file, JSON.stringify({ ...r.state, home: '../outside' }));
  assert.equal(f.create().state.home, 'home-0.5.0');
  assert.throws(() => r.home('../x'));
});

test('upgrade copies shared product data but never executable profiles', async t => {
  const f = fixture(t); const old = f.create(); await old.prepare(); await old.healthy();
  fs.writeFileSync(path.join(old.home(), 'notes.txt'), 'old');
  fs.mkdirSync(path.join(old.home(), 'profiles')); fs.writeFileSync(path.join(old.home(), 'profiles', 'unsafe.js'), 'plugin');
  const next = f.create('0.6.0'); await next.prepare();
  assert.notEqual(next.home(), old.home());
  assert.equal(fs.readFileSync(path.join(next.home(), 'notes.txt'), 'utf8'), 'old');
  assert.equal(fs.existsSync(path.join(next.home(), 'profiles')), false);
  fs.writeFileSync(path.join(next.home(), 'notes.txt'), 'new');
  assert.equal(fs.readFileSync(path.join(old.home(), 'notes.txt'), 'utf8'), 'old');
});

test('failed candidate rolls back the complete installation and its own data', async t => {
  const f = fixture(t); const old = f.create(); await old.prepare(); await old.healthy();
  const next = f.create('0.6.0'); await next.prepare(); next.failure(); next.failure();
  const decision = next.failure(); assert.equal(decision.action, 'fallback');
  assert.equal(next.state.home, old.state.home); assert.equal(next.state.active, '0.5.0');
  assert.equal(await f.create('0.6.0').prepare(), decision.executable);
  assert.equal(await f.create('0.5.0').prepare(), undefined);
});

test('retain prior stable release after a candidate is promoted', async t => {
  const f = fixture(t); const old = f.create(); await old.prepare(); await old.healthy();
  const next = f.create('0.6.0'); await next.prepare(); await next.healthy();
  assert.equal(next.state.previousStable.version, '0.5.0');
  next.failure(); next.failure(); assert.equal(next.failure().action, 'fallback');
  assert.equal(next.state.active, '0.5.0');
  const restored = f.create(); await restored.prepare(); await restored.healthy();
  assert.equal(restored.state.stable.version, '0.5.0');
  assert.equal(restored.state.previousStable, undefined);
  assert.equal(restored.state.rejected, '0.6.0');
  assert.ok(await f.create('0.6.0').prepare());
});

test('missing fallback executable or home stops retries rather than looping', async t => {
  const f = fixture(t); const old = f.create(); await old.prepare(); await old.healthy();
  const next = f.create('0.6.0'); await next.prepare();
  fs.renameSync(path.join(next.root, 'stable-releases', '0.5.0', 'DeepSeekHarness.exe'), path.join(f.root, 'missing.exe'));
  next.failure(); next.failure(); assert.equal(next.failure().action, 'manual');
});

test('stable snapshot manifest covers every installed file and empty directory', async t => {
  const f = fixture(t); const r = f.create(); await r.prepare();
  fs.mkdirSync(path.join(f.install, 'resources', 'empty'), { recursive: true });
  fs.writeFileSync(path.join(f.install, 'resources', 'app.asar'), 'compiled UI and Host');
  fs.writeFileSync(path.join(f.install, 'Uninstall DeepSeek.exe'), 'installer support');
  await r.healthy();
  const directory = path.join(r.root, 'stable-releases', r.version);
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, '.dsh-recovery-manifest.json'), 'utf8'));
  assert.equal(manifest.version, r.version);
  assert.deepEqual(manifest.entries.map(entry => entry.path), [
    'DeepSeekHarness.exe', 'Uninstall DeepSeek.exe', 'resources', 'resources/app.asar', 'resources/empty'
  ]);
  assert.match(r.state.stable.manifestSha256, /^[a-f0-9]{64}$/);
  assert.ok(r.fallbackRelease());
});

for (const corruption of ['missing-file', 'changed-content', 'extra-file', 'missing-directory', 'changed-manifest']) {
  test(`damaged stable cache cannot be selected by failure or prepare: ${corruption}`, async t => {
    const f = fixture(t); const old = f.create(); await old.prepare();
    fs.mkdirSync(path.join(f.install, 'resources', 'empty'), { recursive: true });
    fs.writeFileSync(path.join(f.install, 'resources', 'app.asar'), 'healthy');
    await old.healthy();
    const next = f.create('0.6.0'); await next.prepare();
    const cache = path.join(old.root, 'stable-releases', '0.5.0');
    if (corruption === 'missing-file') fs.unlinkSync(path.join(cache, 'resources', 'app.asar'));
    if (corruption === 'changed-content') fs.writeFileSync(path.join(cache, 'resources', 'app.asar'), 'damaged');
    if (corruption === 'extra-file') fs.writeFileSync(path.join(cache, 'injected.dll'), 'extra');
    if (corruption === 'missing-directory') fs.rmdirSync(path.join(cache, 'resources', 'empty'));
    if (corruption === 'changed-manifest') fs.appendFileSync(path.join(cache, '.dsh-recovery-manifest.json'), ' ');
    next.failure(); next.failure();
    assert.equal(next.failure().action, 'manual');
    assert.equal(next.state.active, '0.6.0');
    next.state.rejected = next.version; next.persist();
    assert.equal(await f.create('0.6.0').prepare(), undefined);
    assert.equal(next.fallbackRelease(), undefined);
  });
}

test('a damaged preferred cache falls back only to another completely verified release', async t => {
  const f = fixture(t); const previous = f.create(); await previous.prepare(); await previous.healthy();
  const latest = f.create('0.6.0'); await latest.prepare(); await latest.healthy();
  fs.appendFileSync(path.join(latest.root, 'stable-releases', '0.6.0', 'DeepSeekHarness.exe'), 'broken');
  const candidate = f.create('0.7.0'); await candidate.prepare(); candidate.failure(); candidate.failure();
  const decision = candidate.failure();
  assert.equal(decision.action, 'fallback');
  assert.equal(candidate.state.active, '0.5.0');
  assert.equal(candidate.state.home, previous.state.home);
  assert.equal(candidate.state.stable.manifestSha256, previous.state.stable.manifestSha256);
});

test('old cache metadata stays readable but no-manifest caches are not automatic recovery targets', async t => {
  const f = fixture(t); const r = f.create(); await r.prepare(); await r.healthy();
  const cache = path.join(r.root, 'stable-releases', r.version);
  fs.unlinkSync(path.join(cache, '.dsh-recovery-manifest.json'));
  delete r.state.stable.manifestSha256; r.persist();
  const loaded = f.create();
  assert.equal(loaded.state.stable.version, '0.5.0');
  assert.equal(loaded.fallbackRelease(), undefined);
  assert.equal(await loaded.healthy(), true);
  assert.ok(loaded.fallbackRelease());
  const retained = fs.readdirSync(path.dirname(cache)).filter(name => name.startsWith('0.5.0.quarantined-'));
  assert.equal(retained.length, 1);
  assert.equal(fs.existsSync(path.join(path.dirname(cache), retained[0], 'DeepSeekHarness.exe')), true);
});

test('snapshot refuses source links and fallback refuses links even if their bytes match', async t => {
  const f = fixture(t); const r = f.create(); await r.prepare();
  const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'same.dat'), 'matching');
  fs.symlinkSync(outside, path.join(f.install, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(r.healthy(), /symbolic links/);
  assert.equal(r.state.stable, undefined);
  fs.unlinkSync(path.join(f.install, 'linked'));
  fs.mkdirSync(path.join(f.install, 'resources')); fs.writeFileSync(path.join(f.install, 'resources', 'same.dat'), 'matching');
  await r.healthy();
  const resources = path.join(r.root, 'stable-releases', r.version, 'resources');
  fs.renameSync(resources, path.join(f.root, 'original-resources'));
  fs.symlinkSync(outside, resources, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(r.fallbackRelease(), undefined);
  r.failure(); r.failure(); assert.equal(r.failure().action, 'manual');
});

test('verified executable closure cannot restore a missing or symlinked data slot', async t => {
  const f = fixture(t); const r = f.create(); await r.prepare(); await r.healthy();
  const home = r.home();
  fs.renameSync(home, path.join(f.root, 'saved-home'));
  assert.equal(r.fallbackRelease(), undefined);
  fs.symlinkSync(path.join(f.root, 'saved-home'), home, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(r.fallbackRelease(), undefined);
});

test('invalid current cache cannot repair itself by copying the running cache', async t => {
  const f = fixture(t); const r = f.create(); await r.prepare(); await r.healthy();
  const cache = path.join(r.root, 'stable-releases', r.version);
  fs.writeFileSync(path.join(cache, 'extra.dll'), 'untracked');
  const runningCache = new DesktopRecovery(r.root, r.version, cache);
  await assert.rejects(runningCache.healthy(), /cannot repair itself/);
});

test('late snapshot cannot promote a crashed or shutting-down release', async t => {
  const f = fixture(t); const r = f.create(); await r.prepare();
  const pending = r.healthy(); r.failure();
  assert.equal(await pending, false); assert.equal(r.state.stable, undefined);
  assert.equal(await r.healthy(() => false), false);
});

test('failed health generation discards staging without replacing the retained stable cache', async t => {
  const f = fixture(t); const r = f.create(); await r.prepare(); await r.healthy();
  const cache = path.join(r.root, 'stable-releases', r.version);
  fs.unlinkSync(path.join(cache, '.dsh-recovery-manifest.json'));
  const baseline = JSON.stringify(r.state.stable);
  assert.equal(await r.healthy(() => false), false);
  assert.equal(JSON.stringify(r.state.stable), baseline);
  assert.equal(fs.existsSync(path.join(cache, 'DeepSeekHarness.exe')), true);
  assert.equal(fs.readdirSync(path.dirname(cache)).some(name => name.includes('.staging-')), false);
  assert.equal(fs.readdirSync(path.dirname(cache)).some(name => name.includes('.quarantined-')), false);
});

test('legacy managed data is copied without touching original or global home', async t => {
  const f = fixture(t); const r = f.create();
  const legacy = path.join(r.root, 'profile-homes', 'slot-old');
  fs.mkdirSync(legacy, { recursive: true }); fs.writeFileSync(path.join(legacy, 'data.txt'), 'legacy');
  fs.mkdirSync(path.join(r.root, 'recovery')); fs.writeFileSync(path.join(r.root, 'recovery', 'state.json'), JSON.stringify({schemaVersion: 2, activeHomeId:'slot-old'}));
  await r.prepare(); assert.equal(fs.readFileSync(path.join(r.home(), 'data.txt'), 'utf8'), 'legacy');
  assert.equal(fs.readFileSync(path.join(legacy, 'data.txt'), 'utf8'), 'legacy');
});

test('refuse recursive snapshots when user storage is inside installation', async t => {
  const f = fixture(t); const r = new DesktopRecovery(path.join(f.install, 'data'), '0.5.0', f.install);
  await r.prepare(); await assert.rejects(r.healthy(), /outside/);
});

test('stable snapshot repairs a damaged installation even without an older version', async t => {
  const f = fixture(t); const r = f.create(); await r.prepare(); await r.healthy();
  r.failure(); r.failure(); const result = r.failure(); assert.equal(result.action, 'fallback');
  assert.equal(await f.create().prepare(), result.executable);
  const cached = new DesktopRecovery(r.root, '0.5.0', path.dirname(result.executable));
  assert.equal(await cached.prepare(), undefined);
  cached.failure(); cached.failure(); assert.equal(cached.failure().action, 'manual');
});

test('twenty repeated upgrade and rollback cycles retain paired versions and data', async t => {
  const f = fixture(t); const baseline = f.create(); await baseline.prepare(); await baseline.healthy();
  for (let i = 1; i <= 20; i++) {
    const candidate = f.create(`0.6.${i}`); await candidate.prepare(); candidate.failure(); candidate.failure();
    assert.equal(candidate.failure().action, 'fallback'); assert.equal(candidate.state.home, baseline.state.home);
    await f.create().prepare();
  }
});
