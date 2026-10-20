import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { main, manualCheckNames, validateAutomaticReadiness, validateManualReadiness,
  validateReportReferences, validateStableReadiness } from './verify-stable-readiness.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = fileURLToPath(new URL('./verify-stable-readiness.mjs', import.meta.url));
const run = promisify(execFile);
const yaml = createRequire(import.meta.url)('js-yaml');
const candidateIdentity = 'a1234567-1234-4567-8123-123456789abc';
const installerIdentity = 'b1234567-1234-4567-9123-123456789abc';
const recoveryIdentity = 'c1234567-1234-4567-a123-123456789abc';
const otherIdentity = 'd1234567-1234-4567-b123-123456789abc';

// These dates and every attestation below are synthetic, in-memory unit fixtures.
// They do not describe a human acceptance run or create stable-readiness.json.
const syntheticNow = () => new Date('2030-01-03T00:00:00.000Z');
const candidateFixture = () => ({ schemaVersion: 1, kind: 'official-nsis-candidate', version: '0.5.0',
  identity: candidateIdentity, officialCommit: 'a'.repeat(40), payloadSha256: 'b'.repeat(64),
  installerSha256: 'c'.repeat(64), sourcePayloadUnchanged: true });
const referenceFixture = () => ({ installer: `installer-qualification-${installerIdentity}/report.json`,
  recovery: `recovery-qualification-${recoveryIdentity}/report.json`, ui: 'public-ui-summary.json' });
function automaticFixture(candidate = candidateFixture()) {
  const bound = { schemaVersion: 1, version: candidate.version, candidatePayloadSha256: candidate.payloadSha256,
    candidateInstallerSha256: candidate.installerSha256 };
  const qualification = { ...bound, passed: true, sourcePayloadUnchanged: true, modelCalls: 0,
    candidateKind: candidate.kind };
  return {
    installer: { ...qualification, test: 'official-desktop-isolated-full-installer', phase: 'complete',
      guid: installerIdentity, payloadLaunched: false, productionProcessHandlingCovered: false,
      candidatePayloadExactlyPreserved: true, independentUninstall: true, qaInstallerCacheRemoved: true,
      productionRegistrationUnchanged: true, metadataChanges: [], finalQaPayloadSha256: candidate.payloadSha256,
      rounds: ['clean-install', 'same-version-replacement'].map((action, index) => ({ round: index + 1,
        action, payloadFileCount: 9947, payloadSha256: candidate.payloadSha256,
        independentRegistration: true, noTransactionLeftovers: true })) },
    recovery: { ...qualification, test: 'official-desktop-real-crash', productionProbationMs: 45000,
      isolatedHome: `C:\\DSHRQ\\${recoveryIdentity}\\home`, completeSnapshot: true, cachedHostHealthy: true,
      cleanup: { passed: true }, rounds: ['retry', 'disable-plugins', 'verified-cache'].map((action, index) =>
        ({ round: index + 1, action, failures: [1, 2, 0][index], newPrimary: true, pairedHome: true })) },
    ui: { ...bound, candidateIdentity: candidate.identity,
      ui: { welcomeChinese: true, apiSetupWithoutKey: true, workspace: true, settings: true },
      normalQuit: { passed: true, noRestart: true, sourcePayloadUnchanged: true, fullSnapshotVerified: true,
        productionWelcomeRounds: 2, productionProbationMs: 45000, forcefulCleanup: false },
      manualFolderPicker: 'not-tested', workspaceMenuQuit: 'not-tested' }
  };
}
function manualFixture(candidate = candidateFixture()) {
  return { schemaVersion: 1, version: candidate.version, candidateIdentity: candidate.identity,
    officialCommit: candidate.officialCommit, candidatePayloadSha256: candidate.payloadSha256,
    candidateInstallerSha256: candidate.installerSha256, reports: referenceFixture(),
    manual: { platform: 'win32-x64', method: 'native-visible-interaction', operatorConfirmed: true,
      rounds: ['2030-01-01T00:00:00.000Z', '2030-01-02T00:00:00.000Z'].map((testedAt, index) =>
        ({ round: index + 1, testedAt, ...Object.fromEntries(manualCheckNames.map(name => [name, 'pass'])),
          noRestartObservedMs: 7000 })) } };
}
function mutate(value, path, replacement) {
  const keys = path.split('.');
  let target = value;
  for (const key of keys.slice(0, -1)) target = target[key];
  if (replacement === undefined) delete target[keys.at(-1)];
  else target[keys.at(-1)] = replacement;
  return value;
}

test('synthetic automatic readiness cannot confer manual or publication approval', () => {
  const result = validateAutomaticReadiness(candidateFixture(), automaticFixture());
  assert.deepEqual(result, { automaticPassed: true, payloadFileCount: 9947 });
  assert.equal(Object.hasOwn(result, 'publicationAuthorized'), false);
  assert.equal(Object.hasOwn(result, 'manualAttestationPassed'), false);
});

test('new physical QA recovery reports keep exact UUID binding without accepting arbitrary roots', () => {
  const report = automaticFixture();
  report.recovery.isolatedHome = 'C:\\DSHNative\\recovery\\' + recoveryIdentity + '\\home';
  assert.equal(validateStableReadiness(manualFixture(), candidateFixture(), report, syntheticNow()).automaticPassed, true);
  report.recovery.isolatedHome += '\\..\\home';
  assert.throws(() => validateStableReadiness(manualFixture(), candidateFixture(), report, syntheticNow()), /report-identity-mismatch/);
});

test('synthetic full readiness is read-only and explicitly grants no publication authority', () => {
  const candidate = candidateFixture();
  const result = validateStableReadiness(manualFixture(candidate), candidate, automaticFixture(candidate), syntheticNow());
  assert.equal(result.readinessPassed, true);
  assert.equal(result.manualAttestationPassed, true);
  assert.equal(result.publicationAuthorized, false);
  assert.equal(result.scope, 'offline-readiness-only-no-release-or-update-writes');
  assert.equal(result.candidateIdentity, candidate.identity);
  assert.equal(result.candidatePayloadSha256, candidate.payloadSha256);
  assert.equal(result.candidateInstallerSha256, candidate.installerSha256);
  assert.equal(result.payloadFileCount, 9947);
});

test('canonical report references are accepted but the shipped template stays unaccepted', async () => {
  assert.deepEqual(validateReportReferences(referenceFixture()), { ...referenceFixture(), installerIdentity, recoveryIdentity });
  assert.ok(Object.isFrozen(manualCheckNames));
  assert.deepEqual([...manualCheckNames], ['nativeFolderPicker', 'nativeFolderCancel',
    'nativeFolderChineseSpacePath', 'workspaceMenuQuit', 'processStopped', 'relaunch']);
  for (const filename of ['stable-readiness.example.json', 'stable-readiness-0.6.0.example.json']) {
    const pending = JSON.parse(await readFile(join(project, 'docs', filename), 'utf8'));
    assert.equal(pending.manual.operatorConfirmed, false);
    assert.equal(pending.manual.rounds.length, 2);
    for (const round of pending.manual.rounds) {
      assert.equal(round.testedAt, null);
      assert.equal(round.noRestartObservedMs, 0);
      assert.ok(manualCheckNames.every(key => round[key] === 'not-tested'));
    }
    // Shape-only fixture from the pending template, not a physical candidate verification.
    const matchingShape = { schemaVersion: 1, kind: 'official-nsis-candidate', version: pending.version,
      identity: pending.candidateIdentity, officialCommit: pending.officialCommit,
      payloadSha256: pending.candidatePayloadSha256, installerSha256: pending.candidateInstallerSha256,
      sourcePayloadUnchanged: true };
    assert.throws(() => validateManualReadiness(pending, matchingShape, syntheticNow()), /manual-acceptance-required/);
  }
});

for (const key of ['installer', 'recovery', 'ui']) {
  const valid = referenceFixture()[key];
  const invalid = [undefined, null, 1, [valid], { toString: () => valid }, '', `../${valid}`, `./${valid}`,
    `${valid}?token=synthetic`, `${valid}#synthetic`, valid.includes('/') ? valid.replaceAll('/', '\\') : `.\\${valid}`, `C:\\${valid}`,
    `/tmp/${valid}`, `https://example.invalid/${valid}`, `${valid}/..`, valid.toUpperCase(), `${valid}\n`];
  for (const [index, value] of invalid.entries()) test(`report ${key} rejects malformed/coerced/escaping path ${index + 1}`, () => {
    assert.throws(() => validateReportReferences(mutate(referenceFixture(), key, value)), /invalid-report/);
  });
}
for (const key of ['installer', 'recovery']) {
  for (const identity of ['not-a-uuid', installerIdentity.replace('-4', '-3'), installerIdentity.replace('-9', '-7'),
    `${installerIdentity}/../${installerIdentity}`]) test(`report ${key} refuses noncanonical identity ${identity}`, () => {
    const references = referenceFixture(); references[key] = `${key}-qualification-${identity}/report.json`;
    assert.throws(() => validateReportReferences(references), /invalid-report-path/);
  });
}
for (const reports of [null, [], { ...referenceFixture(), extra: 'synthetic-secret' }]) test('report reference shape rejects null, array or extra keys', () => {
  assert.throws(() => validateReportReferences(reports), /invalid-report-references/);
});

const candidateCases = [ ['schemaVersion', 2], ['kind', 'development-unpacked'], ['version', '0.5.0-beta'],
  ['version', ['0.5.0']], ['identity', otherIdentity.toUpperCase()], ['identity', [candidateIdentity]],
  ['officialCommit', 'a'.repeat(39)], ['officialCommit', ['a'.repeat(40)]], ['payloadSha256', 'b'.repeat(63)],
  ['payloadSha256', ['b'.repeat(64)]], ['installerSha256', 'C'.repeat(64)],
  ['installerSha256', ['c'.repeat(64)]], ['sourcePayloadUnchanged', false], ['sourcePayloadUnchanged', 'true'] ];
for (const [path, value] of candidateCases) test(`sealed candidate rejects ${path}=${JSON.stringify(value)}`, () => {
  assert.throws(() => validateAutomaticReadiness(mutate(candidateFixture(), path, value), automaticFixture()), /invalid-sealed-candidate/);
});

for (const key of ['installer', 'recovery', 'ui']) {
  for (const value of [undefined, null, [], false]) test(`automatic report ${key} must be present as an object: ${JSON.stringify(value)}`, () => {
    assert.throws(() => validateAutomaticReadiness(candidateFixture(), mutate(automaticFixture(), key, value)));
  });
  for (const [field, value] of [['schemaVersion', 2], ['version', '0.4.0'], ['candidatePayloadSha256', 'd'.repeat(64)],
    ['candidateInstallerSha256', 'e'.repeat(64)]]) test(`automatic ${key} rejects stale ${field}`, () => {
    assert.throws(() => validateAutomaticReadiness(candidateFixture(), mutate(automaticFixture(), `${key}.${field}`, value)),
      /automatic-report-binding-mismatch/);
  });
  for (const field of ['error', 'cleanupError']) test(`automatic ${key} refuses present ${field}, even null`, () => {
    assert.throws(() => validateAutomaticReadiness(candidateFixture(), mutate(automaticFixture(), `${key}.${field}`, null)));
  });
}
for (const key of ['installer', 'recovery']) {
  for (const [field, value] of [['passed', false], ['passed', 'true'], ['sourcePayloadUnchanged', false],
    ['sourcePayloadUnchanged', 'true'], ['modelCalls', 1], ['modelCalls', '0'], ['candidateKind', 'unpacked']]) {
    test(`automatic ${key} rejects nonqualified ${field}=${JSON.stringify(value)}`, () => {
      assert.throws(() => validateAutomaticReadiness(candidateFixture(), mutate(automaticFixture(), `${key}.${field}`, value)),
        /automatic-qualification-not-passed/);
    });
  }
}

const installationCases = [ ['test', 'other'], ['phase', 'pending'], ['payloadLaunched', true],
  ['productionProcessHandlingCovered', true], ['candidatePayloadExactlyPreserved', false],
  ['independentUninstall', false], ['qaInstallerCacheRemoved', false], ['productionRegistrationUnchanged', false],
  ['metadataChanges', ['changed']], ['metadataChanges', null], ['finalQaPayloadSha256', 'd'.repeat(64)],
  ['rounds', []], ['rounds.0.round', 2], ['rounds.1.round', 1], ['rounds.0.action', 'same-version-replacement'],
  ['rounds.1.action', 'clean-install'], ['rounds.0.payloadFileCount', 0], ['rounds.0.payloadFileCount', 0.5],
  ['rounds.0.payloadFileCount', Number.MAX_SAFE_INTEGER + 1], ['rounds.0.payloadFileCount', '9947'],
  ['rounds.1.payloadFileCount', 9948], ['rounds.1.payloadSha256', 'd'.repeat(64)],
  ['rounds.0.independentRegistration', false], ['rounds.1.noTransactionLeftovers', false] ];
for (const [path, value] of installationCases) test(`installation evidence rejects ${path}`, () => {
  assert.throws(() => validateAutomaticReadiness(candidateFixture(), mutate(automaticFixture(), `installer.${path}`, value)),
    /installation-(?:evidence|round)-incomplete/);
});
const recoveryCases = [ ['test', 'mock-crash'], ['productionProbationMs', 3000], ['productionProbationMs', '45000'],
  ['completeSnapshot', false], ['cachedHostHealthy', false], ['cleanup', undefined], ['cleanup.passed', false],
  ['rounds', []], ['rounds.0.round', 2], ['rounds.1.action', 'retry'], ['rounds.2.action', 'cache'],
  ['rounds.0.failures', 0], ['rounds.1.failures', 1], ['rounds.2.failures', 3],
  ['rounds.1.newPrimary', false], ['rounds.2.pairedHome', false] ];
for (const [path, value] of recoveryCases) test(`recovery evidence rejects ${path}`, () => {
  assert.throws(() => validateAutomaticReadiness(candidateFixture(), mutate(automaticFixture(), `recovery.${path}`, value)),
    /recovery-(?:evidence|round)-incomplete/);
});
const uiCases = [ ['candidateIdentity', otherIdentity], ['ui', null], ['ui.welcomeChinese', false],
  ['ui.apiSetupWithoutKey', false], ['ui.workspace', false], ['ui.settings', false], ['normalQuit', null],
  ['normalQuit.passed', false], ['normalQuit.noRestart', false], ['normalQuit.sourcePayloadUnchanged', false],
  ['normalQuit.fullSnapshotVerified', false], ['normalQuit.productionWelcomeRounds', 1],
  ['normalQuit.productionProbationMs', 3000], ['normalQuit.forcefulCleanup', true],
  ['normalQuit.forcefulCleanup', 'false'], ['manualFolderPicker', 'pass'], ['workspaceMenuQuit', 'pass'] ];
for (const [path, value] of uiCases) test(`UI automated evidence rejects ${path}`, () => {
  assert.throws(() => validateAutomaticReadiness(candidateFixture(), mutate(automaticFixture(), `ui.${path}`, value)), /ui-evidence-incomplete/);
});

const manualBindingCases = [ ['schemaVersion', 2], ['version', '0.4.0'], ['candidateIdentity', otherIdentity],
  ['officialCommit', 'd'.repeat(40)], ['candidatePayloadSha256', 'd'.repeat(64)],
  ['candidateInstallerSha256', 'e'.repeat(64)] ];
for (const [path, value] of manualBindingCases) test(`manual acceptance refuses stale ${path}`, () => {
  assert.throws(() => validateManualReadiness(mutate(manualFixture(), path, value), candidateFixture(), syntheticNow()),
    /manual-candidate-binding-mismatch/);
});
for (const [path, value] of [ ['extra', 'synthetic-secret'], ['manual.extra', 'synthetic-secret'],
  ['manual.rounds.0.extra', 'synthetic-secret'], ['manual.rounds.1.extra', 'synthetic-secret'],
  ['manual.rounds.0.nativeFolderPicker', undefined] ]) test(`manual schema refuses missing/extra field ${path}`, () => {
  assert.throws(() => validateManualReadiness(mutate(manualFixture(), path, value), candidateFixture(), syntheticNow()),
    /invalid-manual-(?:record-fields|attestation|round-fields)/);
});
const manualCases = [ ['manual.platform', 'linux-x64'], ['manual.platform', 'win32-arm64'],
  ['manual.method', 'dom-dispatch'], ['manual.method', 'raw-ipc'], ['manual.operatorConfirmed', false],
  ['manual.operatorConfirmed', 'true'], ['manual.rounds', []], ['manual.rounds', [manualFixture().manual.rounds[0]]],
  ['manual.rounds.0.round', 2], ['manual.rounds.1.round', 1], ['manual.rounds.0.round', '1'],
  ['manual.rounds.0.noRestartObservedMs', 6999], ['manual.rounds.1.noRestartObservedMs', 300001],
  ['manual.rounds.0.noRestartObservedMs', 7000.1], ['manual.rounds.1.noRestartObservedMs', '7000'],
  ['manual.rounds.0.testedAt', 'not-a-date'], ['manual.rounds.0.testedAt', 1893456000000],
  ['manual.rounds.0.testedAt', '2030-01-01T00:00:00Z'], ['manual.rounds.0.testedAt', '2030-01-01T08:00:00.000+08:00'],
  ['manual.rounds.1.testedAt', '2030-01-01T00:00:00.000Z'],
  ['manual.rounds.1.testedAt', '2029-12-31T00:00:00.000Z'], ['manual.rounds.1.testedAt', '2030-01-04T00:00:00.000Z'] ];
for (const [path, value] of manualCases) test(`manual acceptance refuses ${path}=${JSON.stringify(value)}`, () => {
  assert.throws(() => validateManualReadiness(mutate(manualFixture(), path, value), candidateFixture(), syntheticNow()),
    /manual-(?:acceptance-required|round-not-passed)/);
});
for (const name of manualCheckNames) for (const value of [false, true, 'true', 'not-tested', 'pending', 'fail']) {
  test(`manual ${name} must explicitly pass, not ${JSON.stringify(value)}`, () => {
    assert.throws(() => validateManualReadiness(mutate(manualFixture(), `manual.rounds.0.${name}`, value),
      candidateFixture(), syntheticNow()), /manual-round-not-passed/);
  });
}
for (const now of [new Date('invalid'), '2030-01-03T00:00:00.000Z', 0, null]) test('manual checks require a valid Date reference time', () => {
  assert.throws(() => validateManualReadiness(manualFixture(), candidateFixture(), now), /invalid-check-time/);
});
test('manual timing boundaries allow exactly seven seconds and at most five minutes', () => {
  const record = manualFixture(); record.manual.rounds[1].noRestartObservedMs = 300000;
  assert.doesNotThrow(() => validateManualReadiness(record, candidateFixture(), syntheticNow()));
});
for (const [path, value] of [['installer.guid', otherIdentity], ['recovery.isolatedHome', `C:\\DSHRQ\\${otherIdentity}\\home`],
  ['recovery.isolatedHome', `C:/DSHRQ/${recoveryIdentity}/home`], ['recovery.isolatedHome', `C:\\DSHRQ\\${recoveryIdentity}\\home\\..`]]) {
  test(`stable readiness binds physical qualification identity at ${path}`, () => {
    assert.throws(() => validateStableReadiness(manualFixture(), candidateFixture(),
      mutate(automaticFixture(), path, value), syntheticNow()), /report-identity-mismatch/);
  });
}

test('CLI is inert without explicit readiness intent', async () => {
  const result = await run(process.execPath, [script], { cwd: project, windowsHide: true, timeout: 15000 });
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /Read-only readiness requires --check or --check-automatic/);
  assert.match(result.stdout, /No application was started/);
});
for (const args of [['--publish'], ['--check', '--force'], ['--check-automatic', '--publish']]) {
  test(`invalid CLI args ${args.join(' ')} cannot authorize a publication`, async () => {
    await assert.rejects(run(process.execPath, [script, ...args], { cwd: project, windowsHide: true, timeout: 15000 }), error => {
      assert.equal(error.code, 1); const result = JSON.parse(error.stderr.trim());
      assert.deepEqual(result, { readinessPassed: false, publicationAuthorized: false, reason: 'usage-check-or-check-automatic' });
      assert.equal(error.stdout, ''); return true;
    });
  });
}
test('main refuses invalid intent before even examining its root argument', async () => {
  for (const mode of [undefined, null, '', '--publish', '--force', ['--check']]) {
    await assert.rejects(main(mode, { toString() { throw new Error('root must remain unexamined'); } }), /usage-check-or-check-automatic/);
  }
});
for (const mode of ['--check', '--check-automatic']) test(`missing required evidence fails closed without creating files for ${mode}`, async () => {
  const missingRoot = join(tmpdir(), `dsh-readiness-test-missing-${randomUUID()}`);
  await assert.rejects(main(mode, missingRoot), error => error.code === 'ENOENT');
  await assert.rejects(readdir(missingRoot), error => error.code === 'ENOENT');
});

test('import and invalid intent do not read evidence, write files, spawn apps or request network', async () => {
  const code = `
    import fs from 'node:fs'; import promises from 'node:fs/promises';
    import child from 'node:child_process'; import http from 'node:http'; import https from 'node:https';
    import net from 'node:net'; import { syncBuiltinESMExports } from 'node:module';
    const calls = []; const forbid = name => (...args) => { calls.push(name); throw new Error(name); };
    for (const name of ['lstat','readFile','writeFile','mkdir','rm','unlink','rename','copyFile','cp']) promises[name] = forbid('fs.'+name);
    for (const name of ['writeFileSync','mkdirSync','rmSync','unlinkSync','renameSync','createWriteStream']) fs[name] = forbid('fs.'+name);
    for (const name of ['exec','execFile','spawn','fork','execSync','execFileSync','spawnSync']) child[name] = forbid('child.'+name);
    for (const module of [http,https]) for (const name of ['request','get']) module[name] = forbid('network.'+name);
    net.connect = forbid('network.connect'); globalThis.fetch = forbid('network.fetch'); syncBuiltinESMExports();
    const imported = await import(${JSON.stringify(new URL('./verify-stable-readiness.mjs', import.meta.url).href)});
    try { await imported.main('--publish'); throw new Error('invalid intent accepted'); }
    catch (error) { if (error.message !== 'usage-check-or-check-automatic') throw error; }
    if (calls.length) throw new Error('unexpected calls: '+calls.join(','));
    const inertCalls = [...calls];
    promises.lstat = () => { calls.push('fs.lstat'); const error = new Error('synthetic missing evidence'); error.code = 'ENOENT'; throw error; };
    syncBuiltinESMExports();
    for (const mode of ['--check','--check-automatic']) {
      try { await imported.main(mode, ${JSON.stringify(join(tmpdir(), 'dsh-readiness-synthetic-missing-root'))}); throw new Error('missing evidence accepted'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (calls.length !== 2 || calls.some(value => value !== 'fs.lstat')) throw new Error('missing evidence caused mutations');
    console.log(JSON.stringify({ inertCalls, missingEvidenceCalls: calls }));
  `;
  const result = await run(process.execPath, ['--input-type=module', '-e', code], { cwd: project, windowsHide: true, timeout: 15000 });
  assert.deepEqual(JSON.parse(result.stdout.trim()), { inertCalls: [], missingEvidenceCalls: ['fs.lstat', 'fs.lstat'] });
  assert.equal(result.stderr, '');
});

test('every release workflow is contents-read only and cannot publish releases or latest feeds', async () => {
  const workflowRoot = join(project, '.github', 'workflows');
  const files = (await readdir(workflowRoot)).filter(name => /\.ya?ml$/.test(name));
  assert.ok(files.length > 0);
  for (const file of files) {
    const text = await readFile(join(workflowRoot, file), 'utf8');
    const workflow = yaml.load(text, { schema: yaml.JSON_SCHEMA });
    assert.ok(workflow && typeof workflow === 'object');
    if (workflow.permissions !== undefined) assert.deepEqual(workflow.permissions, { contents: 'read' });
    assert.ok(workflow.jobs && Object.keys(workflow.jobs).length > 0);
    for (const job of Object.values(workflow.jobs)) {
      assert.deepEqual(job.permissions ?? workflow.permissions, { contents: 'read' });
      assert.equal(job.secrets, undefined);
      for (const step of job.steps ?? []) {
        assert.doesNotMatch(step.uses ?? '', /(?:softprops\/action-gh-release|ncipollo\/release-action|action.*release|release.*action)/i);
        assert.doesNotMatch(step.run ?? '', /(?:gh\s+release|publish-candidate|api\.github\.com\/.*releases|uploads\.github\.com|--publish|make_latest|latest\.ya?ml)/i);
        if (step.uses?.startsWith('actions/upload-artifact@')) {
          assert.ok(step.if === undefined || step.if === 'success()', 'artifact uploads must not run on failures');
          assert.equal(step.with?.name, 'official-desktop-candidate-not-stable');
          assert.equal(step.with?.['if-no-files-found'], 'error');
          assert.deepEqual(step.with.path.trim().split(/\r?\n/).map(value => value.trim()), [
            'release/DeepSeek-Harness-Desktop-*.exe', 'release/DeepSeek-Harness-Desktop-*.exe.blockmap']);
          assert.doesNotMatch(step.with.path, /(?:\.official-build|report|latest|\.dsh|\*\*|\?)/i);
        }
      }
    }
  }
});
