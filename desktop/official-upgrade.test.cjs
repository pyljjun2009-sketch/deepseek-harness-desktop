'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { dirname, join } = require('node:path');
const { tmpdir } = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const upgrade = require('./official-upgrade.cjs');

const bytes = Buffer.from('MZ synthetic upgrade fixture; never executable');
const digest = value => createHash('sha512').update(value).digest('base64');
const artifact = () => ({ interfaceVersion: 1, provider: 'deepseek-official-desktop', platform: 'win32', arch: 'x64',
  version: '0.2.1-rc.2', url: 'https://download.deepseek.com/dsh-desk/bin/win-x64/deepseek-harness-0.2.1-rc.2-win-x64.exe',
  sha512: digest(bytes), size: bytes.length, releaseDate: '2026-10-17T09:22:23.750Z' });
const wire = (entry = artifact()) => JSON.stringify({ version: entry.version,
  files: [{ url: entry.url, sha512: entry.sha512, size: entry.size }],
  path: entry.url, sha512: entry.sha512, releaseDate: entry.releaseDate });
const response = body => new Response(body, { status: 200 });
async function isolated(run) {
  const parent = await fs.realpath(tmpdir());
  const root = await fs.mkdtemp(join(parent, 'dsh-upgrade-unit-'));
  try { return await run(root); }
  finally {
    assert.equal(dirname(root), parent); assert.equal(await fs.realpath(root), root);
    assert.equal((await fs.lstat(root)).isSymbolicLink(), false);
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('official feed adapter consumes JSON/YAML metadata without enabling installation', () => {
  assert.deepEqual(upgrade.parseOfficialFeed(wire()), artifact());
  const plan = upgrade.planOfficialUpgrade(artifact(), '0.2.0-rc.2');
  assert.equal(plan.interfaceVersion, 1); assert.equal(plan.operation, 'prepare-community-rebuild');
  assert.equal(plan.automaticInstallAllowed, false); assert.equal(plan.userDataMigrationAllowed, false);
  assert.equal(plan.requiresMatchingOfficialSource, true); assert.equal(plan.requiresCompleteRuntime, true);
  assert.ok(plan.requiredQualifications.includes('native-manual-acceptance'));
});

for (const [key, value] of [ ['interfaceVersion', 2], ['provider', 'foreign'], ['platform', 'linux'], ['arch', 'arm64'],
  ['version', 'v0.2.1-rc.2'], ['version', ['0.2.1-rc.2']], ['version', '0.2.1-rc.2/../0.6'],
  ['size', 0], ['size', -1], ['size', '123'], ['size', 1024 ** 3 + 1], ['size', 0.5],
  ['sha512', 'a'.repeat(88)], ['sha512', 'a'.repeat(86) + '=='], ['sha512', digest(bytes).slice(0, -1)],
  ['releaseDate', 'tomorrow'], ['releaseDate', '2026-10-17'], ['releaseDate', '2026-10-17T09:22:23Z'] ]) {
  test(`wire descriptors reject invalid ${key}: ${JSON.stringify(value)}`, () => {
    assert.throws(() => upgrade.validateOfficialArtifact({ ...artifact(), [key]: value }), upgrade.OfficialUpgradeError);
  });
}
for (const url of ['http://download.deepseek.com/', 'https://127.0.0.1/package.exe', 'file:///C:/package.exe',
  'https://download.deepseek.com.evil.invalid/package.exe', 'https://user:secret@download.deepseek.com/package.exe',
  artifact().url + '?token=synthetic', artifact().url + '#fragment', artifact().url.replace('/bin/', '/../bin/'),
  artifact().url.replace('/win-x64/', '/win-arm64/'), artifact().url.replace('https:', 'javascript:'),
  artifact().url.replace('deepseek.com/', 'deepseek.com:443/'), artifact().url.replace('0.2.1-rc.2', '0.2.0-rc.2')]) {
  test(`untrusted artifact address is rejected: ${url}`, () => {
    assert.throws(() => upgrade.validateOfficialArtifact({ ...artifact(), url }), /UNTRUSTED_ARTIFACT_URL/);
  });
}
for (const input of ['', 'null', '[]', '!!js/function >\n  function () {}', 'version: 0.2.1\nversion: 0.2.2', ' '.repeat(32769)]) {
  test('invalid, executable, duplicate or oversized feed cannot select an artifact', () => {
    assert.throws(() => upgrade.parseOfficialFeed(input), upgrade.OfficialUpgradeError);
  });
}
for (const change of [feed => { feed.files.push(feed.files[0]); }, feed => { feed.path += '?unsafe'; },
  feed => { feed.sha512 = digest(Buffer.from('different')); }, feed => { feed.files = null; },
  feed => { feed.files = [null]; }, feed => { feed.files[0].size = '123'; }]) {
  test('ambiguous feed fields fail instead of falling back to a guessed artifact', () => {
    const feed = JSON.parse(wire()); change(feed);
    assert.throws(() => upgrade.parseOfficialFeed(JSON.stringify(feed)), upgrade.OfficialUpgradeError);
  });
}
test('a plan cannot silently downgrade or grant installation even for stable upstreams', () => {
  assert.throws(() => upgrade.planOfficialUpgrade(artifact(), '0.2.1'), /OFFICIAL_DOWNGRADE_REFUSED/);
  const stable = { ...artifact(), version: '0.2.1', url: artifact().url.replaceAll('0.2.1-rc.2', '0.2.1') };
  assert.equal(upgrade.planOfficialUpgrade(stable, '0.2.0').automaticInstallAllowed, false);
});
test('ordinary checks use a fixed HTTPS feed with no credentials and block preview policy by default', async () => {
  const calls = [];
  const provider = upgrade.createOfficialUpgradeProvider({ fetch: async (url, options) => {
    calls.push({ url, options }); return response(wire());
  } });
  const result = await provider.check({ baselineVersion: '0.2.0-rc.2' });
  assert.equal(result.newer, true); assert.equal(result.preview, true); assert.equal(result.policyAllowed, false);
  assert.equal(result.automaticInstallAllowed, false); assert.equal(result.installed, false);
  assert.equal(calls[0].url, upgrade.OFFICIAL_FEED); assert.equal(calls[0].options.redirect, 'error');
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.deepEqual(Object.keys(calls[0].options.headers), ['Accept']);
  assert.equal((await provider.check({ baselineVersion: '0.2.1-rc.2', allowPrerelease: true })).policyAllowed, true);
  assert.equal(provider.install, undefined); assert.ok(Object.isFrozen(provider.capabilities));
});
for (const fetch of [async () => { throw new Error('https://untrusted.invalid/?token=synthetic'); },
  async () => new Response('error', { status: 403 }), async () => new Response('partial', { status: 206 }),
  async () => ({ status: 200, redirected: true, body: null }),
  async () => ({ status: 200, url: 'https://other.invalid/', redirected: false, body: null }),
  async () => response(' '.repeat(32769))]) {
  test('transport errors, partial replies, redirects and oversize responses cannot become successful checks', async () => {
    const provider = upgrade.createOfficialUpgradeProvider({ fetch });
    await assert.rejects(provider.check({ baselineVersion: '0.2.0' }), error => {
      assert.ok(error instanceof upgrade.OfficialUpgradeError);
      assert.doesNotMatch(error.message, /synthetic|token|https:/); return true;
    });
  });
}
test('invalid preview input is rejected before network access', async () => {
  let calls = 0; const provider = upgrade.createOfficialUpgradeProvider({ fetch: async () => { calls++; } });
  await assert.rejects(provider.check({ baselineVersion: '0.2.0', allowPrerelease: 'true' }), /INVALID_PREVIEW_POLICY/);
  assert.equal(calls, 0);
});

test('download verifies exact bytes, publishes exclusively, then reuses only a verified cache', async () => isolated(async root => {
  let calls = 0; const provider = upgrade.createOfficialUpgradeProvider({ fetch: async () => { calls++; return response(bytes); } });
  const first = await provider.download(artifact(), root);
  assert.equal(first.cached, false); assert.equal(first.installerExecuted, false); assert.equal(calls, 1);
  assert.deepEqual(await fs.readFile(first.file), bytes);
  const checked = await provider.verify(first.file, artifact());
  assert.equal(checked.verified, true); assert.equal(checked.codeSignatureVerified, false);
  assert.equal((await provider.download(artifact(), root)).cached, true); assert.equal(calls, 1);
  const changed = Buffer.from(bytes); changed[0] ^= 1; await fs.writeFile(first.file, changed);
  await assert.rejects(provider.download(artifact(), root), /PACKAGE_SHA512_MISMATCH/);
  assert.equal(calls, 1); assert.deepEqual(await fs.readFile(first.file), changed);
}));
for (const data of [bytes.subarray(1), Buffer.concat([bytes, Buffer.from('extra')]), Buffer.alloc(bytes.length, 0)]) {
  test('incomplete, oversized or mismatching downloads leave no published package or temporary file', async () => isolated(async root => {
    const provider = upgrade.createOfficialUpgradeProvider({ fetch: async () => response(data) });
    await assert.rejects(provider.download(artifact(), root), upgrade.OfficialUpgradeError);
    assert.deepEqual(await fs.readdir(root), []);
  }));
}
test('a transport failure leaves the owned cache empty without publishing a package', async () => isolated(async root => {
  const provider = upgrade.createOfficialUpgradeProvider({ fetch: async () => { throw new Error('request failed'); } });
  await assert.rejects(provider.download(artifact(), root), /OFFICIAL_TRANSPORT_FAILED/);
  assert.deepEqual(await fs.readdir(root), []);
}));
test('concurrent arrivals cannot overwrite an independently appearing cache entry', async () => isolated(async root => {
  const key = Buffer.from(artifact().sha512, 'base64').toString('hex');
  const destination = join(root, `${key}.exe`);
  const independent = Buffer.from('an existing file that must remain untouched');
  const provider = upgrade.createOfficialUpgradeProvider({ fetch: async () => {
    await fs.writeFile(destination, independent, { flag: 'wx' }); return response(bytes);
  } });
  await assert.rejects(provider.download(artifact(), root), /OFFICIAL_DOWNLOAD_FAILED/);
  assert.deepEqual(await fs.readFile(destination), independent);
  assert.deepEqual(await fs.readdir(root), [`${key}.exe`]);
}));
test('cache links and package links are refused, and target bytes remain unchanged', async () => isolated(async root => {
  const target = join(root, 'target'); await fs.mkdir(target);
  const link = join(root, 'linked'); await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    let calls = 0; const provider = upgrade.createOfficialUpgradeProvider({ fetch: async () => { calls++; } });
    await assert.rejects(provider.download(artifact(), link), /LINKED_CACHE_PATH/);
    assert.equal(calls, 0); assert.deepEqual(await fs.readdir(target), []);
  } finally { await fs.unlink(link); }
}));
for (const path of ['relative', '\\\\server\\share\\package.exe', '//server/share/file.exe', '\\\\?\\C:\\package.exe', 'bad\0path']) {
  test('nonlocal and noncanonical package/cache paths are rejected before filesystem access', async () => {
    await assert.rejects(upgrade.verifyOfficialPackage(path, artifact()), /NONCANONICAL_PACKAGE_PATH/);
    const provider = upgrade.createOfficialUpgradeProvider({ fetch: async () => { throw new Error('network must not run'); } });
    await assert.rejects(provider.download(artifact(), path), /NONCANONICAL_CACHE_PATH/);
  });
}
test('upgrade CLI has no default action and rejects unsupported operations without leaking paths', async () => {
  const script = join(__dirname, '..', 'scripts', 'upgrade-official.mjs');
  const run = promisify(execFile);
  assert.match((await run(process.execPath, [script], { windowsHide: true })).stdout, /No installer was run/);
  await assert.rejects(run(process.execPath, [script, '--install'], { windowsHide: true }), error => {
    const report = JSON.parse(error.stderr); assert.equal(report.installed, false);
    assert.equal(report.reason, 'INVALID_UPGRADE_OPERATION'); assert.equal(error.stdout, ''); return true;
  });
});
