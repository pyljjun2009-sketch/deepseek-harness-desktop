import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { cleanupShellManifest, inventoryShellFiles, publishShellStage, SHELL_METADATA_BUILDER_VERSION, stageOfficialShell } from './stage-official-shell.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = join(root, '.official-build');
async function privateDirectory() { await mkdir(scratch, { recursive: true }); return mkdtemp(join(scratch, 'shell-test-')); }
async function cleanup(directory) {
  const suffix = relative(scratch, resolve(directory));
  assert(suffix !== '' && suffix !== '..' && !suffix.startsWith(`..${sep}`));
  assert.equal(dirname(resolve(directory)), resolve(scratch));
  await rm(directory, { recursive: true, force: true });
}
async function writeManifest(directory, manifest) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(directory, 'entry.js'), 'module.exports = "fixture";\n');
}
async function fixture(directory, descriptors, dependencies = { a: '^1', b: '^1', shared: '^1' }, extraRoot = {}) {
  const checkout = join(directory, 'checkout');
  const desktop = join(checkout, 'apps/desktop');
  await writeManifest(desktop, { name: 'desktop-fixture', version: '1.0.0', main: 'entry.js', dependencies,
    devDependencies: { 'dev-only': '^1' }, ...extraRoot });
  const identities = [];
  for (const [path, manifest] of descriptors) {
    await writeManifest(join(desktop, 'node_modules', path), { main: 'entry.js', ...manifest });
    identities.push(`  '${manifest.name}@${manifest.version}': {}`);
  }
  const lock = `lockfileVersion: '9.0'\nimporters:\n  apps/desktop: {}\npackages:\n${[...new Set(identities)].join('\n')}\n`;
  await writeFile(join(checkout, 'pnpm-lock.yaml'), lock);
  return { checkout, desktop, staging: join(directory, 'staging'), lock };
}
async function receiptMatches(staging, receipt) {
  const actual = (await inventoryShellFiles(staging)).filter(file => file.path !== 'shell-dependency-receipt.json');
  assert.deepEqual(actual, receipt.files);
}

test('verified candidate publication retries only bounded Windows transient errors and never replaces a new target', async () => {
  const transient = Object.assign(new Error('fixture sharing violation'), { code: 'EPERM' });
  let attempts = 0;
  const pauses = [];
  const operations = { platform: 'win32', pathExists: async () => false, pause: async ms => pauses.push(ms) };
  await publishShellStage('private-candidate', 'fresh-staging', { ...operations,
    renameDirectory: async () => { attempts++; if (attempts < 3) throw transient; },
  });
  assert.equal(attempts, 3);
  assert.deepEqual(pauses, [50, 100]);

  attempts = 0; pauses.length = 0;
  await assert.rejects(publishShellStage('private-candidate', 'fresh-staging', { ...operations,
    renameDirectory: async () => { attempts++; throw transient; },
  }), error => error === transient);
  assert.equal(attempts, 9);
  assert.equal(pauses.reduce((sum, ms) => sum + ms, 0), 1800);

  for (const options of [{ platform: 'linux' }, { renameDirectory: async () => {
    attempts++; throw Object.assign(new Error('fixture missing source'), { code: 'ENOENT' });
  } }]) {
    attempts = 0; pauses.length = 0;
    await assert.rejects(publishShellStage('private-candidate', 'fresh-staging', { ...operations,
      renameDirectory: async () => { attempts++; throw transient; }, ...options,
    }));
    assert.equal(attempts, 1);
    assert.deepEqual(pauses, []);
  }

  attempts = 0; pauses.length = 0;
  await assert.rejects(publishShellStage('private-candidate', 'fresh-staging', { ...operations,
    pathExists: async () => attempts > 0,
    renameDirectory: async () => { attempts++; throw transient; },
  }), /destination appeared during publication/);
  assert.equal(attempts, 1);
  assert.deepEqual(pauses, []);
  await assert.rejects(publishShellStage('private-candidate', 'fresh-staging', { ...operations,
    pathExists: async () => true, renameDirectory: async () => { assert.fail('existing target must not be renamed over'); },
  }), /destination appeared before publication/);
});

test('canonical metadata matches the real pinned builder without changing production behavior fields', async () => {
  const directory = await privateDirectory();
  try {
    const require = createRequire(import.meta.url);
    assert.equal(require('app-builder-lib/package.json').version, SHELL_METADATA_BUILDER_VERSION);
    const { createTransformer } = require('app-builder-lib/out/fileTransformer.js');
    const behavior = {
      name: 'metadata-fixture', version: '1.0.0', type: 'module', main: 'lib/index.js',
      exports: { '.': './lib/index.js', './feature': './lib/feature.js' }, imports: { '#local': './lib/local.js' },
      browser: './lib/browser.js', bin: { command: './bin.js' }, sideEffects: false,
      dependencies: { runtime: '1.0.0' }, optionalDependencies: { native: '2.0.0' },
      peerDependencies: { peer: '3.0.0' }, peerDependenciesMeta: { peer: { optional: true } },
      engines: { node: '>=24' }, os: ['win32'], cpu: ['x64'], files: ['lib', 'bin.js'],
      dsh: { client: { platform: 'web' } }, license: 'MIT', author: 'Fixture',
    };
    const discarded = { scripts: { postinstall: 'must never execute' }, keywords: ['development'], bugs: 'https://example.invalid',
      contributors: ['Fixture'], xo: {}, eslintConfig: {}, dist: {}, gitHead: 'fixture', build: {}, jspm: {},
      ava: {}, nyc: {}, bundleDependencies: [], tags: [], _integrity: 'fixture', babel: {} };
    for (const isMain of [false, true]) {
      const original = { ...behavior, ...discarded, devDependencies: { dev: '^1' } };
      const canonical = cleanupShellManifest(original, isMain);
      for (const [field, value] of Object.entries(behavior)) assert.deepEqual(canonical[field], value);
      assert(original.scripts, 'source metadata must not be mutated');
      const application = join(directory, isMain ? 'main-fixture' : 'dependency-fixture');
      const manifestPath = isMain ? join(application, 'package.json') : join(application, 'node_modules/metadata-fixture/package.json');
      await mkdir(dirname(manifestPath), { recursive: true });
      await writeFile(manifestPath, JSON.stringify(original, null, 2));
      const transform = createTransformer(application, {}, undefined, undefined);
      const actual = await transform(manifestPath);
      assert(actual !== null, 'fixture should require builder metadata cleanup');
      assert.deepEqual(JSON.parse(actual), canonical);
      const sealed = `${JSON.stringify(canonical, null, 2)}\n`;
      await writeFile(manifestPath, sealed);
      assert.equal(await transform(manifestPath), null, 'builder must not transform the already sealed package');
      assert.equal(await readFile(manifestPath, 'utf8'), sealed);
    }
  } finally { await cleanup(directory); }
});

test('offline graph preserves root hoisting, nested versions, ordinary cycles and exact production specs', async () => {
  const directory = await privateDirectory();
  try {
    const input = await fixture(directory, [
      ['a', { name: 'a', version: '1.0.0', dependencies: { b: '^1', shared: '^1' } }],
      ['b', { name: 'b', version: '1.0.0', dependencies: { a: '^1', shared: '^2' } }],
      ['shared', { name: 'shared', version: '1.0.0' }],
      ['b/node_modules/shared', { name: 'shared', version: '2.0.0' }],
      ['dev-only', { name: 'dev-only', version: '1.0.0' }],
    ]);
    const receipt = await stageOfficialShell(input.checkout, input.staging);
    assert.equal(receipt.packages.length, 4);
    assert.equal(receipt.sourceLockSha256, createHash('sha256').update(input.lock).digest('hex'));
    const manifest = JSON.parse(await readFile(join(input.staging, 'package.json'), 'utf8'));
    assert.deepEqual(manifest.dependencies, { a: '1.0.0', b: '1.0.0', shared: '1.0.0' });
    assert.equal(manifest.devDependencies, undefined);
    const resolveA = createRequire(join(input.staging, 'node_modules/a/package.json'));
    const resolveB = createRequire(join(input.staging, 'node_modules/b/package.json'));
    assert.equal(JSON.parse(await readFile(resolveA.resolve('shared/package.json'), 'utf8')).version, '1.0.0');
    assert.equal(JSON.parse(await readFile(resolveB.resolve('shared/package.json'), 'utf8')).version, '2.0.0');
    assert.equal(JSON.parse(await readFile(resolveB.resolve('a/package.json'), 'utf8')).version, '1.0.0');
    assert.equal(JSON.parse(await readFile(join(input.staging, 'node_modules/b/package.json'), 'utf8')).dependencies.shared, '2.0.0');
    await assert.rejects(readFile(join(input.staging, 'node_modules/dev-only/package.json')), { code: 'ENOENT' });
    await receiptMatches(input.staging, receipt);
  } finally { await cleanup(directory); }
});

test('scoped dependencies, available optional dependencies and mandatory peers are materialized', async () => {
  const directory = await privateDirectory();
  try {
    const input = await fixture(directory, [
      ['@scope/core', { name: '@scope/core', version: '1.0.0', peerDependencies: { peer: '^2', optionalPeer: '^1' },
        peerDependenciesMeta: { optionalPeer: { optional: true } }, optionalDependencies: { present: '^1', absent: '^1' } }],
      ['peer', { name: 'peer', version: '2.0.0' }], ['present', { name: 'present', version: '1.0.0' }],
    ], { '@scope/core': 'workspace:*' });
    const receipt = await stageOfficialShell(input.checkout, input.staging);
    assert.equal(receipt.packages.length, 3);
    assert.deepEqual(receipt.packages.find(pkg => pkg.name === '@scope/core').omittedOptional, ['absent']);
    const core = JSON.parse(await readFile(join(input.staging, 'node_modules/@scope/core/package.json'), 'utf8'));
    assert.deepEqual(core.peerDependencies, { peer: '2.0.0' });
    assert.deepEqual(core.optionalDependencies, { present: '1.0.0' });
    await receiptMatches(input.staging, receipt);
  } finally { await cleanup(directory); }
});

test('missing frozen dependencies never fall back to this project or a global installation', async () => {
  const directory = await privateDirectory();
  try {
    const input = await fixture(directory, [], { semver: '^7' });
    await assert.rejects(stageOfficialShell(input.checkout, input.staging), /missing installed dependency semver in the locked checkout/);
    await assert.rejects(lstat(input.staging), { code: 'ENOENT' });
  } finally { await cleanup(directory); }
});

test('installed versions absent from the frozen source lock are rejected', async () => {
  const directory = await privateDirectory();
  try {
    const input = await fixture(directory, [['a', { name: 'a', version: '1.0.0' }]], { a: '^1' });
    await writeFile(join(input.checkout, 'pnpm-lock.yaml'), 'lockfileVersion: 9\npackages:\n');
    await assert.rejects(stageOfficialShell(input.checkout, input.staging), /absent from the source lock/);
  } finally { await cleanup(directory); }
});

test('nonempty staging is preserved rather than overwritten', async () => {
  const directory = await privateDirectory();
  try {
    const input = await fixture(directory, [['a', { name: 'a', version: '1.0.0' }]], { a: '^1' });
    await mkdir(input.staging); await writeFile(join(input.staging, 'user.txt'), 'untouched');
    await assert.rejects(stageOfficialShell(input.checkout, input.staging), /empty physical directory/);
    assert.equal(await readFile(join(input.staging, 'user.txt'), 'utf8'), 'untouched');
  } finally { await cleanup(directory); }
});

test('source junctions cannot import packages outside the locked checkout', async () => {
  const directory = await privateDirectory();
  let link;
  try {
    const input = await fixture(directory, [], { external: '^1' });
    const external = join(directory, 'outside');
    await writeManifest(external, { name: 'external', version: '1.0.0' });
    await mkdir(join(input.desktop, 'node_modules'));
    link = join(input.desktop, 'node_modules/external');
    await symlink(external, link, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(stageOfficialShell(input.checkout, input.staging), /escapes the locked checkout/);
    assert.equal(await readFile(join(external, 'entry.js'), 'utf8'), 'module.exports = "fixture";\n');
  } finally {
    if (link) await unlink(link).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await cleanup(directory);
  }
});

test('actual locked official shell closure stages outside the source tree without links',
  { skip: process.env.DSH_SHELL_REAL_TEST !== '1' }, async () => {
    const directory = await privateDirectory();
    try {
      const staging = join(directory, 'staging');
      const checkout = process.env.DSH_OFFICIAL_SOURCE || 'C:/DSHB/harness-020rc2';
      const receipt = await stageOfficialShell(checkout, staging);
      for (const name of ['electron-updater', 'semver', 'ws', '@deepseek-ai/dsh-api-gateway', '@deepseek-ai/cordis']) {
        assert(receipt.packages.some(pkg => pkg.path === `node_modules/${name}`));
      }
      await receiptMatches(staging, receipt);
      const { createTransformer } = createRequire(import.meta.url)('app-builder-lib/out/fileTransformer.js');
      const transform = createTransformer(staging, {}, undefined, undefined);
      for (const file of receipt.files.filter(file => file.path.endsWith('/package.json') || file.path === 'package.json')) {
        assert.equal(await transform(join(staging, ...file.path.split('/'))), null,
          `builder would change sealed manifest ${file.path}`);
      }
      const sourceRequire = createRequire(join(checkout, 'apps/desktop/package.json'));
      const updaterPackage = await realpath(sourceRequire.resolve('electron-updater/package.json'));
      const updaterRequire = createRequire(updaterPackage);
      const rootSemver = JSON.parse(await readFile(sourceRequire.resolve('semver/package.json'), 'utf8')).version;
      const updaterSemver = JSON.parse(await readFile(updaterRequire.resolve('semver/package.json'), 'utf8')).version;
      assert.notEqual(rootSemver, updaterSemver, 'locked source fixture must contain conflicting semver versions');
      assert(receipt.packages.some(pkg => pkg.name === 'semver' && pkg.version === rootSemver));
      assert(receipt.packages.some(pkg => pkg.name === 'semver' && pkg.version === updaterSemver));
      console.log(`Actual frozen shell: ${receipt.packages.length} package placements and ${receipt.files.length} physical files`);
    } finally { await cleanup(directory); }
  });

test('official config invokes the external dependency hook instead of returning before it',
  { skip: !existsSync(join(root, '.official-build/paths.json')) }, async () => {
    const { default: config } = await import('./official-builder.config.mjs');
    assert.equal(config.npmRebuild, true, 'npmRebuild:false returns before beforeBuild runs');
    assert.notEqual(config.nodeGypRebuild, true, 'node-gyp must not run before the external closure hook');
    assert.equal(await config.beforeBuild({}), false);
    const require = createRequire(import.meta.url);
    require('app-builder-lib');
    const { Packager } = require('app-builder-lib/out/packager.js');
    let hookCalls = 0;
    const instance = {
      options: {}, framework: { isNpmRebuildRequired: true, version: '44.0.0' },
      config: { ...config, beforeBuild: async context => { hookCalls++; return config.beforeBuild(context); } },
      appInfo: { type: 'module' }, appDir: config.directories.app, _nodeModulesHandledExternally: false,
      getWorkspaceRoot: async () => root,
    };
    await Packager.prototype.installAppDependencies.call(instance, { nodeName: 'win32' }, 1);
    assert.equal(hookCalls, 1);
    const externallyHandled = Object.getOwnPropertyDescriptor(Packager.prototype, 'areNodeModulesHandledExternally').get;
    assert.equal(externallyHandled.call(instance), true);
    const { PlatformPackager } = require('app-builder-lib/out/platformPackager.js');
    assert.match(PlatformPackager.prototype.copyAppFiles.toString(), /!this\.info\.areNodeModulesHandledExternally/,
      'the pinned collector must be guarded by the externally-handled getter');
    // Negative control documents the early-return bug and protects this assertion from becoming vacuous.
    instance.config.npmRebuild = false; instance._nodeModulesHandledExternally = false; hookCalls = 0;
    await Packager.prototype.installAppDependencies.call(instance, { nodeName: 'win32' }, 1);
    assert.equal(hookCalls, 0);
    assert.equal(externallyHandled.call(instance), false);
  });
