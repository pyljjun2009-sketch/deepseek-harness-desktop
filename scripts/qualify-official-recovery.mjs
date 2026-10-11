/** Real crash qualification, restricted to a freshly owned isolated home. No model calls or user installation. */
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import { resolve, join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import recoveryModule from '../desktop/recovery.cjs';
import { selectQualificationPayload, payloadInventory } from './qualify-official-installer.mjs';

const run = promisify(execFile);
if (process.platform !== 'win32' || !process.argv.includes('--run')) {
  console.log('Windows isolated real-crash qualification requires explicit --run. No application was started.');
  process.exit(0);
}
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(await readFile(join(project, 'official.lock.json'), 'utf8')).distributionVersion;
assert(/^\d+\.\d+\.\d+$/.test(version));
const selected = await selectQualificationPayload(project);
assert.equal(selected.kind, 'official-nsis-candidate', 'Final NSIS candidate record is required for release qualification');
assert.equal(selected.version, version);
const executable = join(selected.payload, 'DeepSeekHarness.exe');
const identity = randomUUID();
const test = join(project, '.official-build', `recovery-qualification-${identity}`);
// Keep the 1 GB / ~10,000 file snapshot outside OneDrive and well within the Windows path budget.
const scratch = resolve('C:/DSHRQ');
const home = join(scratch, identity, 'home');
assert.equal(dirname(dirname(home)), scratch);
const result = join(test, 'healthy.json');
const processFile = join(home, 'qualification-process.json');
const stateFile = join(home, 'official-recovery/state.json');
const cachedExecutable = join(home, 'stable-releases', version, 'DeepSeekHarness.exe');
const env = { ...process.env, DSH_COMMUNITY_TEST_ROOT: home, DSH_COMMUNITY_EXERCISE_RECOVERY: '1',
  DSH_COMMUNITY_SMOKE_RESULT: result, PYTHONDONTWRITEBYTECODE: '1' };
delete env.ELECTRON_RUN_AS_NODE;
await mkdir(scratch, { recursive: true });
assert((await lstat(scratch)).isDirectory() && !(await lstat(scratch)).isSymbolicLink());
await mkdir(dirname(home)); // Fail rather than reuse an existing identity.
await mkdir(home);
await mkdir(test, { recursive: true });
const delay = ms => new Promise(accept => setTimeout(accept, ms));
const json = async path => { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return undefined; } };
let phase = 'initial-start';
const began = Date.now();
const records = new Map();
const identities = new Map();
let initialPid;
async function until(check, timeout = 600000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(500); }
  throw Object.assign(new Error('Qualification deadline reached'), { code: 'QA_DEADLINE' });
}
function validRecord(record) {
  assert(Number.isSafeInteger(record?.pid) && record.pid > 0);
  assert([executable, cachedExecutable].includes(resolve(record.executable)));
  assert.equal(resolve(record.home), join(home, 'official-homes', `home-${version}`));
  assert.equal(dirname(record.watchdogControl), join(home, 'official-recovery'));
  const token = /^watchdog-([a-f0-9-]{36})\.control$/.exec(basename(record.watchdogControl))?.[1];
  assert(token && Number.isSafeInteger(record.watchdogPid) && record.watchdogPid > 0);
  records.set(record.pid, record);
  return token;
}
async function processInfo(pid) {
  assert(Number.isSafeInteger(pid) && pid > 0);
  const answer = await run('powershell.exe', ['-NoProfile', '-Command',
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Get-CimInstance Win32_Process -Filter "ProcessId = $env:DSH_QA_PID" | Select-Object ProcessId,ExecutablePath,CommandLine,@{Name="Created";Expression={$_.CreationDate.ToUniversalTime().Ticks.ToString()}} | ConvertTo-Json -Compress'],
  { windowsHide: true, env: { ...process.env, DSH_QA_PID: String(pid) }, timeout: 15000 });
  return JSON.parse(answer.stdout || 'null');
}
function remember(actual, expectedExecutable) {
  assert(Number.isSafeInteger(actual?.ProcessId) && typeof actual.Created === 'string');
  assert.equal(resolve(actual.ExecutablePath), resolve(expectedExecutable));
  const prior = identities.get(actual.ProcessId);
  if (prior) assert.equal(actual.Created, prior.Created, 'QA PID was reused');
  else identities.set(actual.ProcessId, { Created: actual.Created, executable: resolve(expectedExecutable) });
}
async function marker(record) {
  const token = validRecord(record);
  // The UUID storage belongs to this run, but still reject any linked control or ancestor.
  for (const path of [scratch, dirname(home), home, dirname(record.watchdogControl)]) {
    const stat = await lstat(path); assert(stat.isDirectory() && !stat.isSymbolicLink());
  }
  try { const stat = await lstat(record.watchdogControl); assert(stat.isFile() && !stat.isSymbolicLink()); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await writeFile(record.watchdogControl, token, { mode: 0o600 });
}
async function owned(record) {
  validRecord(record);
  const actual = await processInfo(record.pid);
  assert.equal(actual?.ProcessId, record.pid);
  remember(actual, record.executable);
  const dog = await processInfo(record.watchdogPid);
  if (dog) {
    remember(dog, record.executable);
    assert(dog.CommandLine.includes(record.watchdogControl) && dog.CommandLine.includes(home) &&
      dog.CommandLine.includes(validRecord(record)));
  }
  return record;
}
async function cleanup() {
  const summary = { passed: false, primaryStopped: 0, watchdogsStopped: 0 };
  try {
    // Stop every known watchdog before touching its primary, even when the primary has already exited.
    // Observe a possible in-flight relaunch; never terminate by name or an unvalidated PID.
    for (let attempt = 0; attempt < 4; attempt++) {
      const latest = await json(processFile);
      if (latest) validRecord(latest);
      for (const record of records.values()) await marker(record);
      let alive = false;
      for (const record of records.values()) {
        const actual = await processInfo(record.pid);
        if (actual) {
          remember(actual, record.executable);
          process.kill(record.pid);
          summary.primaryStopped++;
          alive = true;
        }
      }
      // The initial child is directly owned even if prepare failed before it could write its record.
      if (initialPid && !records.has(initialPid)) {
        const initial = await processInfo(initialPid);
        if (initial) { remember(initial, executable); process.kill(initialPid); summary.primaryStopped++; alive = true; }
      }
      if (alive) await delay(2500);
      let dogsAlive = false;
      for (const record of records.values()) {
        const dog = await processInfo(record.watchdogPid);
        if (!dog) continue;
        remember(dog, record.executable);
        assert(dog.CommandLine.includes(record.watchdogControl) && dog.CommandLine.includes(home) &&
          dog.CommandLine.includes(validRecord(record)));
        dogsAlive = true;
        if (attempt === 3) {
          process.kill(record.watchdogPid);
          summary.watchdogsStopped++;
        }
      }
      if (!alive && !dogsAlive) {
        if (initialPid && records.size === 0) { summary.error = 'process-record-unavailable'; return summary; }
        summary.passed = true; return summary;
      }
      await delay(2500);
    }
    const remaining = await Promise.all([...records.values()].flatMap(record =>
      [processInfo(record.pid), processInfo(record.watchdogPid)]));
    summary.passed = remaining.every(value => !value) && (!initialPid || !(await processInfo(initialPid)));
  } catch { summary.error = 'owned-process-cleanup-unconfirmed'; }
  return summary; // Retain all files for diagnostics. Cleanup failure can never count as qualification success.
}
let active;
const report = { schemaVersion: 1, test: 'official-desktop-real-crash', version,
  candidateKind: selected.kind, candidatePayloadSha256: selected.payloadSha256,
  candidateInstallerSha256: selected.candidate?.installerSha256 ?? null,
  productionProbationMs: 45000, modelCalls: 0, rounds: [], passed: false };
try {
  const started = spawn(executable, [], { env, windowsHide: true, stdio: 'ignore' });
  await new Promise((accept, reject) => { started.once('spawn', accept); started.once('error', reject); });
  initialPid = started.pid;
  const firstProcess = await processInfo(initialPid);
  remember(firstProcess, executable);
  started.unref();
  active = await until(async () => { const value = await json(processFile); return value?.pid === started.pid && value; });
  await owned(active);
  phase = 'production-probation-and-snapshot';
  console.log('Waiting for production 45s probation and complete snapshot (10 minute qualification budget)');
  await until(async () => {
    const healthy = await json(result); const state = await json(stateFile);
    return healthy?.pid === active.pid && state?.stable?.manifestSha256 && state.failures === 0;
  });
  report.completeSnapshot = true;
  assert.equal(resolve(new recoveryModule.DesktopRecovery(home, version, dirname(executable)).fallbackRelease().executable), cachedExecutable);
  console.log('Production 45s probation and complete stable snapshot passed');
  for (let round = 1; round <= 3; round++) {
    phase = `unclean-exit-${round}`;
    const before = active.pid;
    await owned(active);
    process.kill(before); // Exactly the owned primary process, never the installed app or a process group.
    active = await until(async () => { const value = await json(processFile); return value?.pid !== before && value; });
    await owned(active);
    const state = await json(stateFile);
    if (round < 3) {
      assert.equal(state.failures, round);
      assert.equal(resolve(active.executable), executable);
    } else {
      assert.equal(state.failures, 0);
      assert.equal(state.rejected, version);
      assert.equal(resolve(active.executable), cachedExecutable);
      assert.equal(state.active, state.stable.version);
      assert.equal(state.home, state.stable.home);
    }
    report.rounds.push({ round, action: round === 1 ? 'retry' : round === 2 ? 'disable-plugins' : 'verified-cache',
      newPrimary: active.pid !== before, pairedHome: true, failures: state.failures });
    console.log(`Real unclean-exit round ${round}: ${report.rounds.at(-1).action} passed`);
  }
  phase = 'cached-host-health';
  await until(async () => (await json(result))?.pid === active.pid);
  report.cachedHostHealthy = true;
  report.passed = true;
} catch (error) {
  report.error = error?.name === 'AssertionError' ? 'qualification-assertion-failed' : 'qualification-incomplete';
  report.failedPhase = phase;
  if (error?.code === 'QA_DEADLINE') report.error = 'qualification-deadline';
  process.exitCode = 1;
} finally {
  report.cleanup = await cleanup();
  if (!report.cleanup.passed) { report.passed = false; process.exitCode = 1; }
  try {
    assert.equal((await payloadInventory(selected.payload)).sha256, selected.payloadSha256,
      'Recovery qualification modified the sealed candidate payload');
    report.sourcePayloadUnchanged = true;
  } catch {
    report.sourcePayloadUnchanged = false; report.passed = false; process.exitCode = 1;
  }
  report.elapsedMs = Date.now() - began;
  report.isolatedHome = home;
  await writeFile(join(test, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ...report, evidence: join(test, 'report.json') }, null, 2));
}
