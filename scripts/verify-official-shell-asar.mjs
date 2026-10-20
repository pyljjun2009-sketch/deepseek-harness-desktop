/** Verify the frozen shell dependency closure inside an ASAR without executing packaged code. */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const BUILDER_VERSION = '26.15.3';
const RECEIPT = 'shell-dependency-receipt.json';
const MAX_RECEIPT_BYTES = 32 * 1024 * 1024;
const sha256 = body => createHash('sha256').update(body).digest('hex');
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const shellPath = path => path.startsWith('node_modules/');
function safePath(value) {
  return typeof value === 'string' && value.length > 0 && !/[\\:\u0000-\u001f\u007f]/.test(value)
    && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}
function fail(detail) { throw new Error(`Frozen shell ASAR: ${detail}`); }
async function optionalStat(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

/** Confirm a physical unpacked file cannot escape through a symlink/junction ancestor. */
async function physicalFile(unpackedRoot, portablePath) {
  let current = unpackedRoot;
  for (const [index, part] of ['', ...portablePath.split('/')].entries()) {
    if (index !== 0) current = join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) fail(`unpacked link at ${index === 0 ? 'archive root' : portablePath}`);
    if (index === portablePath.split('/').length) {
      if (!stat.isFile()) fail(`unpacked entry is not a file: ${portablePath}`);
      return stat;
    }
    if (!stat.isDirectory()) fail(`unpacked ancestor is not a directory: ${portablePath}`);
  }
}

/**
 * Compare every root node_modules asset to its staged SHA-256/length receipt. The application
 * overlay (lib, renderer, desktop tests and rewritten root package.json) is deliberately outside
 * this shell-only seal; DSH's separate runtime descriptor verifies its own production closure.
 * Only the project's pinned app-builder-lib ASAR reader is loaded, never a module from the ASAR.
 * @param {string} archivePath Absolute path of a completed app.asar.
 * @returns {Promise<object>} Counts and receipt digest, never package contents or credentials.
 */
export async function verifyOfficialShellAsar(archivePath) {
  if (typeof archivePath !== 'string' || !isAbsolute(archivePath)) fail('archive path must be absolute');
  const archive = resolve(archivePath);
  const initialStat = await lstat(archive);
  if (!initialStat.isFile() || initialStat.isSymbolicLink()) fail('archive must be a physical regular file');
  const builder = JSON.parse(await readFile(require.resolve('app-builder-lib/package.json'), 'utf8'));
  if (builder.version !== BUILDER_VERSION) fail(`qualify the reader for builder ${builder.version} before verification`);
  const { readAsar } = require('app-builder-lib/out/asar/asar.js');
  const filesystem = await readAsar(archive);
  const root = filesystem.header;
  if (!plainObject(root) || !plainObject(root.files)) fail('invalid archive root');
  const receiptNode = root.files[RECEIPT];
  if (!plainObject(receiptNode) || receiptNode.link !== undefined || receiptNode.files !== undefined
    || (receiptNode.unpacked !== undefined && receiptNode.unpacked !== false) || !Number.isSafeInteger(receiptNode.size)
    || receiptNode.size <= 0 || receiptNode.size > MAX_RECEIPT_BYTES) fail('missing or invalid packed receipt');

  function validatePackedRange(node, path) {
    if (!Number.isSafeInteger(node.size) || node.size < 0) fail(`invalid file size: ${path}`);
    if (node.unpacked !== undefined && typeof node.unpacked !== 'boolean') fail(`invalid unpacked flag: ${path}`);
    if (node.unpacked === true) return;
    if (typeof node.offset !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(node.offset)) fail(`invalid file offset: ${path}`);
    const offset = Number(node.offset);
    const absoluteOffset = 8 + filesystem.headerSize + offset;
    if (!Number.isSafeInteger(absoluteOffset) || absoluteOffset < 8 + filesystem.headerSize
      || absoluteOffset + node.size > initialStat.size) fail(`file range exceeds archive: ${path}`);
  }
  validatePackedRange(receiptNode, RECEIPT);
  const receiptBody = await filesystem.readFile(RECEIPT);
  let receipt;
  try { receipt = JSON.parse(receiptBody.toString('utf8')); }
  catch { fail('receipt is not valid JSON'); }
  if (!plainObject(receipt) || receipt.schemaVersion !== 1 || receipt.productionOnly !== true
    || receipt.metadataBuilderVersion !== BUILDER_VERSION || !Array.isArray(receipt.files)
    || !Array.isArray(receipt.packages)) fail('unsupported receipt schema or metadata builder');

  const expected = new Map();
  const seenReceiptPaths = new Set();
  for (const record of receipt.files) {
    if (!plainObject(record) || !safePath(record.path)) fail('invalid receipt file path');
    const identity = record.path.toLowerCase();
    if (seenReceiptPaths.has(identity)) fail(`duplicate receipt path: ${record.path}`);
    seenReceiptPaths.add(identity);
    if (!shellPath(record.path)) continue; // Overlay files may have changed or intentionally not been packed.
    if (!Number.isSafeInteger(record.bytes) || record.bytes < 0 || !/^[0-9a-f]{64}$/.test(record.sha256 ?? '')) {
      fail(`invalid receipt file metadata: ${record.path}`);
    }
    expected.set(record.path, record);
  }
  if (expected.size === 0) fail('receipt contains no shell dependency files');
  const packagePaths = new Set();
  for (const pkg of receipt.packages) {
    if (!plainObject(pkg) || !safePath(pkg.path) || !shellPath(pkg.path)
      || packagePaths.has(pkg.path.toLowerCase()) || !expected.has(`${pkg.path}/package.json`)) fail('invalid receipt package placement');
    packagePaths.add(pkg.path.toLowerCase());
  }
  if (packagePaths.size === 0) fail('receipt contains no shell package placements');

  const actual = new Map();
  const seenArchivePaths = new Set();
  const modules = root.files.node_modules;
  if (!plainObject(modules) || modules.link !== undefined || !plainObject(modules.files)) fail('missing physical shell dependency directory');
  function visit(node, path) {
    if (!plainObject(node) || node.link !== undefined) fail(`archive dependency link or invalid entry: ${path}`);
    const identity = path.toLowerCase();
    if (seenArchivePaths.has(identity)) fail(`duplicate archive dependency path: ${path}`);
    seenArchivePaths.add(identity);
    if (node.files !== undefined) {
      if (!plainObject(node.files) || node.size !== undefined || node.offset !== undefined) fail(`invalid dependency directory: ${path}`);
      for (const [name, child] of Object.entries(node.files)) {
        if (!safePath(name) || name.includes('/')) fail('invalid archive dependency entry name');
        visit(child, `${path}/${name}`);
      }
    } else {
      validatePackedRange(node, path);
      if (!expected.has(path)) fail(`unexpected dependency file: ${path}`);
      actual.set(path, node);
    }
  }
  visit(modules, 'node_modules');
  for (const path of expected.keys()) if (!actual.has(path)) fail(`missing dependency file: ${path}`);

  const unpackedRoot = `${archive}.unpacked`;
  const unpacked = new Set([...actual].filter(([, node]) => node.unpacked === true).map(([path]) => path));
  const physicalModules = join(unpackedRoot, 'node_modules');
  if (await optionalStat(physicalModules)) {
    const unpackedStat = await lstat(unpackedRoot);
    if (!unpackedStat.isDirectory() || unpackedStat.isSymbolicLink()) fail('unpacked root must be a physical directory');
    async function visitUnpacked(path, portablePath) {
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) fail(`unpacked dependency link: ${portablePath}`);
      if (stat.isDirectory()) {
        for (const entry of await readdir(path)) await visitUnpacked(join(path, entry), `${portablePath}/${entry}`);
      } else if (!stat.isFile() || !unpacked.has(portablePath)) fail(`unexpected unpacked dependency entry: ${portablePath}`);
    }
    await visitUnpacked(physicalModules, 'node_modules');
  }

  let totalBytes = 0;
  for (const [path, record] of expected) {
    const node = actual.get(path);
    if (node.size !== record.bytes) fail(`dependency length mismatch: ${path}`);
    if (node.unpacked === true) {
      const stat = await physicalFile(unpackedRoot, path);
      if (stat.size !== record.bytes) fail(`unpacked dependency length mismatch: ${path}`);
    }
    const body = await filesystem.readFile(join(...path.split('/')));
    if (body.length !== record.bytes || sha256(body) !== record.sha256) fail(`dependency content mismatch: ${path}`);
    totalBytes += record.bytes;
  }
  const finalStat = await lstat(archive);
  if (!finalStat.isFile() || finalStat.isSymbolicLink() || finalStat.size !== initialStat.size
    || finalStat.mtimeMs !== initialStat.mtimeMs || finalStat.ino !== initialStat.ino) fail('archive changed during verification');
  return { packageCount: packagePaths.size, fileCount: expected.size, totalBytes,
    receiptSha256: sha256(receiptBody), metadataBuilderVersion: BUILDER_VERSION };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/verify-official-shell-asar.mjs <absolute-app.asar>');
  console.log('Frozen shell ASAR verified:', await verifyOfficialShellAsar(process.argv[2]));
}
