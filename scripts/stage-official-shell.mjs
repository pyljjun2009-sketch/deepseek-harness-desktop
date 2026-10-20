/** Materialize the installed, frozen desktop-shell production graph without package-manager execution. */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rmdir, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const packageName = /^(?:@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*|[a-z0-9][a-z0-9._~-]*)$/i;
export const SHELL_METADATA_BUILDER_VERSION = '26.15.3';
// Matches app-builder-lib 26.15.3's fileTransformer.js cleanupPackageJson.
const ignoredMetadata = new Set(['dist', 'gitHead', 'build', 'jspm', 'ava', 'xo', 'nyc', 'eslintConfig', 'contributors', 'bundleDependencies', 'tags']);
const sha256 = body => createHash('sha256').update(body).digest('hex');
const portable = path => path.split(sep).join('/');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function inside(root, file) {
  const suffix = relative(root, file);
  return suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
async function exists(file) {
  try { await lstat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
/** Publish a fully verified private candidate. Windows scanners may briefly hold newly written
 * files open, so retry only its transient sharing/access errors, for at most 1.8 seconds. Never
 * remove or replace a destination that appeared after staging validation. Injectable operations
 * let tests cover the failure policy without manufacturing filesystem races.
 */
export async function publishShellStage(source, destination, {
  platform = process.platform, renameDirectory = rename, pathExists = exists, pause = delay,
} = {}) {
  const waits = [50, 100, 150, 200, 250, 300, 350, 400];
  for (let attempt = 0; ; attempt++) {
    if (await pathExists(destination)) throw new Error('Frozen shell: staging destination appeared before publication');
    try { await renameDirectory(source, destination); return; }
    catch (error) {
      if (platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt === waits.length) throw error;
      if (await pathExists(destination)) throw new Error('Frozen shell: staging destination appeared during publication', { cause: error });
      await pause(waits[attempt]);
    }
  }
}
function section(manifest, key) {
  const value = manifest[key] ?? {};
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.entries(value).some(([name, spec]) => !packageName.test(name) || typeof spec !== 'string')) {
    throw new Error(`Frozen shell: invalid ${key} in ${manifest.name}`);
  }
  return value;
}

/** Apply the pinned builder's default JSON metadata cleanup before inventory hashes are recorded.
 * Production routing, entry, export and dependency fields are preserved. The returned object is
 * independent at the top level; this does not mutate the source manifest or execute package code.
 * @param {object} original - Manifest after exact dependency-version rewriting.
 * @param {boolean} isMain - Whether this is the application manifest rather than a dependency.
 * @returns {object} Metadata-canonical manifest matching builder 26.15.3's default cleanup.
 */
export function cleanupShellManifest(original, isMain = false) {
  const manifest = { ...original };
  const dependencies = manifest.dependencies;
  const removeBabel = dependencies !== null && typeof dependencies === 'object'
    && !Object.getOwnPropertyNames(dependencies).some(name => name.startsWith('babel'));
  for (const property of Object.getOwnPropertyNames(manifest)) {
    if (property[0] === '_' || ignoredMetadata.has(property) || property === 'scripts' || property === 'keywords'
      || (isMain && property === 'devDependencies') || (!isMain && property === 'bugs')
      || (removeBabel && property === 'babel')) delete manifest[property];
  }
  return manifest;
}
function requestedDependencies(manifest) {
  const dependencies = section(manifest, 'dependencies');
  const optional = section(manifest, 'optionalDependencies');
  const peers = section(manifest, 'peerDependencies');
  const entries = new Map(Object.keys(dependencies).map(name => [name, false]));
  for (const name of Object.keys(optional)) entries.set(name, true);
  // Optional peers are not required by this shell. Include ordinary optional dependencies when installed.
  for (const name of Object.keys(peers)) {
    if (manifest.peerDependenciesMeta?.[name]?.optional !== true && !entries.has(name)) entries.set(name, false);
  }
  return [...entries].sort(([a], [b]) => compare(a, b));
}

/** Resolve through Node's package search directories without importing or executing a package. */
async function installedPackage(checkout, requester, name, optional) {
  const search = createRequire(join(requester, 'package.json')).resolve.paths(name) ?? [];
  for (const modules of search) {
    const candidate = join(modules, name);
    if (!inside(checkout, candidate) || !await exists(join(candidate, 'package.json'))) continue;
    const source = await realpath(candidate);
    if (!inside(checkout, source)) throw new Error(`Frozen shell: package ${name} escapes the locked checkout`);
    return source;
  }
  if (optional) return undefined;
  throw new Error(`Frozen shell: missing installed dependency ${name} in the locked checkout`);
}

/** Copy one package's real assets, excluding dependency containers and private development residue. */
async function copyPackage(checkout, source, destination) {
  const ancestors = new Set();
  async function visit(from, to) {
    const actual = await realpath(from);
    if (!inside(checkout, actual)) throw new Error(`Frozen shell: asset escapes the locked checkout: ${portable(relative(checkout, from))}`);
    const stat = await lstat(actual);
    if (stat.isDirectory()) {
      if (ancestors.has(actual)) throw new Error(`Frozen shell: cyclic asset link in ${portable(relative(checkout, source))}`);
      ancestors.add(actual);
      await mkdir(to, { recursive: true });
      for (const entry of await readdir(actual, { withFileTypes: true })) {
        if (['node_modules', '.git', '.pnpm', '.cache', '.DS_Store'].includes(entry.name) || entry.name.toLowerCase().startsWith('.env') || entry.name.endsWith('.tsbuildinfo')) continue;
        await visit(join(actual, entry.name), join(to, entry.name));
      }
      ancestors.delete(actual);
    } else if (stat.isFile()) {
      await writeFile(to, await readFile(actual), { mode: stat.mode });
    } else throw new Error(`Frozen shell: unsupported package asset ${portable(relative(checkout, from))}`);
  }
  await visit(source, destination);
}

/** Record only physical files; a link in the staged shell is a hard packaging failure. */
export async function inventoryShellFiles(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error(`Frozen shell: staged link ${portable(relative(root, path))}`);
      if (stat.isDirectory()) await visit(path);
      else if (stat.isFile()) {
        const body = await readFile(path);
        files.push({ path: portable(relative(root, path)), bytes: body.length, sha256: sha256(body) });
      } else throw new Error(`Frozen shell: unsupported staged entry ${portable(relative(root, path))}`);
    }
  }
  await visit(root);
  return files.sort((a, b) => compare(a.path, b.path));
}

/** Copy only production dependencies from a locked, already-installed official checkout.
 * No registry lookup, install hook, package code execution or ambient dependency fallback occurs.
 * The destination must not exist or must be an empty physical directory. This function publishes
 * only after all packages are copied, inventoried and the source lock is rechecked.
 * @param {string} sourceRoot - Official checkout containing pnpm-lock.yaml and apps/desktop.
 * @param {string} stagingRoot - Fresh desktop-shell staging directory, never the checkout root.
 * @returns {Promise<object>} Exact installed package identities and copied-file SHA-256 receipt.
 */
export async function stageOfficialShell(sourceRoot, stagingRoot) {
  const builderManifest = JSON.parse(await readFile(createRequire(import.meta.url).resolve('app-builder-lib/package.json'), 'utf8'));
  if (builderManifest.version !== SHELL_METADATA_BUILDER_VERSION) {
    throw new Error(`Frozen shell: qualify metadata cleanup for builder ${builderManifest.version} before staging`);
  }
  const checkout = await realpath(resolve(sourceRoot));
  const staging = resolve(stagingRoot);
  const desktop = join(checkout, 'apps/desktop');
  if (staging === parse(staging).root || inside(staging, checkout) || staging === desktop || inside(desktop, staging)) {
    throw new Error('Frozen shell: staging must not contain the checkout or overlap apps/desktop');
  }
  if (await exists(staging)) {
    const stat = await lstat(staging);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await readdir(staging)).length !== 0) throw new Error('Frozen shell: staging must be an empty physical directory');
  }
  const lockBody = await readFile(join(checkout, 'pnpm-lock.yaml'));
  const lockText = lockBody.toString('utf8');
  const sourceLockSha256 = sha256(lockBody);
  const rootManifestBody = await readFile(join(desktop, 'package.json'));
  const rootManifest = JSON.parse(rootManifestBody.toString('utf8'));
  const graph = new Map();
  async function discover(source) {
    if (graph.has(source)) return graph.get(source);
    const manifestBody = await readFile(join(source, 'package.json'));
    const manifest = JSON.parse(manifestBody.toString('utf8'));
    if (!packageName.test(manifest.name) || typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version)) throw new Error('Frozen shell: package has invalid identity');
    const sourceRelative = portable(relative(checkout, source));
    if (sourceRelative.split('/').includes('node_modules')) {
      const key = new RegExp(`^  ['"]?${escapeRegExp(manifest.name)}@${escapeRegExp(manifest.version)}(?:\\([^\\r\\n]*\\))?['"]?:`, 'm');
      if (!key.test(lockText)) throw new Error(`Frozen shell: installed ${manifest.name}@${manifest.version} is absent from the source lock`);
    } else if (!lockText.includes(`\n  ${sourceRelative}:`)) {
      throw new Error(`Frozen shell: workspace ${sourceRelative} is absent from the source lock`);
    }
    const node = { source, sourceRelative, manifest, manifestSha256: sha256(manifestBody), edges: new Map(), omittedOptional: [] };
    // Register before recursion: source graph cycles are legal and must not be walked forever.
    graph.set(source, node);
    for (const [name, optional] of requestedDependencies(manifest)) {
      const child = await installedPackage(checkout, source, name, optional);
      if (child === undefined) node.omittedOptional.push(name);
      else node.edges.set(name, await discover(child));
    }
    return node;
  }
  const roots = new Map();
  const omittedRootOptional = [];
  for (const [name, optional] of requestedDependencies(rootManifest)) {
    const child = await installedPackage(checkout, desktop, name, optional);
    if (child === undefined) omittedRootOptional.push(name);
    else roots.set(name, await discover(child));
  }

  // Root identities win hoisting. Conflicting versions remain nested below their consumer.
  // Resolution observes assigned slots, not the builder's or user's ambient node_modules.
  const placements = new Map();
  const pending = [];
  function place(node, path, ancestry) {
    const record = { node, path, ancestry, dependencyPaths: {} };
    placements.set(path, record); pending.push(record); return record;
  }
  for (const [name, node] of roots) place(node, join(staging, 'node_modules', name), []);
  for (let index = 0; index < pending.length; index++) {
    const record = pending[index];
    for (const [name, child] of record.node.edges) {
      const candidates = (createRequire(join(record.path, 'package.json')).resolve.paths(name) ?? [])
        .map(modules => join(modules, name)).filter(path => inside(staging, path));
      const nearest = candidates.map(path => placements.get(path)).find(Boolean);
      let selected;
      if (nearest?.node === child) selected = nearest;
      else {
        if (record.ancestry.includes(child.source)) throw new Error(`Frozen shell: conflicting-version dependency cycle at ${child.manifest.name}; cannot materialize without links`);
        const rootPath = join(staging, 'node_modules', name);
        const target = nearest === undefined && !placements.has(rootPath) ? rootPath : join(record.path, 'node_modules', name);
        if (placements.has(target)) throw new Error(`Frozen shell: dependency placement conflict for ${name}`);
        selected = place(child, target, [...record.ancestry, record.node.source]);
      }
      record.dependencyPaths[name] = portable(relative(staging, selected.path));
    }
  }

  await mkdir(dirname(staging), { recursive: true });
  const temporary = await mkdtemp(join(dirname(staging), '.shell-stage-'));
  let published = false;
  try {
    const exactSection = (original, edges, key) => Object.fromEntries(Object.keys(section(original, key)).filter(name => edges.has(name)).map(name => {
      const installed = edges.get(name).manifest;
      return [name, installed.name === name ? installed.version : `npm:${installed.name}@${installed.version}`];
    }));
    function productionManifest(original, edges, isMain = false) {
      const manifest = { ...original, dependencies: exactSection(original, edges, 'dependencies') };
      if (original.optionalDependencies !== undefined) manifest.optionalDependencies = exactSection(original, edges, 'optionalDependencies');
      if (original.peerDependencies !== undefined) manifest.peerDependencies = exactSection(original, edges, 'peerDependencies');
      // The collector receives exact installed versions, not workspace: or unbounded registry specs.
      delete manifest.devDependencies; delete manifest.packageManager; delete manifest.workspaces; delete manifest.pnpm;
      return cleanupShellManifest(manifest, isMain);
    }
    for (const record of pending) {
      const destination = join(temporary, relative(staging, record.path));
      await copyPackage(checkout, record.node.source, destination);
      await writeFile(join(destination, 'package.json'), `${JSON.stringify(productionManifest(record.node.manifest, record.node.edges), null, 2)}\n`);
    }
    const manifest = productionManifest(rootManifest, roots, true);
    await writeFile(join(temporary, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    const receipt = {
      schemaVersion: 1, phase: 'shell-dependencies-before-community-overlay', sourceLockSha256,
      sourceDesktopManifestSha256: sha256(rootManifestBody), metadataBuilderVersion: SHELL_METADATA_BUILDER_VERSION,
      productionOnly: true, omittedRootOptional,
      packages: pending.map(record => ({ path: portable(relative(staging, record.path)), name: record.node.manifest.name,
        version: record.node.manifest.version, source: record.node.sourceRelative,
        sourceManifestSha256: record.node.manifestSha256, dependencies: record.dependencyPaths,
        omittedOptional: record.node.omittedOptional })).sort((a, b) => compare(a.path, b.path)),
      files: await inventoryShellFiles(temporary),
    };
    if (sha256(await readFile(join(checkout, 'pnpm-lock.yaml'))) !== sourceLockSha256) throw new Error('Frozen shell: source lock changed during staging');
    await writeFile(join(temporary, 'shell-dependency-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
    if (await exists(staging)) await rmdir(staging); // Empty, physical destination was validated; never recursively replaced.
    await publishShellStage(temporary, staging);
    published = true;
    return receipt;
  } finally {
    if (!published) {
      if (dirname(temporary) !== dirname(staging) || !temporary.startsWith(join(dirname(staging), '.shell-stage-'))) throw new Error('Frozen shell: unsafe temporary cleanup path');
      await rm(temporary, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) throw new Error('Usage: node scripts/stage-official-shell.mjs <official-checkout> <fresh-staging>');
  const receipt = await stageOfficialShell(process.argv[2], process.argv[3]);
  console.log(`Frozen shell materialized: ${receipt.packages.length} package placements, ${receipt.files.length} files, source lock ${receipt.sourceLockSha256}`);
}
