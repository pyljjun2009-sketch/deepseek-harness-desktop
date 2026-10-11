/** Read-only release readiness, not a publisher or proof of human interaction.
 * An attestation is a maintainer statement. This tool never manufactures one,
 * launches the desktop, reads credentials, or grants publication authority.
 */
import { lstat, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { selectQualificationPayload } from './qualify-official-installer.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
const sha256 = /^[a-f0-9]{64}$/;
const commit = /^[a-f0-9]{40}$/;
export const manualCheckNames = Object.freeze(['nativeFolderPicker', 'nativeFolderCancel',
  'nativeFolderChineseSpacePath', 'workspaceMenuQuit', 'processStopped', 'relaunch']);

class ReadinessError extends Error {
  constructor(code) { super(code); this.code = code; }
}
function requireTrue(condition, code) { if (!condition) throw new ReadinessError(code); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exactKeys(value, keys, code) {
  requireTrue(object(value) && Object.keys(value).length === keys.length &&
    Object.keys(value).every(key => keys.includes(key)), code);
}
function reportBinding(report, candidate) {
  requireTrue(object(report) && report.schemaVersion === 1 && report.version === candidate.version &&
    report.candidatePayloadSha256 === candidate.payloadSha256 &&
    report.candidateInstallerSha256 === candidate.installerSha256, 'automatic-report-binding-mismatch');
}

export function validateReportReferences(reports) {
  exactKeys(reports, ['installer', 'recovery', 'ui'], 'invalid-report-references');
  requireTrue(Object.values(reports).every(value => typeof value === 'string'), 'invalid-report-path');
  const installation = new RegExp(`^installer-qualification-(${uuid})/report\\.json$`).exec(reports.installer);
  const recovery = new RegExp(`^recovery-qualification-(${uuid})/report\\.json$`).exec(reports.recovery);
  requireTrue(installation && recovery && reports.ui === 'public-ui-summary.json', 'invalid-report-path');
  return { installer: reports.installer, recovery: reports.recovery, ui: reports.ui,
    installerIdentity: installation[1], recoveryIdentity: recovery[1] };
}

function validateCandidate(candidate) {
  requireTrue(object(candidate) && candidate.schemaVersion === 1 && candidate.kind === 'official-nsis-candidate' &&
    ['version', 'identity', 'officialCommit', 'payloadSha256', 'installerSha256']
      .every(key => typeof candidate[key] === 'string') &&
    /^\d+\.\d+\.\d+$/.test(candidate.version) && new RegExp(`^${uuid}$`).test(candidate.identity) &&
    commit.test(candidate.officialCommit) && sha256.test(candidate.payloadSha256) &&
    sha256.test(candidate.installerSha256) && candidate.sourcePayloadUnchanged === true, 'invalid-sealed-candidate');
}

export function validateAutomaticReadiness(candidate, automatic) {
  validateCandidate(candidate);
  exactKeys(automatic, ['installer', 'recovery', 'ui'], 'missing-automatic-reports');
  for (const report of Object.values(automatic)) {
    reportBinding(report, candidate);
    requireTrue(!Object.hasOwn(report, 'error') && !Object.hasOwn(report, 'cleanupError'),
      'automatic-qualification-not-passed');
  }
  const { installer, recovery, ui } = automatic;
  for (const report of [installer, recovery]) requireTrue(report.passed === true &&
    report.sourcePayloadUnchanged === true && report.modelCalls === 0 &&
    report.candidateKind === candidate.kind, 'automatic-qualification-not-passed');
  requireTrue(installer.test === 'official-desktop-isolated-full-installer' && installer.phase === 'complete' &&
    installer.payloadLaunched === false && installer.productionProcessHandlingCovered === false &&
    installer.candidatePayloadExactlyPreserved === true && installer.independentUninstall === true &&
    installer.qaInstallerCacheRemoved === true && installer.productionRegistrationUnchanged === true &&
    Array.isArray(installer.metadataChanges) && installer.metadataChanges.length === 0 &&
    installer.finalQaPayloadSha256 === candidate.payloadSha256 &&
    Array.isArray(installer.rounds) && installer.rounds.length === 2, 'installation-evidence-incomplete');
  let fileCount;
  for (const [index, round] of installer.rounds.entries()) {
    requireTrue(object(round) && round.round === index + 1 &&
      round.action === ['clean-install', 'same-version-replacement'][index] &&
      Number.isSafeInteger(round.payloadFileCount) && round.payloadFileCount > 0 &&
      (index === 0 || round.payloadFileCount === fileCount) && round.payloadSha256 === candidate.payloadSha256 &&
      round.independentRegistration === true && round.noTransactionLeftovers === true, 'installation-round-incomplete');
    fileCount = round.payloadFileCount;
  }
  requireTrue(recovery.test === 'official-desktop-real-crash' && recovery.productionProbationMs === 45000 &&
    recovery.completeSnapshot === true && recovery.cachedHostHealthy === true && recovery.cleanup?.passed === true &&
    Array.isArray(recovery.rounds) && recovery.rounds.length === 3, 'recovery-evidence-incomplete');
  for (const [index, round] of recovery.rounds.entries()) requireTrue(object(round) &&
    round.round === index + 1 && round.action === ['retry', 'disable-plugins', 'verified-cache'][index] &&
    round.failures === [1, 2, 0][index] && round.newPrimary === true && round.pairedHome === true,
  'recovery-round-incomplete');
  requireTrue(ui.candidateIdentity === candidate.identity && object(ui.ui) &&
    ['welcomeChinese', 'apiSetupWithoutKey', 'workspace', 'settings'].every(key => ui.ui[key] === true) &&
    object(ui.normalQuit) && ['passed', 'noRestart', 'sourcePayloadUnchanged', 'fullSnapshotVerified']
      .every(key => ui.normalQuit[key] === true) && ui.normalQuit.productionWelcomeRounds === 2 &&
    ui.normalQuit.productionProbationMs === 45000 && ui.normalQuit.forcefulCleanup === false &&
    ui.manualFolderPicker === 'not-tested' && ui.workspaceMenuQuit === 'not-tested', 'ui-evidence-incomplete');
  return { automaticPassed: true, payloadFileCount: fileCount };
}

export function validateManualReadiness(record, candidate, now = new Date()) {
  validateCandidate(candidate);
  exactKeys(record, ['schemaVersion', 'version', 'candidateIdentity', 'officialCommit',
    'candidatePayloadSha256', 'candidateInstallerSha256', 'reports', 'manual'], 'invalid-manual-record-fields');
  requireTrue(record.schemaVersion === 1 && record.version === candidate.version &&
    record.candidateIdentity === candidate.identity && record.officialCommit === candidate.officialCommit &&
    record.candidatePayloadSha256 === candidate.payloadSha256 &&
    record.candidateInstallerSha256 === candidate.installerSha256, 'manual-candidate-binding-mismatch');
  const references = validateReportReferences(record.reports);
  exactKeys(record.manual, ['platform', 'method', 'operatorConfirmed', 'rounds'], 'invalid-manual-attestation');
  requireTrue(record.manual.platform === 'win32-x64' && record.manual.method === 'native-visible-interaction' &&
    record.manual.operatorConfirmed === true && Array.isArray(record.manual.rounds) &&
    record.manual.rounds.length === 2, 'manual-acceptance-required');
  requireTrue(now instanceof Date && Number.isFinite(now.getTime()), 'invalid-check-time');
  let previous = -Infinity;
  for (const [index, round] of record.manual.rounds.entries()) {
    exactKeys(round, ['round', 'testedAt', ...manualCheckNames, 'noRestartObservedMs'], 'invalid-manual-round-fields');
    const instant = typeof round.testedAt === 'string' ? Date.parse(round.testedAt) : NaN;
    requireTrue(round.round === index + 1 && Number.isFinite(instant) &&
      new Date(instant).toISOString() === round.testedAt && instant > previous && instant <= now.getTime() &&
      manualCheckNames.every(key => round[key] === 'pass') &&
      Number.isSafeInteger(round.noRestartObservedMs) && round.noRestartObservedMs >= 7000 &&
      round.noRestartObservedMs <= 300000, 'manual-round-not-passed');
    previous = instant;
  }
  return references;
}

export function validateStableReadiness(record, candidate, automatic, now) {
  const references = validateManualReadiness(record, candidate, now);
  const result = validateAutomaticReadiness(candidate, automatic);
  requireTrue(automatic.installer.guid === references.installerIdentity &&
    automatic.recovery.isolatedHome === `C:\\DSHRQ\\${references.recoveryIdentity}\\home`, 'report-identity-mismatch');
  return { schemaVersion: 1, version: candidate.version, candidateIdentity: candidate.identity,
    candidatePayloadSha256: candidate.payloadSha256, candidateInstallerSha256: candidate.installerSha256,
    ...result, manualAttestationPassed: true, readinessPassed: true, publicationAuthorized: false,
    scope: 'offline-readiness-only-no-release-or-update-writes' };
}

async function physicalJson(path) {
  for (let current = resolve(path); ; current = dirname(current)) {
    const stat = await lstat(current);
    requireTrue(!stat.isSymbolicLink(), 'linked-evidence-path-refused');
    if (dirname(current) === current) break;
  }
  const stat = await lstat(path);
  requireTrue(stat.isFile() && stat.size > 0 && stat.size <= 1024 * 1024, 'invalid-evidence-file');
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { throw new ReadinessError('invalid-evidence-json'); }
}

async function reportsAt(root, references) {
  const directory = join(root, '.official-build');
  return Object.fromEntries(await Promise.all(['installer', 'recovery', 'ui'].map(async key =>
    [key, await physicalJson(join(directory, references[key]))])));
}

export async function main(mode, root = project) {
  requireTrue(['--check', '--check-automatic'].includes(mode), 'usage-check-or-check-automatic');
  const evidence = join(root, '.official-build');
  let record;
  let references;
  if (mode === '--check') {
    record = await physicalJson(join(evidence, 'stable-readiness.json'));
    // Reject pending/manual fields before an expensive payload inventory.
    validateManualReadiness(record, await physicalJson(join(evidence, 'candidate.json')));
    references = validateReportReferences(record.reports);
  } else {
    const plan = await physicalJson(join(evidence, 'publication-plan.json'));
    requireTrue(plan.schemaVersion === 1 && plan.repository === 'pyljjun2009-sketch/deepseek-harness-desktop',
      'invalid-local-publication-plan');
    references = validateReportReferences({ installer: plan.installerReport, recovery: plan.recoveryReport,
      ui: 'public-ui-summary.json' });
    record = plan;
  }
  const selected = await selectQualificationPayload(root);
  requireTrue(selected.kind === 'official-nsis-candidate', 'sealed-candidate-required');
  const candidate = selected.candidate;
  requireTrue(record.version === candidate.version && record.candidateIdentity === candidate.identity &&
    record.candidatePayloadSha256 === candidate.payloadSha256 &&
    record.candidateInstallerSha256 === candidate.installerSha256, 'local-plan-candidate-binding-mismatch');
  const automatic = await reportsAt(root, references);
  const result = validateAutomaticReadiness(candidate, automatic);
  requireTrue(automatic.installer.guid === references.installerIdentity &&
    automatic.recovery.isolatedHome === `C:\\DSHRQ\\${references.recoveryIdentity}\\home` &&
    result.payloadFileCount === selected.inventory.files.length, 'report-identity-or-inventory-mismatch');
  if (mode === '--check') return validateStableReadiness(record, candidate, automatic);
  return { schemaVersion: 1, version: candidate.version, ...result, manualAcceptance: 'pending',
    readinessPassed: false, publicationAuthorized: false,
    scope: 'offline-automatic-readiness-only-no-release-or-update-writes' };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length === 2) console.log('Read-only readiness requires --check or --check-automatic. No application was started.');
  else {
    try {
      requireTrue(process.argv.length === 3, 'usage-check-or-check-automatic');
      console.log(JSON.stringify(await main(process.argv[2]), null, 2));
    } catch (error) {
      const reason = error instanceof ReadinessError ? error.code : error?.code === 'ENOENT' ?
        'required-local-evidence-missing' : 'readiness-verification-failed';
      console.error(JSON.stringify({ readinessPassed: false, publicationAuthorized: false, reason }));
      process.exitCode = 1;
    }
  }
}
