/** Install the sealed candidate twice under a fresh QA identity, never the real product identity.
 * This test intentionally does not launch the payload or test production process termination.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, cp, lstat, mkdir, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { dirname, join, relative, resolve, sep, win32 } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { installWindowsCommunityInstaller } from './windows-community-installer.mjs';
import { verifyCommunityHostPort } from './verify-official-host.mjs';
import { verifyCommunityUpdateConfiguration } from './community-update-config.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = promisify(execFile);
const require = createRequire(import.meta.url);
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const extraInstalledFiles = new Set(['Uninstall DeepSeekHarness.exe', '7zip-installer-LICENSE.txt',
  '7zip-installer-COPYING.txt', 'uninstallerIcon.ico']);

export function installerQualificationPlan(identifier, projectRoot = project) {
  assert(uuidPattern.test(identifier), 'A fresh UUID v4 is required for every qualification');
  const prefix = 'dsh-installer-qa-';
  const evidence = resolve(projectRoot, '.official-build', `installer-qualification-${identifier}`);
  const base = win32.resolve('C:\\DSHQI', identifier);
  const target = win32.join(base, 'app');
  const copyBase = win32.resolve('C:\\DSHQB', identifier);
  assert.equal(win32.dirname(base).toLowerCase(), 'c:\\dshqi');
  assert.equal(win32.dirname(target), base);
  return Object.freeze({ identifier, evidence, base, target,
    payload: resolve(projectRoot, 'release', 'win-unpacked'),
    copyBase, payloadCopy: win32.join(copyBase, 'app'),
    probeProject: join(evidence, 'probe-project'), artifacts: join(evidence, 'probe-artifacts'),
    appId: `org.deepseek-harness-desktop.installer-qa.${identifier}`,
    productName: `DSH Installer Qualification ${identifier}`,
    packageName: `${prefix}${identifier}`, guid: identifier,
    installKey: `Software\\${identifier}`,
    uninstallKey: `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${identifier}`,
    uninstaller: win32.join(target, 'Uninstall DeepSeekHarness.exe') });
}

export function childEnvironment(environment = process.env) {
  const result = { ...environment };
  for (const name of Object.keys(result)) if (name.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete result[name];
  return result;
}

export function probeConfiguration(plan, version, electronVersion, include) {
  assert(/^\d+\.\d+\.\d+$/.test(version));
  assert(/^\d+\.\d+\.\d+$/.test(electronVersion));
  assert.equal(plan.appId, `org.deepseek-harness-desktop.installer-qa.${plan.identifier}`);
  assert.equal(plan.guid, plan.identifier);
  return {
    extends: null, appId: plan.appId, productName: plan.productName, electronVersion,
    directories: { app: plan.probeProject, output: plan.artifacts, buildResources: plan.probeProject },
    npmRebuild: false, protocols: [], fileAssociations: [], publish: [], detectUpdateChannel: false,
    win: { executableName: 'DeepSeekHarness', signAndEditExecutable: false, target: ['nsis'],
      artifactName: `DSH-Installer-QA-${plan.identifier}-\${version}.\${ext}` },
    nsis: { guid: plan.guid, oneClick: false, perMachine: false, allowElevation: false,
      allowToChangeInstallationDirectory: false, include, installerLanguages: ['zh_CN', 'en_US'],
      createDesktopShortcut: false, createStartMenuShortcut: false, runAfterFinish: false,
      deleteAppDataOnUninstall: false, uninstallDisplayName: plan.productName }
  };
}

export function probeInclude(plan, communityInclude) {
  const marker = '!macro customInit';
  assert.equal(communityInclude.split(marker).length, 2, 'Unexpected community installer template');
  let relocated = communityInclude;
  for (const name of ['community-installer-directories.nsh', 'community-process-guard.nsh']) {
    const reference = `"\${__FILEDIR__}\\${name}"`;
    assert(relocated.split(reference).length <= 2, 'Unexpected duplicated community include');
    relocated = relocated.replace(reference, `"${join(project, 'build', name)}"`);
  }
  // Keep the qualified directory transaction unchanged; only the QA entry-point guard is additional.
  // Define the deliberate QA override before a production !ifmacrondef/customCheckAppRunning include.
  return `; QA payload is never launched; the driver independently rejects running QA processes.
; Do not invoke production process handling against an installed desktop.
!macro customCheckAppRunning
!macroend
${relocated.replace(marker, '!macro dshQaOriginalInit')}
!if "\${APP_ID}" != "${plan.appId}"
  !error "Installer qualification requires its independent appId"
!endif
!if "\${APP_GUID}" != "${plan.guid}"
  !error "Installer qualification requires its independent GUID"
!endif
!macro customInit
  ; Only finite entry flags are recorded. No raw command line, user paths, or credentials.
  Push $R2
  Push $R3
  Push $R4
  FileOpen $R4 "${join(plan.evidence, 'entry-diagnostic.txt')}" w
  \${If} $INSTDIR == "${plan.target}"
    FileWrite $R4 "pathMatch=true$\\r$\\n"
  \${Else}
    FileWrite $R4 "pathMatch=false$\\r$\\n"
  \${EndIf}
  \${If} $installMode == "CurrentUser"
    FileWrite $R4 "currentUser=true$\\r$\\n"
  \${Else}
    FileWrite $R4 "currentUser=false$\\r$\\n"
  \${EndIf}
  \${If} \${isForAllUsers}
    FileWrite $R4 "allUsersParameter=true$\\r$\\n"
  \${Else}
    FileWrite $R4 "allUsersParameter=false$\\r$\\n"
  \${EndIf}
  \${GetRoot} "$INSTDIR" $R2
  \${If} $INSTDIR == $R2
  \${OrIf} $INSTDIR == "$R2\\"
    FileWrite $R4 "root=true$\\r$\\n"
  \${Else}
    FileWrite $R4 "root=false$\\r$\\n"
  \${EndIf}
  \${If} \${FileExists} "$INSTDIR\\*.*"
    FileWrite $R4 "directoryWildcardExists=true$\\r$\\n"
  \${Else}
    FileWrite $R4 "directoryWildcardExists=false$\\r$\\n"
  \${EndIf}
  FileClose $R4
  Pop $R4
  Pop $R3
  Pop $R2
  !insertmacro dshQaOriginalInit
  \${If} $INSTDIR != "${plan.target}"
    SetErrorLevel 2
    Quit
  \${EndIf}
!macroend
!macro customUnInit
  \${If} $INSTDIR != "${plan.target}"
    SetErrorLevel 2
    Quit
  \${EndIf}
  \${GetParameters} $R0
  ClearErrors
  \${GetOptions} $R0 "--delete-app-data" $R1
  \${IfNot} \${Errors}
    SetErrorLevel 2
    Quit
  \${EndIf}
!macroend
`;
}

async function exists(path) {
  try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function noLinkedAncestors(path) {
  let current = resolve(path);
  while (true) {
    try { assert(!(await lstat(current)).isSymbolicLink(), 'QA path contains a link or junction'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
}
async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function payloadInventory(directory) {
  const root = resolve(directory);
  await noLinkedAncestors(root);
  assert((await lstat(root)).isDirectory());
  const files = [];
  const directories = [];
  async function visit(current) {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(current, entry.name); const stat = await lstat(path);
      assert(!stat.isSymbolicLink(), 'Payload must not contain links or junctions');
      const name = relative(root, path).split(sep).join('/');
      if (stat.isDirectory()) { directories.push(name); await visit(path); }
      else { assert(stat.isFile(), 'Unsupported payload entry'); files.push({ path: name, size: stat.size, sha256: await sha256(path) }); }
    }
  }
  await visit(root);
  files.sort((a, b) => a.path.localeCompare(b.path)); directories.sort();
  return { files, directories, sha256: createHash('sha256').update(JSON.stringify({ files, directories })).digest('hex') };
}

/** Pure validation, kept separate from native filesystem checks for fail-closed guard tests. */
export function validateQualificationCandidate(candidate, lock, prepared, projectRoot = project) {
  assert.equal(candidate?.schemaVersion, 1, 'Unsupported candidate schema');
  assert.equal(candidate.kind, 'official-nsis-candidate', 'Unsupported candidate kind');
  assert.equal(candidate.version, lock.distributionVersion, 'Candidate distribution version is stale');
  assert.equal(prepared.version, lock.distributionVersion, 'Prepared distribution version is stale');
  assert.equal(prepared.officialCommit, lock.commit, 'Prepared official commit is stale');
  for (const key of ['officialCommit', 'overlaySha256', 'shellReceiptSha256', 'runtimeLockSha256']) {
    const pattern = key === 'officialCommit' ? /^[a-f0-9]{40}$/ : digestPattern;
    assert(pattern.test(prepared[key]), `Invalid prepared binding: ${key}`);
    assert.equal(candidate[key], prepared[key], `Stale candidate binding: ${key}`);
  }
  assert.equal(candidate.sourcePayloadUnchanged, true, 'Candidate source immutability was not established');
  assert(digestPattern.test(candidate.payloadSha256), 'Invalid candidate payload digest');
  assert(digestPattern.test(candidate.installerSha256), 'Invalid candidate installer digest');
  assert.equal(typeof candidate.payload, 'string');
  const match = /^C:\\DSHBP\\([^\\]+)\\app$/.exec(candidate.payload);
  assert(match && uuidPattern.test(match[1]), 'Candidate payload must be an owned C:\\DSHBP\\UUIDv4\\app');
  assert.equal(win32.resolve(candidate.payload), candidate.payload, 'Candidate path must be canonical');
  assert.equal(candidate.identity, match[1], 'Candidate identity does not match its owned path');
  assert.equal(win32.dirname(win32.dirname(candidate.payload)).toLowerCase(), 'c:\\dshbp');
  assert.equal(typeof candidate.installer, 'string');
  assert.equal(resolve(candidate.installer), candidate.installer, 'Candidate installer path must be absolute and canonical');
  assert.equal(dirname(candidate.installer), resolve(projectRoot, 'release'), 'Candidate installer must be in the release output');
  assert(candidate.installer.endsWith('.exe'), 'Candidate installer must be an executable');
  return candidate;
}

export async function verifyQualificationPayloadBindings(payload, lock, prepared, projectRoot = project) {
  if (prepared) {
    assert.equal(await sha256(join(projectRoot, 'desktop/official-overlay.patch')), prepared.overlaySha256,
      'The current official overlay differs from the prepared candidate');
    assert.equal(await sha256(join(projectRoot, 'official-runtime.lock.yaml')), prepared.runtimeLockSha256,
      'The current runtime lock differs from the prepared candidate');
  }
  const asar = require('@electron/asar');
  const archive = join(payload, 'resources/app.asar');
  await noLinkedAncestors(archive);
  const manifest = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
  verifyCommunityHostPort(asar.extractFile(archive, join('dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js')));
  assert.equal(manifest.version, lock.distributionVersion, 'Packaged distribution version is stale');
  assert.equal(manifest.main, 'desktop/launcher.cjs', 'Packaged desktop entry point is unexpected');
  assert.equal(manifest.dshOfficialCommit, lock.commit, 'Packaged official commit is stale');
  assert.equal(manifest.dshOfficialVersion, lock.version, 'Packaged official version is stale');
  if (prepared) {
    const receipt = asar.extractFile(archive, 'shell-dependency-receipt.json');
    assert.equal(createHash('sha256').update(receipt).digest('hex'), prepared.shellReceiptSha256,
      'Packaged shell receipt differs from the prepared candidate');
    assert.equal(typeof prepared.staging, 'string', 'The prepared staging path is missing');
    const staged = JSON.parse(await readFile(join(prepared.staging, 'package.json'), 'utf8'));
    for (const key of ['version', 'main', 'dshOfficialCommit', 'dshOfficialVersion']) {
      assert.equal(staged[key], manifest[key], `Stale staged candidate identity: ${key}`);
    }
  }
  for (const file of ['launcher.cjs', 'recovery.cjs', 'watchdog.cjs', 'health-window.cjs']) {
    const current = await readFile(join(projectRoot, 'desktop', file));
    assert.deepEqual(asar.extractFile(archive, `desktop/${file}`), current, `Stale packaged desktop wrapper: ${file}`);
    if (file === 'recovery.cjs' || file === 'watchdog.cjs') {
      assert.deepEqual(await readFile(join(payload, 'resources/recovery', file)), current,
        `Stale external recovery wrapper: ${file}`);
    }
  }
  return manifest;
}

/** Inert on import. Prefer the final NSIS payload; never silently fall back from an invalid record. */
export async function selectQualificationPayload(projectRoot = project) {
  const root = resolve(projectRoot);
  const lock = JSON.parse(await readFile(join(root, 'official.lock.json'), 'utf8'));
  const record = join(root, '.official-build', 'candidate.json');
  await noLinkedAncestors(record);
  if (!(await exists(record))) {
    const payload = join(root, 'release', 'win-unpacked');
    const inventory = await payloadInventory(payload);
    await verifyQualificationPayloadBindings(payload, lock, null, root);
    return { kind: 'development-unpacked', version: lock.distributionVersion,
      payload, payloadSha256: inventory.sha256, inventory, candidate: null };
  }
  const candidate = JSON.parse(await readFile(record, 'utf8'));
  const prepared = JSON.parse(await readFile(join(root, '.official-build', 'paths.json'), 'utf8'));
  validateQualificationCandidate(candidate, lock, prepared, root);
  const ownershipPath = join(dirname(candidate.payload), 'ownership.json');
  await noLinkedAncestors(ownershipPath);
  const ownership = JSON.parse(await readFile(ownershipPath, 'utf8'));
  assert.deepEqual(ownership, candidate, 'Candidate ownership record mismatch');
  const inventory = await payloadInventory(candidate.payload);
  assert.equal(inventory.sha256, candidate.payloadSha256, 'Final candidate payload digest mismatch');
  const manifest = await verifyQualificationPayloadBindings(candidate.payload, lock, prepared, root);
  await verifyCommunityUpdateConfiguration(join(candidate.payload, 'resources'), manifest.name);
  await noLinkedAncestors(candidate.installer);
  assert((await lstat(candidate.installer)).isFile(), 'Candidate installer is not a physical file');
  assert.equal(await sha256(candidate.installer), candidate.installerSha256, 'Final candidate installer digest mismatch');
  return { kind: candidate.kind, version: candidate.version, payload: candidate.payload,
    payloadSha256: inventory.sha256, inventory, candidate };
}

/** Copy to a fresh owned tree before giving any path to a mutating builder. */
export async function copyQualificationPayload(source, destination, expected) {
  const origin = resolve(source); const copy = resolve(destination);
  const originComparison = process.platform === 'win32' ? origin.toLowerCase() : origin;
  const copyComparison = process.platform === 'win32' ? copy.toLowerCase() : copy;
  assert.notEqual(originComparison, copyComparison, 'The QA copy cannot be the sealed source');
  assert(!copyComparison.startsWith(`${originComparison}${sep}`), 'The QA copy cannot be nested in the sealed source');
  await noLinkedAncestors(origin); await noLinkedAncestors(copy);
  assert(!(await exists(copy)), 'The QA payload copy must be fresh');
  assert.equal((await payloadInventory(origin)).sha256, expected.sha256, 'Source changed before the QA copy');
  await cp(origin, copy, { recursive: true, force: false, errorOnExist: true, dereference: false, verbatimSymlinks: true });
  const copied = await payloadInventory(copy);
  assert.deepEqual(copied, expected, 'The independent QA copy differs from its sealed source');
  assert.equal((await payloadInventory(origin)).sha256, expected.sha256, 'Copying changed the sealed source');
  return copied;
}

export function validateProbeUpdateMetadata(metadata, updaterCacheDirName) {
  assert(metadata && typeof metadata === 'object' && !Array.isArray(metadata), 'Invalid NSIS update metadata');
  assert.equal(metadata.provider, 'github');
  assert.equal(metadata.owner, 'pyljjun2009-sketch');
  assert.equal(metadata.repo, 'deepseek-harness-desktop');
  assert(metadata.channel === undefined || metadata.channel === 'latest', 'Unexpected update channel');
  assert.equal(metadata.updaterCacheDirName, updaterCacheDirName, 'Unexpected updater cache identity');
  for (const key of Object.keys(metadata)) {
    assert(['provider', 'owner', 'repo', 'channel', 'updaterCacheDirName'].includes(key), 'Unexpected update metadata field');
  }
}

/** All changed bytes must be known builder-owned metadata with a verified identity. */
export async function verifyProbePayloadMetadata(before, after, directory, plan, trustedElevate) {
  const allowed = new Set(['resources/elevate.exe', 'resources/app-update.yml']);
  const initial = new Map(before.files.map(file => [file.path, file]));
  const final = new Map(after.files.map(file => [file.path, file]));
  assert.deepEqual(after.directories, before.directories, 'NSIS changed payload directories');
  const changes = [];
  for (const file of before.files) {
    assert(final.has(file.path), 'NSIS removed an original payload file');
    if (!allowed.has(file.path)) assert.deepEqual(final.get(file.path), file, `NSIS changed a non-metadata payload file: ${file.path}`);
  }
  for (const file of after.files) {
    assert(initial.has(file.path) || allowed.has(file.path), 'Unexpected NSIS-owned payload addition');
    if (JSON.stringify(initial.get(file.path)) !== JSON.stringify(file)) {
      assert(allowed.has(file.path), 'Unexpected NSIS payload mutation');
      changes.push({ path: file.path, action: initial.has(file.path) ? 'replaced' : 'added', sha256: file.sha256 });
    }
  }
  const elevate = final.get('resources/elevate.exe');
  if (elevate) {
    assert(digestPattern.test(trustedElevate?.sha256));
    assert.equal(elevate.size, trustedElevate.size, 'Unexpected NSIS elevation helper size');
    assert.equal(elevate.sha256, trustedElevate.sha256, 'Unexpected NSIS elevation helper bytes');
  }
  if (changes.some(change => change.path === 'resources/app-update.yml')) {
    // With publish:[] no update file should normally be written. If a builder writes one,
    // it must identify only the private QA cache, not redirect downloads or access a real cache.
    const yaml = require('js-yaml');
    const text = await readFile(join(directory, 'resources/app-update.yml'), 'utf8');
    assert(Buffer.byteLength(text) <= 4096, 'Oversized NSIS update metadata');
    validateProbeUpdateMetadata(yaml.load(text, { schema: yaml.JSON_SCHEMA }), `${plan.packageName}-updater`);
  }
  return changes;
}

export function verifyInstalledPayload(expected, actual) {
  const installed = new Map(actual.files.map(file => [file.path, file]));
  for (const file of expected.files) assert.deepEqual(installed.get(file.path), file, `Payload changed: ${file.path}`);
  const original = new Set(expected.files.map(file => file.path));
  for (const file of actual.files) if (!original.has(file.path)) assert(extraInstalledFiles.has(file.path), `Unexpected installed file: ${file.path}`);
  for (const directory of expected.directories) assert(actual.directories.includes(directory), `Payload directory missing: ${directory}`);
  assert.deepEqual([...actual.directories].sort(), [...expected.directories].sort(), 'Unexpected installed payload directory');
  assert(installed.has('Uninstall DeepSeekHarness.exe'), 'The independent probe uninstaller is missing');
  return { payloadFileCount: expected.files.length, payloadSha256: expected.sha256,
    extraFiles: actual.files.filter(file => !original.has(file.path)).map(file => file.path) };
}

async function powershell(script, environment = {}) {
  const result = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ${script}`],
  { env: childEnvironment({ ...process.env, ...environment }), windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 });
  return JSON.parse(result.stdout.trim() || 'null');
}

async function registryRecords(keys) {
  // Probe only installation metadata. Never enumerate account or credential keys.
  return powershell(`$items = ConvertFrom-Json $env:DSH_QA_KEYS; $records = @();
foreach ($item in $items) {
  foreach ($view in @([Microsoft.Win32.RegistryView]::Registry32, [Microsoft.Win32.RegistryView]::Registry64)) {
    $hive = [Microsoft.Win32.RegistryHive]::$($item.hive);
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view);
    $key = $base.OpenSubKey($item.path);
    try {
      if ($null -eq $key) { $records += @{ hive=$item.hive; view=$view.ToString(); path=$item.path; values=$null } }
      else { $values = @{}; foreach ($name in ($key.GetValueNames() | Sort-Object)) { $values[$name] = $key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }; $records += @{ hive=$item.hive; view=$view.ToString(); path=$item.path; values=$values } }
    } finally { if ($null -ne $key) { $key.Dispose() }; $base.Dispose() }
  }
}
ConvertTo-Json -Depth 8 -Compress -InputObject @($records)`, { DSH_QA_KEYS: JSON.stringify(keys) });
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const recordDigest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function qualificationError(error) {
  // Never record the full builder exception: it can contain downloader URLs or complete commands.
  const message = typeof error?.message === 'string' ? error.message : '';
  const diagnostic = { kind: error?.name === 'AssertionError' ? 'assertion' : 'operation' };
  if (typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,80}$/.test(error.code)) diagnostic.code = error.code;
  if (Number.isSafeInteger(error?.code)) diagnostic.nativeExitCode = error.code;
  if (Number.isSafeInteger(error?.exitCode)) diagnostic.exitCode = error.exitCode;
  if (/timed out after 4 minutes/.test(message)) diagnostic.reason = 'nsis-compiler-timeout';
  else if (/smaller than the embedded archive/.test(message)) diagnostic.reason = 'truncated-installer';
  else if (/Generated installer was not created/.test(message)) diagnostic.reason = 'missing-installer';
  else if (/Release qualification requires the final NSIS candidate record/.test(message)) diagnostic.reason = 'final-candidate-record-required';
  else if (/Candidate ownership record mismatch/.test(message)) diagnostic.reason = 'candidate-ownership-mismatch';
  else if (/Final candidate payload digest mismatch/.test(message)) diagnostic.reason = 'candidate-payload-digest-mismatch';
  else if (/Final candidate installer digest mismatch/.test(message)) diagnostic.reason = 'candidate-installer-digest-mismatch';
  else if (/Stale candidate binding|Candidate distribution version is stale/.test(message)) diagnostic.reason = 'candidate-build-binding-mismatch';
  else if (/Unexpected community update feed/.test(message)) diagnostic.reason = 'candidate-update-feed-mismatch';
  const warningCodes = [...message.matchAll(/warning\s+(\d{4}):/gi)].map(match => Number(match[1]));
  if (warningCodes.length) diagnostic.warningCodes = [...new Set(warningCodes)];
  const scriptLine = /Error in script[^\r\n]*on line (\d+)/i.exec(message);
  if (scriptLine) diagnostic.scriptErrorLine = Number(scriptLine[1]);
  return diagnostic;
}

async function assertNoQaProcesses(plan) {
  const count = await powershell(`$target = $env:DSH_QA_TARGET.TrimEnd('\\') + '\\';
@((Get-CimInstance Win32_Process) | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($target, [StringComparison]::OrdinalIgnoreCase) }).Count | ConvertTo-Json -Compress`,
  { DSH_QA_TARGET: plan.base });
  assert.equal(count, 0, 'A QA payload process is running; refuse installer process handling');
}
async function assertNoTransactionLeftovers(plan) {
  const entries = await readdir(plan.base);
  assert.deepEqual(entries, ['app'], 'Installer left a staging or backup directory');
}

async function ensureProbeRegistration(plan) {
  const entries = await registryRecords([{ hive: 'CurrentUser', path: plan.installKey },
    { hive: 'CurrentUser', path: plan.uninstallKey }]);
  const installation = entries.find(entry => entry.view === 'Registry64' && entry.path === plan.installKey);
  const uninstall = entries.find(entry => entry.view === 'Registry64' && entry.path === plan.uninstallKey);
  assert.equal(win32.resolve(installation?.values?.InstallLocation ?? ''), plan.target);
  assert.equal(uninstall?.values?.DisplayName, plan.productName);
  assert.equal(uninstall?.values?.UninstallString, `"${plan.uninstaller}" /currentuser`);
}

/** Requires an already sealed candidate. Builders only receive the fresh QA copy. Invoke with --run. */
export async function qualifyOfficialInstaller() {
  assert.equal(process.platform, 'win32', 'Native installer qualification requires Windows');
  const selected = await selectQualificationPayload();
  assert.equal(selected.kind, 'official-nsis-candidate', 'Release qualification requires the final NSIS candidate record');
  const plan = Object.freeze({ ...installerQualificationPlan(randomUUID()), payload: selected.payload });
  const lock = JSON.parse(await readFile(join(project, 'official.lock.json'), 'utf8'));
  const version = lock.distributionVersion;
  const electronVersion = require('electron/package.json').version;
  const keys = [{ hive: 'CurrentUser', path: plan.installKey }, { hive: 'CurrentUser', path: plan.uninstallKey },
    { hive: 'LocalMachine', path: plan.installKey }, { hive: 'LocalMachine', path: plan.uninstallKey }];
  require('app-builder-lib');
  const { UUID } = require('builder-util-runtime');
  const productionGuid = UUID.v5('com.deepseek.harness.desktop', UUID.parse('50e065bc-3134-11e6-9bab-38c9862bdaf3'));
  assert.notEqual(plan.guid, productionGuid);
  const protectedKeys = ['CurrentUser', 'LocalMachine'].flatMap(hive => [
    { hive, path: `Software\\${productionGuid}` },
    { hive, path: `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${productionGuid}` },
    { hive, path: 'Software\\Classes\\dsh' }
  ]);
  const protectedBefore = recordDigest(await registryRecords(protectedKeys));
  assert((await registryRecords(keys)).every(record => record.values === null), 'QA registry identity already exists');
  await noLinkedAncestors(plan.base); await noLinkedAncestors(plan.evidence);
  assert(!(await exists(plan.base)) && !(await exists(plan.evidence)), 'QA paths must be fresh');
  await noLinkedAncestors(plan.copyBase);
  assert(!(await exists(plan.copyBase)), 'The independent QA build-input namespace must be fresh');
  const cache = resolve(process.env.LOCALAPPDATA, `${plan.packageName}-updater`);
  await noLinkedAncestors(cache); assert(!(await exists(cache)), 'QA installer cache must be fresh');
  await mkdir(plan.evidence, { recursive: false });
  await mkdir(plan.probeProject); await mkdir(plan.artifacts);
  const report = { schemaVersion: 1, test: 'official-desktop-isolated-full-installer', version,
    guid: plan.guid, appId: plan.appId, modelCalls: 0, payloadLaunched: false,
    candidateKind: selected.kind, candidatePayloadSha256: selected.payloadSha256,
    candidateInstallerSha256: selected.candidate?.installerSha256 ?? null,
    productionProcessHandlingCovered: false, rounds: [], passed: false, phase: 'preparation' };
  let registrationOwned = false;
  let installer;
  let original;
  let uninstallSha;
  try {
    await mkdir('C:\\DSHQI', { recursive: true });
    await noLinkedAncestors(plan.base); await mkdir(plan.base); await mkdir(plan.target);
    await writeFile(join(plan.evidence, 'ownership.json'), `${JSON.stringify(plan, null, 2)}\n`);
    report.phase = 'payload-inventory'; original = await payloadInventory(plan.payload);
    assert.equal(original.sha256, selected.payloadSha256, 'The selected candidate changed before qualification');
    assert(original.files.some(file => file.path === 'DeepSeekHarness.exe'));
    assert(original.files.some(file => file.path === 'resources/app.asar'));
    await writeFile(join(plan.evidence, 'payload-manifest.json'), `${JSON.stringify(original, null, 2)}\n`);
    report.phase = 'owned-payload-copy';
    assert.equal(win32.dirname(plan.copyBase).toLowerCase(), 'c:\\dshqb');
    assert.equal(win32.dirname(plan.payloadCopy), plan.copyBase);
    assert.equal(win32.basename(plan.payloadCopy), 'app');
    await mkdir('C:\\DSHQB', { recursive: true });
    await noLinkedAncestors(plan.copyBase); await mkdir(plan.copyBase);
    await writeFile(join(plan.copyBase, 'ownership.json'), `${JSON.stringify(plan, null, 2)}\n`);
    await copyQualificationPayload(plan.payload, plan.payloadCopy, original);
    const { getNsisElevatePath } = require('app-builder-lib/out/toolsets/windows.js');
    const elevatePath = await getNsisElevatePath();
    await noLinkedAncestors(elevatePath);
    const trustedElevate = { size: (await lstat(elevatePath)).size, sha256: await sha256(elevatePath) };
    await writeFile(join(plan.probeProject, 'package.json'), `${JSON.stringify({ name: plan.packageName, version,
      private: true, author: 'DeepSeek Harness Desktop QA', description: 'Isolated installer qualification; no application launch' }, null, 2)}\n`);
    const includeText = await readFile(join(project, 'build/community-installer.nsh'), 'utf8');
    const include = join(plan.probeProject, 'probe-installer.nsh');
    await writeFile(include, probeInclude(plan, includeText));
    installWindowsCommunityInstaller();
    for (const key of Object.keys(process.env)) if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete process.env[key];
    const { build, Platform, Arch } = require('electron-builder');
    report.phase = 'probe-build';
    const artifacts = await build({ projectDir: plan.probeProject, prepackaged: plan.payloadCopy,
      targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64), publish: 'never',
      config: probeConfiguration(plan, version, electronVersion, include) });
    installer = artifacts.find(file => file.endsWith('.exe') && dirname(resolve(file)) === resolve(plan.artifacts));
    assert(installer, 'Probe builder did not return its independent installer');
    report.phase = 'sealed-payload-recheck';
    assert.equal((await payloadInventory(plan.payload)).sha256, original.sha256, 'Prepackaged build changed the sealed payload');
    const finalCopy = await payloadInventory(plan.payloadCopy);
    report.metadataChanges = await verifyProbePayloadMetadata(original, finalCopy, plan.payloadCopy, plan, trustedElevate);
    report.finalQaPayloadSha256 = finalCopy.sha256;
    report.candidatePayloadExactlyPreserved = finalCopy.sha256 === original.sha256;
    report.metadataOnlyDifference = report.metadataChanges.length > 0;
    await writeFile(join(plan.evidence, 'final-copy-manifest.json'), `${JSON.stringify(finalCopy, null, 2)}\n`);
    report.installerSha256 = await sha256(installer);
    for (let round = 1; round <= 2; round++) {
      await assertNoQaProcesses(plan); await noLinkedAncestors(plan.target);
      assert.equal(win32.resolve(plan.target), win32.join(plan.base, 'app'));
      report.phase = `install-${round}`;
      await run(installer, ['/S', '/currentuser', `/D=${plan.target}`],
        { windowsHide: true, env: childEnvironment(), timeout: 180000, maxBuffer: 1024 * 1024 });
      await ensureProbeRegistration(plan); registrationOwned = true;
      report.phase = `installed-payload-verification-${round}`;
      const installed = await payloadInventory(plan.target);
      const result = verifyInstalledPayload(finalCopy, installed);
      uninstallSha = await sha256(plan.uninstaller);
      await assertNoQaProcesses(plan); await assertNoTransactionLeftovers(plan);
      report.rounds.push({ round, action: round === 1 ? 'clean-install' : 'same-version-replacement',
        ...result, independentRegistration: true, noTransactionLeftovers: true });
      console.log(`Isolated full installer round ${round}: all ${result.payloadFileCount} payload files verified`);
    }
    assert.equal((await payloadInventory(plan.payload)).sha256, original.sha256);
    assert.equal((await payloadInventory(plan.payloadCopy)).sha256, finalCopy.sha256, 'QA build input changed after installation');
    report.sourcePayloadUnchanged = true;
  } catch (error) {
    report.failedPhase = report.phase;
    report.diagnostic = qualificationError(error);
    report.error = error?.name === 'AssertionError' ? 'installer-qualification-assertion-failed' : 'installer-qualification-incomplete';
    console.error(report.error);
  } finally {
    report.phase = 'owned-probe-cleanup';
    try {
      // Only run the exact uninstaller whose private path, registration, and bytes we just verified.
      if (registrationOwned || (await exists(plan.uninstaller))) {
        await ensureProbeRegistration(plan); await assertNoQaProcesses(plan); await noLinkedAncestors(plan.uninstaller);
        const observedSha = await sha256(plan.uninstaller);
        if (uninstallSha) assert.equal(observedSha, uninstallSha);
        const ownedCopy = join(plan.evidence, 'probe-uninstaller.exe');
        assert(!(await exists(ownedCopy))); await copyFile(plan.uninstaller, ownedCopy);
        assert.equal(await sha256(ownedCopy), observedSha);
        await run(ownedCopy, ['/S', '/currentuser', '/KEEP_APP_DATA', `_?=${plan.target}`],
          { windowsHide: true, env: childEnvironment(), timeout: 180000, maxBuffer: 1024 * 1024 });
        assert(!(await exists(plan.target)), 'Probe application directory survived uninstall');
        assert((await registryRecords(keys)).every(record => record.values === null), 'Probe registry entries survived uninstall');
        assert.deepEqual(await readdir(plan.base), []); await rmdir(plan.base);
        report.independentUninstall = true;
      } else if ((await exists(plan.target)) && (await readdir(plan.target)).length === 0) {
        // A failed build has not registered or installed anything. Remove only the two fresh empty directories.
        assert((await registryRecords(keys)).every(record => record.values === null));
        await noLinkedAncestors(plan.target); await rmdir(plan.target);
        assert.deepEqual(await readdir(plan.base), []); await rmdir(plan.base);
        report.emptyUninstalledProbeRemoved = true;
      }
      if (await exists(cache)) {
        await noLinkedAncestors(cache);
        assert.deepEqual(await readdir(cache), ['installer.exe'], 'Unexpected QA cache entry; preserve it');
        const cachedInstaller = join(cache, 'installer.exe');
        assert.equal(await sha256(cachedInstaller), report.installerSha256);
        await unlink(cachedInstaller); await rmdir(cache); report.qaInstallerCacheRemoved = true;
      }
      assert.equal(recordDigest(await registryRecords(protectedKeys)), protectedBefore, 'Production installation or dsh protocol registration changed');
      report.productionRegistrationUnchanged = true;
      report.passed = report.rounds.length === 2 && report.sourcePayloadUnchanged === true && report.independentUninstall === true;
      report.phase = report.passed ? 'complete' : 'failed';
    } catch { report.cleanupError = 'owned-probe-cleanup-or-protected-registration-check-failed'; }
    await writeFile(join(plan.evidence, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ ...report, evidence: join(plan.evidence, 'report.json') }, null, 2));
  }
  if (!report.passed || report.cleanupError) throw new Error('Installer qualification failed; inspect its private report');
  return report;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 3 || process.argv[2] !== '--run') {
    console.error('Run only after the candidate payload is sealed: node scripts/qualify-official-installer.mjs --run');
    process.exitCode = 2;
  } else {
    await qualifyOfficialInstaller().catch(error => {
      console.error(JSON.stringify({ error: 'installer-qualification-failed', diagnostic: qualificationError(error) }));
      process.exitCode = 1;
    });
  }
}
