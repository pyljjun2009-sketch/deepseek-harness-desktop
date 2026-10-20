/** Explicit upstream check/download consumer. Never invokes an installer or changes the active baseline. */
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import upgrade from '../desktop/official-upgrade.cjs';
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export async function main(mode) {
  if (!['--check', '--download-pinned', '--plan'].includes(mode)) throw new upgrade.OfficialUpgradeError('INVALID_UPGRADE_OPERATION');
  const lock = JSON.parse(await readFile(join(project, 'official.lock.json'), 'utf8'));
  const provider = upgrade.createOfficialUpgradeProvider();
  if (mode === '--check') return provider.check({ baselineVersion: lock.version });
  const plan = provider.prepare(lock.upstreamPackage, lock.version);
  if (mode === '--plan') return plan;
  return provider.download(lock.upstreamPackage, join(project, '.official-build', 'official-packages'));
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length === 2) console.log('Use --check, --plan or --download-pinned. No installer was run.');
  else {
    try {
      if (process.argv.length !== 3) throw new upgrade.OfficialUpgradeError('INVALID_UPGRADE_OPERATION');
      console.log(JSON.stringify(await main(process.argv[2]), null, 2));
    } catch (error) {
      console.error(JSON.stringify({ operationFailed: true, installed: false,
        reason: error instanceof upgrade.OfficialUpgradeError ? error.code : 'UPGRADE_OPERATION_FAILED' }));
      process.exitCode = 1;
    }
  }
}
