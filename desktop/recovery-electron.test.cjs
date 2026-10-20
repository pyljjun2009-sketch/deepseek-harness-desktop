const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { finished } = require('node:stream/promises');
const { createPackageWithOptions } = require('@electron/asar');

const run = promisify(execFile);
const manifestName = '.dsh-recovery-manifest.json';

test('real Electron snapshots physical ASAR bytes and unpacked closure without disabling virtual ASAR support',
  { timeout: 30000 }, async t => {
    // Never run the installed or release candidate application: use only the
    // existing development Electron in Node mode and a tiny, owned fixture.
    const electron = require('electron');
    const expected = path.resolve(__dirname, '..', 'node_modules', 'electron', 'dist',
      process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin'
        ? 'Electron.app/Contents/MacOS/Electron' : 'electron');
    assert.equal(path.resolve(electron), expected);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-recovery-electron-'));
    t.after(() => {
      assert.equal(path.dirname(root), os.tmpdir());
      assert(path.basename(root).startsWith('dsh-recovery-electron-'));
      fs.rmSync(root, { recursive: true, force: true });
    });
    const installation = path.join(root, 'install');
    const source = path.join(root, 'source');
    const archive = path.join(installation, 'resources', 'app.asar');
    fs.mkdirSync(path.dirname(archive), { recursive: true });
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(installation, 'DeepSeekHarness.exe'), 'Fixture executable, never launched.');
    fs.writeFileSync(path.join(source, 'package.json'), '{"name":"physical-asar-fixture","version":"1.0.0"}');
    fs.writeFileSync(path.join(source, 'packed.txt'), 'Packed UI asset must remain readable virtually.');
    fs.writeFileSync(path.join(source, 'native.node'), 'Fixture native bytes, never loaded.');
    // The pinned ASAR API resolves after end(), before the writer has finished.
    const writer = await createPackageWithOptions(source, archive, { unpack: 'native.node' });
    await finished(writer);
    const extra = path.join(`${archive}.unpacked`, 'extra', 'support.dat');
    fs.mkdirSync(path.dirname(extra), { recursive: true });
    fs.writeFileSync(extra, 'Physical extra file outside the archive header.');
    const child = path.join(root, 'check.cjs');
    fs.writeFileSync(child, `
const assert = require('node:assert/strict');
const path = require('node:path');
const { createHash } = require('node:crypto');
const fs = require('original-fs');
const virtualFs = require('node:fs');
const { DesktopRecovery } = require(process.argv[3]);
const root = process.argv[2];
const installation = path.join(root, 'install');
const archive = path.join(installation, 'resources', 'app.asar');
const beforeNoAsar = process.noAsar;
const digest = body => createHash('sha256').update(body).digest('hex');
const manifestName = ${JSON.stringify(manifestName)};
(async () => {
  assert(process.versions.electron, 'The regression must execute in real Electron');
  assert.equal(virtualFs.statSync(archive).isFile(), false, 'The ASAR virtualization prerequisite must be active');
  assert.equal(fs.statSync(archive).isFile(), true);
  const original = fs.readFileSync(archive);
  const recovery = new DesktopRecovery(path.join(root, 'data'), '0.5.0', installation);
  await recovery.prepare();
  assert.equal(await recovery.healthy(), true);
  const cache = path.join(recovery.root, 'stable-releases', '0.5.0');
  const cachedArchive = path.join(cache, 'resources', 'app.asar');
  assert.equal(fs.statSync(cachedArchive).isFile(), true);
  assert.deepEqual(fs.readFileSync(cachedArchive), original);
  const manifest = JSON.parse(fs.readFileSync(path.join(cache, manifestName), 'utf8'));
  const entries = new Map(manifest.entries.map(entry => [entry.path, entry]));
  assert.deepEqual(entries.get('resources/app.asar'), {
    path: 'resources/app.asar', type: 'file', size: original.length, sha256: digest(original)
  });
  assert.equal([...entries.keys()].some(name => name.startsWith('resources/app.asar/')), false);
  for (const relative of ['resources/app.asar.unpacked/native.node', 'resources/app.asar.unpacked/extra/support.dat']) {
    const body = fs.readFileSync(path.join(installation, relative));
    assert.deepEqual(entries.get(relative), { path: relative, type: 'file', size: body.length, sha256: digest(body) });
    assert.deepEqual(fs.readFileSync(path.join(cache, relative)), body);
  }
  assert.equal(recovery.fallbackRelease().executable, path.join(cache, 'DeepSeekHarness.exe'));
  // Both async revalidation and sync fallback verification must use physical fs.
  assert.equal(await recovery.healthy(), true);
  const candidate = new DesktopRecovery(recovery.root, '0.6.0', installation);
  await candidate.prepare();
  candidate.failure(); candidate.failure();
  const decision = candidate.failure();
  assert.equal(decision.action, 'fallback');
  assert.equal(decision.executable, path.join(cache, 'DeepSeekHarness.exe'));
  assert.equal(candidate.state.active, '0.5.0');
  assert.equal(candidate.state.home, recovery.state.home);
  assert.equal(await new DesktopRecovery(recovery.root, '0.6.0', installation).prepare(), decision.executable);
  const changed = Buffer.from(original); changed[changed.length - 1] ^= 1;
  fs.writeFileSync(cachedArchive, changed);
  assert.equal(recovery.fallbackRelease(), undefined, 'Same-length physical archive tampering must fail closed');
  fs.writeFileSync(cachedArchive, original);
  assert(recovery.fallbackRelease());
  const cachedExtra = path.join(cache, 'resources', 'app.asar.unpacked', 'extra', 'support.dat');
  const extraBody = fs.readFileSync(cachedExtra);
  fs.writeFileSync(cachedExtra, 'Damaged physical extra');
  assert.equal(recovery.fallbackRelease(), undefined, 'Unpacked extra corruption must fail closed');
  fs.writeFileSync(cachedExtra, extraBody);
  assert(recovery.fallbackRelease());
  const injected = path.join(cache, 'resources', 'app.asar.unpacked', 'unexpected.dll');
  fs.writeFileSync(injected, 'Unexpected physical file');
  assert.equal(recovery.fallbackRelease(), undefined, 'Unexpected unpacked file must fail closed');
  fs.unlinkSync(injected);
  assert(recovery.fallbackRelease());
  assert.equal(process.noAsar, beforeNoAsar, 'Recovery must not globally disable ASAR support');
  assert.equal(virtualFs.readFileSync(path.join(archive, 'packed.txt'), 'utf8'), 'Packed UI asset must remain readable virtually.');
  console.log(JSON.stringify({ electron: process.versions.electron, physicalArchive: true, pairedFallback: true, tamperingRejected: true, virtualSupportRetained: true }));
})().catch(() => { console.error('ELECTRON_RECOVERY_REGRESSION_FAILED'); process.exitCode = 1; });
`);
    const result = await run(electron, [child, root, path.join(__dirname, 'recovery.cjs')], {
      windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 20000, maxBuffer: 65536
    });
    const summary = JSON.parse(result.stdout.trim());
    assert.match(summary.electron, /^44\./);
    assert.deepEqual({ ...summary, electron: undefined }, {
      electron: undefined, physicalArchive: true, pairedFallback: true, tamperingRejected: true, virtualSupportRetained: true
    });
  });
