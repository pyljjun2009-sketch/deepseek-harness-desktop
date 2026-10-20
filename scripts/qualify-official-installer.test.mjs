import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { finished } from 'node:stream/promises';
import test from 'node:test';
import { assertPhysicalAncestors, candidateStorageRoot, expectedRecoveryHome, nativeStorage } from './community-build-storage.mjs';
import { childEnvironment, installerQualificationPlan, payloadInventory, probeConfiguration,
  probeInclude, qualificationError, verifyInstalledPayload, validateQualificationCandidate,
  selectQualificationPayload, copyQualificationPayload, validateProbeUpdateMetadata,
  verifyProbePayloadMetadata, verifyQualificationPayloadBindings } from './qualify-official-installer.mjs';

const identifier = 'a1234567-1234-4567-8123-123456789abc';
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('physical QA namespace preserves exact identity and never accepts a relocated arbitrary root', () => {
  const payload = nativeStorage.candidate + '\\' + identifier + '\\app';
  assert.equal(candidateStorageRoot(payload, identifier), nativeStorage.candidate);
  assert.equal(candidateStorageRoot(payload, 'not-an-id'), undefined);
  for (const bad of [payload.toLowerCase(), payload.replace('C:', 'D:'), payload + '\\..\\app',
    '\\\\server\\share\\' + identifier + '\\app', payload.replaceAll('\\', '/')]) {
    assert.equal(candidateStorageRoot(bad, identifier), undefined);
  }
  const plan = installerQualificationPlan(identifier, project, 2);
  assert.equal(plan.baseRoot, nativeStorage.installer);
  assert.equal(plan.copyRoot, nativeStorage.installerCopy);
  assert.equal(plan.target, nativeStorage.installer + '\\' + identifier + '\\app');
  assert.equal(plan.payloadCopy, nativeStorage.installerCopy + '\\' + identifier + '\\app');
  assert.throws(() => installerQualificationPlan(identifier, project, 3));
  const home = nativeStorage.recovery + '\\' + identifier + '\\home';
  assert(expectedRecoveryHome(home, identifier));
  assert(expectedRecoveryHome('C:\\DSHRQ\\' + identifier + '\\home', identifier));
  assert(!expectedRecoveryHome(home + '\\..\\home', identifier));
  assert(!expectedRecoveryHome(home, 'not-an-id'));
});

const lock = { distributionVersion: '0.5.0', commit: 'a'.repeat(40), version: '0.2.0-rc.2' };
const prepared = { version: '0.5.0', officialCommit: lock.commit, overlaySha256: 'b'.repeat(64),
  shellReceiptSha256: 'c'.repeat(64), runtimeLockSha256: 'd'.repeat(64) };
const candidateRecord = () => ({ schemaVersion: 1, kind: 'official-nsis-candidate', version: '0.5.0',
  ...Object.fromEntries(['officialCommit', 'overlaySha256', 'shellReceiptSha256', 'runtimeLockSha256'].map(key => [key, prepared[key]])),
  identity: identifier, payload: `C:\\DSHBP\\${identifier}\\app`, payloadSha256: 'e'.repeat(64),
  installer: join(project, 'release', 'candidate.exe'), installerSha256: 'f'.repeat(64), sourcePayloadUnchanged: true });

async function fixture(callback) {
  const scratch = join(project, '.official-build'); await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(join(scratch, 'installer-guard-fixture-'));
  try { await callback(directory); }
  finally {
    assert.equal(dirname(resolve(directory)), resolve(scratch));
    await rm(directory, { recursive: true, force: true });
  }
}

async function packagedFixture(root, hostPort = '0', manifestOverrides = {}) {
  const source = join(root, 'archive-source');
  const payload = join(root, 'release', 'win-unpacked');
  await mkdir(join(source, 'desktop'), { recursive: true });
  const hostDirectory = join(source, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib');
  await mkdir(hostDirectory, { recursive: true });
  await writeFile(join(hostDirectory, 'index.js'), `// tiny sealed Host\nconst options = { args: ['--no-open', '--port', '${hostPort}'] };\n`);
  await mkdir(join(root, 'desktop'), { recursive: true });
  await mkdir(join(payload, 'resources', 'recovery'), { recursive: true });
  await writeFile(join(source, 'package.json'), JSON.stringify({ version: lock.distributionVersion,
    main: 'desktop/launcher.cjs', dshOfficialCommit: lock.commit, dshOfficialVersion: lock.version,
    dshDesktopUpdateChannel: 'latest', dshUpgradeInterfaceVersion: 1, ...manifestOverrides }));
  await writeFile(join(source, 'shell-dependency-receipt.json'), '{"fixture":true}');
  for (const file of ['launcher.cjs', 'recovery.cjs', 'watchdog.cjs', 'health-window.cjs', 'official-upgrade.cjs']) {
    const contents = `// tiny ${file}`;
    await writeFile(join(source, 'desktop', file), contents);
    await writeFile(join(root, 'desktop', file), contents);
    if (file === 'recovery.cjs' || file === 'watchdog.cjs') await writeFile(join(payload, 'resources', 'recovery', file), contents);
  }
  const writer = await createRequire(import.meta.url)('@electron/asar').createPackage(source, join(payload, 'resources', 'app.asar'));
  await finished(writer);
  return payload;
}

test('final candidate selection binds its exact QA-owned namespace and current locked build', () => {
  const candidate = candidateRecord();
  assert.equal(validateQualificationCandidate(candidate, lock, prepared, project), candidate);
  for (const [key, value] of Object.entries({ schemaVersion: 2, kind: 'unpacked', version: '0.4.0',
    identity: 'b1234567-1234-4567-8123-123456789abc', payloadSha256: 'not-a-hash',
    installerSha256: 'f'.repeat(63), sourcePayloadUnchanged: false })) {
    assert.throws(() => validateQualificationCandidate({ ...candidate, [key]: value }, lock, prepared, project));
  }
  for (const key of ['officialCommit', 'overlaySha256', 'shellReceiptSha256', 'runtimeLockSha256']) {
    assert.throws(() => validateQualificationCandidate({ ...candidate, [key]: '0'.repeat(candidate[key].length) }, lock, prepared, project), /Stale candidate binding/);
  }
  for (const payload of ['C:\\', `C:\\DSHBP\\${identifier}\\app\\..\\app`,
    `C:/DSHBP/${identifier}/app`, `C:\\DSHBP\\${identifier}\\not-app`,
    `C:\\DSHBP\\..\\${identifier}\\app`, `D:\\DSHBP\\${identifier}\\app`,
    'C:\\DSHBP\\not-a-uuid\\app', `C:\\DSHQI\\${identifier}\\app`]) {
    assert.throws(() => validateQualificationCandidate({ ...candidate, payload }, lock, prepared, project));
  }
  assert.throws(() => validateQualificationCandidate({ ...candidate, installer: 'candidate.exe' }, lock, prepared, project));
  assert.throws(() => validateQualificationCandidate({ ...candidate, installer: join(project, 'candidate.exe') }, lock, prepared, project));
  assert.throws(() => validateQualificationCandidate(candidate, lock, { ...prepared, version: '0.6.0' }, project));
  assert.throws(() => validateQualificationCandidate(candidate, { ...lock, commit: '0'.repeat(40) }, prepared, project));
});

test('selector falls back only when candidate is absent, never when a candidate is stale or malformed', async () => {
  await fixture(async root => {
    await packagedFixture(root);
    await mkdir(join(root, '.official-build'));
    await writeFile(join(root, 'official.lock.json'), JSON.stringify(lock));
    await writeFile(join(root, '.official-build', 'paths.json'), JSON.stringify(prepared));
    await writeFile(join(root, 'release', 'win-unpacked', 'payload.txt'), 'stable');
    const result = await selectQualificationPayload(root);
    assert.equal(result.kind, 'development-unpacked'); assert.equal(result.candidate, null);
    assert.equal(result.payloadSha256, (await payloadInventory(result.payload)).sha256);
    const record = { ...candidateRecord(), version: '0.4.0', installer: join(root, 'release', 'candidate.exe') };
    await writeFile(join(root, '.official-build', 'candidate.json'), JSON.stringify(record));
    await assert.rejects(selectQualificationPayload(root), /distribution version is stale/);
    await writeFile(join(root, '.official-build', 'candidate.json'), '{invalid');
    await assert.rejects(selectQualificationPayload(root), SyntaxError);
  });
});

test('qualification rejects stale ASAR identity, current source wrappers, and external recovery bytes', async () => {
  await fixture(async root => {
    const payload = await packagedFixture(root);
    await verifyQualificationPayloadBindings(payload, lock, null, root);
    await assert.rejects(verifyQualificationPayloadBindings(payload, { ...lock, distributionVersion: '0.6.0' }, null, root), /distribution version/);
    await assert.rejects(verifyQualificationPayloadBindings(payload, { ...lock, commit: '0'.repeat(40) }, null, root), /official commit/);
    await assert.rejects(verifyQualificationPayloadBindings(payload, { ...lock, version: 'other' }, null, root), /official version/);
    await writeFile(join(root, 'desktop', 'launcher.cjs'), 'changed-source-wrapper');
    await assert.rejects(verifyQualificationPayloadBindings(payload, lock, null, root), /packaged desktop wrapper/);
    await writeFile(join(root, 'desktop', 'launcher.cjs'), '// tiny launcher.cjs');
    await writeFile(join(root, 'desktop', 'official-upgrade.cjs'), 'stale-upgrade-provider');
    await assert.rejects(verifyQualificationPayloadBindings(payload, lock, null, root), /packaged desktop wrapper/);
    await writeFile(join(root, 'desktop', 'official-upgrade.cjs'), '// tiny official-upgrade.cjs');
    await writeFile(join(payload, 'resources', 'recovery', 'watchdog.cjs'), 'changed-recovery');
    await assert.rejects(verifyQualificationPayloadBindings(payload, lock, null, root), /external recovery wrapper/);
    await writeFile(join(root, 'desktop', 'official-overlay.patch'), 'current-overlay');
    await writeFile(join(root, 'official-runtime.lock.yaml'), 'current-runtime');
    await assert.rejects(verifyQualificationPayloadBindings(payload, lock, prepared, root), /official overlay/);
  });
});

test('qualification rejects the upstream fixed port inside a physically sealed ASAR fixture', async () => {
  await fixture(async root => {
    const payload = await packagedFixture(root, '19387');
    await assert.rejects(verifyQualificationPayloadBindings(payload, lock, null, root), /OS allocate its loopback port/);
  });
});

for (const manifest of [{ dshDesktopUpdateChannel: 'nightly' }, { dshUpgradeInterfaceVersion: 2 }]) {
  test('qualification refuses unqualified sealed upgrade metadata ' + JSON.stringify(manifest), async () => {
    await fixture(async root => {
      const payload = await packagedFixture(root, '0', manifest);
      await assert.rejects(verifyQualificationPayloadBindings(payload, lock, null, root), /update channel|upgrade interface/);
    });
  });
}

test('prepared qualification bindings include physical root inputs, embedded receipt, and staged manifest', async () => {
  await fixture(async root => {
    const payload = await packagedFixture(root);
    await writeFile(join(root, 'desktop', 'official-overlay.patch'), 'current-overlay');
    await writeFile(join(root, 'official-runtime.lock.yaml'), 'current-runtime');
    const hash = body => createHash('sha256').update(body).digest('hex');
    const current = { ...prepared, staging: join(root, 'archive-source'),
      overlaySha256: hash('current-overlay'), runtimeLockSha256: hash('current-runtime'),
      shellReceiptSha256: hash('{"fixture":true}') };
    await verifyQualificationPayloadBindings(payload, lock, current, root);
    await assert.rejects(verifyQualificationPayloadBindings(payload, lock, { ...current, runtimeLockSha256: '0'.repeat(64) }, root), /runtime lock/);
    await assert.rejects(verifyQualificationPayloadBindings(payload, lock, { ...current, shellReceiptSha256: '0'.repeat(64) }, root), /shell receipt/);
    await writeFile(join(current.staging, 'package.json'), JSON.stringify({ version: 'other' }));
    await assert.rejects(verifyQualificationPayloadBindings(payload, lock, current, root), /staged candidate identity/);
  });
});

test('owned payload copying is byte-identical and never overwrites, nests within, or mutates the source', async () => {
  await fixture(async root => {
    const source = join(root, 'source'); await mkdir(source); await mkdir(join(source, 'empty'));
    await writeFile(join(source, 'payload.txt'), 'stable');
    const original = await payloadInventory(source);
    const copy = join(root, 'copy');
    assert.deepEqual(await copyQualificationPayload(source, copy, original), original);
    await writeFile(join(copy, 'payload.txt'), 'changed-private-copy');
    assert.deepEqual(await payloadInventory(source), original);
    await assert.rejects(copyQualificationPayload(source, copy, original), /must be fresh/);
    await assert.rejects(copyQualificationPayload(source, source, original), /cannot be the sealed source/);
    await assert.rejects(copyQualificationPayload(source, join(source, 'nested'), original), /cannot be nested/);
    if (process.platform === 'win32') {
      await assert.rejects(copyQualificationPayload(source, source.toUpperCase(), original), /cannot be the sealed source/);
      await assert.rejects(copyQualificationPayload(source, join(source.toUpperCase(), 'nested'), original), /cannot be nested/);
    }
    await writeFile(join(source, 'payload.txt'), 'candidate-changed');
    await assert.rejects(copyQualificationPayload(source, join(root, 'fresh'), original), /Source changed before/);
  });
});

test('update metadata cannot redirect downloads, use production caches, or add credential fields', () => {
  const cache = `dsh-installer-qa-${identifier}-updater`;
  const metadata = { provider: 'github', owner: 'pyljjun2009-sketch', repo: 'deepseek-harness-desktop', updaterCacheDirName: cache };
  validateProbeUpdateMetadata(metadata, cache);
  validateProbeUpdateMetadata({ ...metadata, channel: 'latest' }, cache);
  for (const modification of [{ provider: 'generic' }, { owner: 'attacker' }, { repo: 'other' },
    { channel: 'beta' }, { updaterCacheDirName: 'production-updater' }, { token: 'secret' },
    { url: 'https://example.test' }, { headers: {} }, { private: true }]) {
    assert.throws(() => validateProbeUpdateMetadata({ ...metadata, ...modification }, cache));
  }
  assert.throws(() => validateProbeUpdateMetadata([], cache));
});

test('NSIS metadata diff accepts only pinned helper bytes and a private fixed update identity', async () => {
  await fixture(async root => {
    const payload = join(root, 'payload'); await mkdir(payload); await mkdir(join(payload, 'resources'));
    await writeFile(join(payload, 'resources', 'app.asar'), 'unchanged-app');
    const before = await payloadInventory(payload);
    await writeFile(join(payload, 'resources', 'elevate.exe'), 'trusted-helper');
    const afterHelper = await payloadInventory(payload);
    const helper = afterHelper.files.find(file => file.path === 'resources/elevate.exe');
    const plan = installerQualificationPlan(identifier, project);
    const changes = await verifyProbePayloadMetadata(before, afterHelper, payload, plan, helper);
    assert.deepEqual(changes, [{ path: helper.path, action: 'added', sha256: helper.sha256 }]);
    const metadata = { provider: 'github', owner: 'pyljjun2009-sketch', repo: 'deepseek-harness-desktop',
      updaterCacheDirName: `${plan.packageName}-updater` };
    await writeFile(join(payload, 'resources', 'app-update.yml'), JSON.stringify(metadata));
    const after = await payloadInventory(payload);
    assert.equal((await verifyProbePayloadMetadata(before, after, payload, plan, helper)).length, 2);
    await assert.rejects(verifyProbePayloadMetadata(before, after, payload, plan, { ...helper, sha256: '0'.repeat(64) }), /helper bytes/);
    await assert.rejects(verifyProbePayloadMetadata(before, { ...after, directories: [...after.directories, 'extra'] }, payload, plan, helper), /directories/);
    await assert.rejects(verifyProbePayloadMetadata(before, { ...after, files: after.files.filter(file => file.path !== 'resources/app.asar') }, payload, plan, helper), /removed/);
    await assert.rejects(verifyProbePayloadMetadata(before, { ...after, files: after.files.map(file => file.path === 'resources/app.asar' ? { ...file, sha256: 'wrong' } : file) }, payload, plan, helper), /non-metadata/);
    await assert.rejects(verifyProbePayloadMetadata(before, { ...after, files: [...after.files, { path: 'unexpected.txt', size: 1, sha256: '0'.repeat(64) }] }, payload, plan, helper), /addition/);
    await writeFile(join(payload, 'resources', 'app-update.yml'), JSON.stringify({ ...metadata, updaterCacheDirName: 'production-updater' }));
    await assert.rejects(verifyProbePayloadMetadata(before, await payloadInventory(payload), payload, plan, helper), /cache identity/);
  });
});

test('QA identity and paths cannot collide with the production installation', () => {
  const plan = installerQualificationPlan(identifier, project);
  assert.equal(plan.target, `C:\\DSHQI\\${identifier}\\app`);
  assert.equal(plan.payloadCopy, `C:\\DSHQB\\${identifier}\\app`);
  assert.equal(dirname(plan.payloadCopy), plan.copyBase);
  assert.notEqual(plan.copyBase, plan.base);
  assert.equal(plan.guid, identifier);
  assert.notEqual(plan.appId, 'com.deepseek.harness.desktop');
  assert.equal(plan.uninstallKey, `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${identifier}`);
  for (const bad of ['', '../production', 'com.deepseek.harness.desktop', 'a1234567-1234-1567-8123-123456789abc']) {
    assert.throws(() => installerQualificationPlan(bad), /fresh UUID/);
  }
});

test('probe config has no protocol, launch, elevation, shortcut, publish, or app-data deletion authority', () => {
  const plan = installerQualificationPlan(identifier, project);
  const config = probeConfiguration(plan, '0.5.0', '44.0.0', 'qa-include.nsh');
  assert.equal(config.extends, null);
  assert.deepEqual(config.protocols, []); assert.deepEqual(config.fileAssociations, []); assert.deepEqual(config.publish, []);
  for (const name of ['perMachine', 'allowElevation', 'createDesktopShortcut', 'createStartMenuShortcut',
    'runAfterFinish', 'deleteAppDataOnUninstall']) assert.equal(config.nsis[name], false);
  assert.equal(config.nsis.guid, identifier);
  assert.equal(config.directories.output, plan.artifacts);
  assert(!config.directories.output.endsWith('release'));
  assert.throws(() => probeConfiguration({ ...plan, guid: 'production' }, '0.5.0', '44.0.0', 'include'));
});

test('child processes never inherit Electron run-as-node, including differently cased variables', () => {
  const before = { ELECTRON_RUN_AS_NODE: '1', Electron_Run_As_Node: '1', PATH: 'safe-path' };
  assert.deepEqual(childEnvironment(before), { PATH: 'safe-path' });
  assert.equal(before.ELECTRON_RUN_AS_NODE, '1');
});

test('failure diagnostics never preserve a complete command, URL, or credential', () => {
  const diagnostic = qualificationError(Object.assign(new Error('secret-token https://example.test/signed?token=SECRET timed out after 4 minutes'),
    { code: 'ERR_ELECTRON_BUILDER_CANNOT_EXECUTE', exitCode: 1 }));
  assert.deepEqual(diagnostic, { kind: 'operation', code: 'ERR_ELECTRON_BUILDER_CANNOT_EXECUTE', exitCode: 1, reason: 'nsis-compiler-timeout' });
  assert(!JSON.stringify(diagnostic).includes('SECRET'));
  assert.deepEqual(qualificationError(new Error('warning 6010: a variable; warning 6010: duplicate; Error in script private/file.nsi on line 40')),
    { kind: 'operation', warningCodes: [6010], scriptErrorLine: 40 });
  assert.deepEqual(qualificationError({ code: 2 }), { kind: 'operation', nativeExitCode: 2 });
  assert.deepEqual(qualificationError({ killed: true, signal: 'SIGTERM', message: 'private command' }),
    { kind: 'operation', killed: true, signal: 'SIGTERM' });
  assert.deepEqual(qualificationError({ killed: false, signal: 'SECRET', message: 'private command' }),
    { kind: 'operation' });
});

test('QA include verifies exact paths and identities without production process termination', () => {
  const plan = installerQualificationPlan(identifier, project);
  const include = probeInclude(plan, '!include "${__FILEDIR__}\\community-process-guard.nsh"\n'
    + '!include "${__FILEDIR__}\\community-installer-directories.nsh"\n'
    + '!macro customInit\n  OriginalGuard\n!macroend\n');
  assert(include.includes('!insertmacro dshQaOriginalInit'));
  assert(include.includes(`$INSTDIR != "${plan.target}"`));
  assert(include.includes(`"\${APP_GUID}" != "${plan.guid}"`));
  assert(include.includes(`"\${APP_ID}" != "${plan.appId}"`));
  assert(include.includes('"--delete-app-data"'));
  assert.match(include, /!macro customCheckAppRunning\s*!macroend/);
  assert(include.indexOf('!macro customCheckAppRunning') < include.indexOf('community-process-guard.nsh'));
  assert(include.includes(`!include "${join(project, 'build/community-process-guard.nsh')}"`));
  assert(include.includes(`!include "${join(project, 'build/community-installer-directories.nsh')}"`));
  assert(!include.includes('${__FILEDIR__}'));
  assert(include.includes('pathMatch=true') && include.includes('directoryWildcardExists=false'));
  assert(!include.includes('FileWrite $R4 "$INSTDIR') && !include.includes('FileWrite $R4 "$CMDLINE'));
  assert(!include.includes('taskkill') && !include.includes('Stop-Process'));
  assert.throws(() => probeInclude(plan, 'wrong template'), /Unexpected/);
  assert.throws(() => probeInclude(plan, '!macro customInit\n!macroend\n'
    + '!include "${__FILEDIR__}\\community-process-guard.nsh"\n!include "${__FILEDIR__}\\community-process-guard.nsh"'), /duplicated/);
});

test('installed payload requires all original bytes and allows only known NSIS-owned extras', () => {
  const expected = { files: [{ path: 'resources/app.asar', size: 4, sha256: 'expected' }],
    directories: ['resources'], sha256: 'manifest' };
  const actual = { files: [...expected.files, { path: 'Uninstall DeepSeekHarness.exe', size: 1, sha256: 'uninstaller' }],
    directories: ['resources'] };
  assert.equal(verifyInstalledPayload(expected, actual).payloadFileCount, 1);
  assert.throws(() => verifyInstalledPayload(expected, { ...actual, files: [actual.files[1]] }), /Payload changed/);
  assert.throws(() => verifyInstalledPayload(expected, { ...actual, files: [{ ...expected.files[0], sha256: 'wrong' }, actual.files[1]] }), /Payload changed/);
  assert.throws(() => verifyInstalledPayload(expected, { ...actual, files: [...actual.files, { path: 'arbitrary.txt' }] }), /Unexpected installed/);
  assert.throws(() => verifyInstalledPayload(expected, { ...actual, directories: [] }), /directory missing/);
  assert.throws(() => verifyInstalledPayload(expected, { ...actual, directories: [...actual.directories, 'unexpected-empty'] }), /Unexpected installed payload directory/);
  assert.throws(() => verifyInstalledPayload(expected, { ...actual, files: expected.files }), /uninstaller is missing/);
});

test('payload inventory hashes physical files and refuses junctions', async () => {
  const scratch = join(project, '.official-build'); await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(join(scratch, 'installer-guard-fixture-'));
  const link = join(directory, 'payload', 'link');
  try {
    const payload = join(directory, 'payload'); await mkdir(payload);
    await writeFile(join(payload, 'file.txt'), 'data');
    const first = await payloadInventory(payload);
    assert.equal(first.files.length, 1); assert.equal(first.files[0].size, 4); assert.equal(first.sha256.length, 64);
    await writeFile(join(payload, 'file.txt'), 'data2');
    assert.notEqual((await payloadInventory(payload)).sha256, first.sha256);
    const external = join(directory, 'external'); await mkdir(external);
    await assertPhysicalAncestors(join(payload, 'missing', 'fresh'));
    await symlink(external, link, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(payloadInventory(payload), /links or junctions/);
    await assert.rejects(assertPhysicalAncestors(join(link, 'missing', 'fresh')), /link or junction/);
    await unlink(link);
  } finally {
    // Remove only this freshly created, verified direct-child fixture; never the QA install target.
    assert.equal(dirname(resolve(directory)), resolve(scratch));
    await rm(directory, { recursive: true, force: true });
  }
});
