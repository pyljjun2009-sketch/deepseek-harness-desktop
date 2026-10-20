/** Rebuild the installer, not the payload. Reject stale community wrappers and verify before and after. */
import assert from 'node:assert/strict';
import { readFile, cp, mkdir, writeFile, lstat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { payloadInventory } from './qualify-official-installer.mjs';
import config, { verifyPackagedOfficial } from './official-builder.config.mjs';
import { communityPackageName, writeCommunityUpdateConfiguration, verifyCommunityUpdateConfiguration } from './community-update-config.mjs';
import { assertPhysicalAncestors, nativeStorage } from './community-build-storage.mjs';

assert.equal(process.platform, 'win32', 'Only the qualified Windows x64 pipeline is supported');
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(await readFile(join(project, 'official.lock.json'), 'utf8'));
const prepared = JSON.parse(await readFile(join(project, '.official-build/paths.json'), 'utf8'));
assert.equal(prepared.version, lock.distributionVersion);
assert.equal(prepared.officialCommit, lock.commit);
assert.equal(prepared.officialVersion, lock.version);
assert.equal(prepared.overlaySha256, createHash('sha256').update(await readFile(join(project, 'desktop/official-overlay.patch'))).digest('hex'));
assert.equal(prepared.runtimeLockSha256, createHash('sha256').update(await readFile(join(project, 'official-runtime.lock.yaml'))).digest('hex'));
const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const payload = join(project, 'release/win-unpacked');
const archive = join(payload, 'resources/app.asar');
const manifest = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
assert.equal(manifest.name, communityPackageName);
assert.equal(manifest.version, lock.distributionVersion);
assert.equal(manifest.dshOfficialCommit, lock.commit);
assert.equal(manifest.dshOfficialVersion, lock.version);
assert.equal(manifest.main, 'desktop/launcher.cjs');
assert.equal(manifest.dshDesktopUpdateChannel, 'latest');
assert.equal(manifest.dshUpgradeInterfaceVersion, 1);
const stagingManifest = JSON.parse(await readFile(join(prepared.staging, 'package.json'), 'utf8'));
for (const key of ['version', 'main', 'dshOfficialCommit', 'dshOfficialVersion', 'dshDesktopUpdateChannel', 'dshUpgradeInterfaceVersion']) {
  assert.equal(stagingManifest[key], manifest[key], `Stale installer metadata: ${key}`);
}
for (const file of ['launcher.cjs', 'recovery.cjs', 'watchdog.cjs', 'health-window.cjs', 'official-upgrade.cjs']) {
  assert.deepEqual(asar.extractFile(archive, `desktop/${file}`), await readFile(join(project, 'desktop', file)), `Stale packaged wrapper: ${file}`);
}
for (const file of ['recovery.cjs', 'watchdog.cjs']) {
  assert.deepEqual(await readFile(join(payload, 'resources/recovery', file)), await readFile(join(project, 'desktop', file)));
}
await verifyPackagedOfficial(payload);
const before = await payloadInventory(payload);
// electron-builder mutates even prepackaged inputs (elevate.exe / app-update.yml).
// Protect the tested tree; qualify and install exactly the final independently owned copy.
const identity = randomUUID();
const parent = resolve(nativeStorage.candidate);
await assertPhysicalAncestors(parent);
await mkdir(parent, { recursive: true });
await assertPhysicalAncestors(parent);
assert((await lstat(parent)).isDirectory() && !(await lstat(parent)).isSymbolicLink());
const candidateRoot = join(parent, identity);
await mkdir(candidateRoot);
const candidatePayload = join(candidateRoot, 'app');
await cp(payload, candidatePayload, { recursive: true, force: false, errorOnExist: true });
assert.equal((await payloadInventory(candidatePayload)).sha256, before.sha256, 'The owned NSIS copy is not byte-identical');
await writeCommunityUpdateConfiguration(join(candidatePayload, 'resources'), manifest.name);
for (const key of Object.keys(process.env)) if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete process.env[key];
process.env.ELECTRON_BUILDER_7Z_FILTER = 'BCJ';
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
const { build, Platform, Arch } = require('electron-builder');
const artifacts = await build({ projectDir: prepared.staging, prepackaged: candidatePayload,
  targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64), config, publish: 'never' });
assert.equal((await payloadInventory(payload)).sha256, before.sha256, 'NSIS repackaging changed the verified payload');
const final = await payloadInventory(candidatePayload);
const allowed = new Set(['resources/elevate.exe', 'resources/app-update.yml']);
const map = new Map(final.files.map(file => [file.path, file]));
for (const file of before.files) if (!allowed.has(file.path)) assert.deepEqual(map.get(file.path), file);
const initialNames = new Set(before.files.map(file => file.path));
for (const file of final.files) assert(initialNames.has(file.path) || allowed.has(file.path), 'Unexpected NSIS-owned payload addition');
assert.deepEqual(final.directories, before.directories);
const { getNsisElevatePath } = require('app-builder-lib/out/toolsets/windows.js');
assert.deepEqual(await readFile(join(candidatePayload, 'resources/elevate.exe')), await readFile(await getNsisElevatePath()));
await verifyCommunityUpdateConfiguration(join(candidatePayload, 'resources'), manifest.name);
const installer = artifacts.find(file => file.endsWith('.exe') && resolve(dirname(file)) === resolve(project, 'release'));
assert(installer, 'Builder did not return the official candidate installer');
const candidate = { schemaVersion: 1, kind: 'official-nsis-candidate', version: lock.distributionVersion,
  officialCommit: prepared.officialCommit, overlaySha256: prepared.overlaySha256,
  shellReceiptSha256: prepared.shellReceiptSha256, runtimeLockSha256: prepared.runtimeLockSha256,
  identity, payload: candidatePayload, payloadSha256: final.sha256, sourcePayloadSha256: before.sha256,
  installer, installerSha256: createHash('sha256').update(await readFile(installer)).digest('hex'),
  sourcePayloadUnchanged: true, published: false };
await writeFile(join(project, '.official-build', 'candidate.json'), `${JSON.stringify(candidate, null, 2)}\n`);
await writeFile(join(candidateRoot, 'ownership.json'), `${JSON.stringify(candidate, null, 2)}\n`);
console.log(JSON.stringify(candidate));
