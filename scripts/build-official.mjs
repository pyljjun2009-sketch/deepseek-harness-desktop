import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join, dirname, delimiter } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stageOfficialShell, inventoryShellFiles } from './stage-official-shell.mjs';
import officialUpgrade from '../desktop/official-upgrade.cjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(await readFile(join(root, 'official.lock.json'), 'utf8'));
const distributionVersion = lock.distributionVersion;
if (!/^\d+\.\d+\.\d+$/.test(distributionVersion)) throw new Error('Distribution version must be an explicit stable semver');
const requestedSource = resolve(process.env.DSH_OFFICIAL_SOURCE || `C:/DSHBuild/harness-${lock.version.replaceAll('.', '').replaceAll('-', '')}`);
const source = existsSync(requestedSource) ? await realpath(requestedSource) : requestedSource;
if (lock.upstreamPackage !== undefined) {
  const artifact = officialUpgrade.validateOfficialArtifact(lock.upstreamPackage);
  if (artifact.version !== lock.version) throw new Error('Official desktop package and source versions differ');
  if (process.argv.includes('--refresh-runtime-lock')) {
    const cacheKey = Buffer.from(artifact.sha512, 'base64').toString('hex');
    await officialUpgrade.verifyOfficialPackage(join(root, '.official-build', 'official-packages', `${cacheKey}.exe`), artifact);
  }
}
const staging = join(source, `.community-app-${distributionVersion}-${randomUUID().slice(0, 8)}`);
const paths = join(source, 'apps/desktop/.desktop-build/targets/win-x64');
const env = { ...process.env, DSH_DESKTOP_TARGET_PLATFORM: 'win32', DSH_DESKTOP_TARGET_ARCH: 'x64',
  DSH_CLIENT_COMMIT_HASH: lock.commit, DSH_CLIENT_TITLE: 'DeepSeek Harness Desktop · 社区恢复版',
  DSH_CLIENT_BUILD_PROFILE: 'community', DSH_COMMUNITY_PACK: '1',
  PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`,
  ELECTRON_BUILDER_7Z_FILTER: 'BCJ', CSC_IDENTITY_AUTO_DISCOVERY: 'false' };

async function run(command, args, cwd = source, environment = env) {
  console.log(`\nBuild stage: ${args.join(' ')}`);
  await new Promise((accept, reject) => {
    const child = spawn(command, args, { cwd, env: environment, windowsHide: true, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? accept() : reject(new Error(`Build stage exited ${code}`)));
  });
}

if (process.platform !== 'win32') throw new Error('This pipeline currently qualifies Windows x64 only');
if (!existsSync(join(source, 'package.json'))) {
  await mkdir(dirname(source), { recursive: true });
  await run('git', ['clone', '--depth', '1', '--branch', lock.tag, lock.repository, source], root);
}
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
if (commit !== lock.commit) throw new Error('Official source differs from the locked commit');
const patch = join(root, 'desktop/official-overlay.patch');
// Windows checkouts may have CRLF context; content and artifact hash gates remain mandatory.
try { execFileSync('git', ['apply', '--ignore-space-change', '--reverse', '--check', patch], { cwd: source, stdio: 'pipe' }); }
catch { await run('git', ['apply', '--ignore-space-change', '--check', patch]); await run('git', ['apply', '--ignore-space-change', patch]); }
await cp(join(root, 'desktop/community-adapter.ts'), join(source, 'apps/desktop/src/community-adapter.ts'));
const npm = join(root, 'node_modules/npm/bin/npm-cli.js');
const pnpmArgs = ['exec', '--yes', `--package=pnpm@${lock.pnpm}`, '--', 'pnpm'];
const pnpm = (args, cwd = source) => run(process.execPath, [npm, ...pnpmArgs, ...args], cwd);
if (env.DSH_SHEETJS_CACHE) env.DSH_COMMUNITY_PNPMFILE = join(root, 'desktop/verified-cache.cjs');
const retainedRuntimeLock = join(root, 'official-runtime.lock.yaml');
if (existsSync(retainedRuntimeLock) && !process.argv.includes('--refresh-runtime-lock')) env.DSH_COMMUNITY_RUNTIME_LOCK = retainedRuntimeLock;

if (!process.argv.includes('--stage-only')) {
  await pnpm(['install', '--frozen-lockfile', ...(env.DSH_SHEETJS_CACHE ? ['--pnpmfile', join(root, 'desktop/verified-cache.cjs')] : [])]);
  if (process.argv.includes('--skip-compile')) {
    const { readClientBuildRecord } = await import(pathToFileURL(join(source, 'scripts/client-build-environment.ts')));
    const record = readClientBuildRecord(source);
    if (record.environment.DSH_CLIENT_COMMIT_HASH !== lock.commit.slice(0, 7) ||
        record.environment.DSH_CLIENT_BUILD_PROFILE !== 'community') throw new Error('Compiled client baseline differs');
    await pnpm(['--dir', 'apps/desktop', 'run', 'build']);
  } else await pnpm(['run', 'build']);
  await pnpm(['exec', 'vitest', 'run', 'apps/desktop/tests/fatal-recovery.spec.ts',
    'apps/desktop/tests/backend-controller.spec.ts', 'apps/desktop/tests/directory-picker.spec.ts',
    'apps/desktop/tests/single-instance.spec.ts', 'apps/desktop/tests/project-manager.spec.ts',
    'apps/desktop/tests/update-coordinator.spec.ts', 'apps/desktop/tests/update-channel.spec.ts',
    'apps/desktop/tests/update-schedule.spec.ts', 'scripts/release/families.spec.ts']);
  await pnpm(['run', 'release:pack', '--family', 'dsh', '--out', join(paths, 'packed/dsh'), '--concurrency', '4']);
  await pnpm(['--dir', 'apps/desktop-host', 'pack', '--pack-destination', join(paths, 'packed/dsh')]);
  await pnpm(['run', 'release:pack', '--family', 'vendor', '--out', join(paths, 'packed/vendor'), '--concurrency', '4']);
  await mkdir(join(paths, 'packed/landlock'), { recursive: true });
  await pnpm(['--dir', 'native/system', 'run', 'build:ts']);
  await pnpm(['--dir', 'native/system/packages/entry', 'pack', '--pack-destination', join(paths, 'packed/landlock')]);
  for (const step of ['prepare:runtime', 'prepare:packages', 'prepare:dsh']) await pnpm(['--dir', 'apps/desktop', 'run', step]);
}
// Always verify retained prepared bytes, including on the explicitly requested stage-only path.
const { verifyDesktopRuntime } = await import(pathToFileURL(join(source, 'apps/desktop/lib/types/runtime-tree.js')));
await verifyDesktopRuntime(join(paths, 'dsh'), lock.version, { platform: 'win32', arch: 'x64' });
if (!existsSync(join(paths, 'dsh/pnpm-lock.yaml'))) throw new Error('Prepared runtime has no retained production lock');
// Desktop shell uses the workspace lock; the runtime has its separately retained production lock.
await stageOfficialShell(source, staging);
for (const directory of ['lib', 'renderer']) await cp(join(source, 'apps/desktop', directory), join(staging, directory), { recursive: true });
await cp(join(root, 'desktop'), join(staging, 'desktop'), { recursive: true });
const upstream = JSON.parse(await readFile(join(staging, 'package.json'), 'utf8'));
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
await writeFile(join(staging, 'package.json'), JSON.stringify({
  ...upstream, name: manifest.name, version: distributionVersion, productName: 'DeepSeek Harness Desktop',
  description: 'Community recovery edition based on official DeepSeek Harness Desktop',
  author: manifest.author, main: 'desktop/launcher.cjs', dshOfficialVersion: lock.version,
  dshOfficialCommit: lock.commit, dshDesktopUpdateChannel: 'latest', dshUpgradeInterfaceVersion: 1
}, null, 2));
await cp(join(root, 'official.lock.json'), join(staging, 'official.lock.json'));
await cp(join(source, 'LICENSE'), join(staging, 'LICENSE.official'));
const receiptPath = join(staging, 'shell-dependency-receipt.json');
const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
receipt.files = (await inventoryShellFiles(staging)).filter(file => file.path !== 'shell-dependency-receipt.json');
await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
if (process.argv.includes('--refresh-runtime-lock')) {
  await cp(join(paths, 'dsh/pnpm-lock.yaml'), retainedRuntimeLock);
}
const record = { source, staging, paths, officialVersion: lock.version, officialCommit: lock.commit,
  overlaySha256: createHash('sha256').update(await readFile(patch)).digest('hex'), version: distributionVersion,
  shellReceiptSha256: createHash('sha256').update(await readFile(receiptPath)).digest('hex'),
  runtimeLockSha256: createHash('sha256').update(await readFile(join(paths, 'dsh/pnpm-lock.yaml'))).digest('hex') };
await mkdir(join(root, '.official-build'), { recursive: true });
await writeFile(join(root, '.official-build/paths.json'), JSON.stringify(record, null, 2));
console.log(`Official desktop prepared at ${staging}`);
if (process.argv.includes('--package')) {
  process.env.ELECTRON_BUILDER_7Z_FILTER = 'BCJ';
  const builder = await import(pathToFileURL(join(root, 'node_modules/electron-builder/out/index.js')).href);
  const { default: config } = await import('./official-builder.config.mjs');
  await builder.build({ targets: builder.Platform.WINDOWS.createTarget([process.argv.includes('--unpacked') ? 'dir' : 'nsis'], builder.Arch.x64), config, publish: 'never' });
}
