import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { lstat, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { finished } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { verifyOfficialShellAsar } from './verify-official-shell-asar.mjs';

const require = createRequire(import.meta.url);
const { createPackageWithOptions } = require('@electron/asar');
const { readAsar } = require('app-builder-lib/out/asar/asar.js');
const { createEmpty } = require('chromium-pickle-js');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = join(root, '.official-build');
const digest = body => createHash('sha256').update(body).digest('hex');

async function privateDirectory() {
  await mkdir(scratch, { recursive: true });
  return mkdtemp(join(scratch, 'shell-asar-test-'));
}
async function cleanup(directory) {
  const suffix = relative(scratch, resolve(directory));
  assert(suffix !== '' && suffix !== '..' && !suffix.startsWith(`..${sep}`));
  assert.equal(dirname(resolve(directory)), resolve(scratch));
  await rm(directory, { recursive: true, force: true });
}
async function writeAsset(source, path, body) {
  const destination = join(source, ...path.split('/'));
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, body);
}
async function packFixture(source, archive, options = {}) {
  // @electron/asar 3.4.1 resolves to the archive WriteStream after end(), not finish.
  // Await physical completion so range/tampering checks never race pending body writes.
  const writer = await createPackageWithOptions(source, archive, options);
  await finished(writer);
}
async function fixture(directory, { mutate, unpack = false } = {}) {
  const source = join(directory, 'source');
  const archive = join(directory, 'app.asar');
  const files = new Map([
    ['node_modules/a/package.json', Buffer.from('{"name":"a","version":"1.0.0","main":"entry.js"}\n')],
    ['node_modules/a/entry.js', Buffer.from('throw new Error("Packaged code must never execute during verification");\n')],
    ['node_modules/a/empty', Buffer.alloc(0)],
    ['node_modules/@scope/core/package.json', Buffer.from('{"name":"@scope/core","version":"1.0.0"}\n')],
    ['node_modules/@scope/core/node_modules/shared/package.json', Buffer.from('{"name":"shared","version":"2.0.0"}\n')],
    ['node_modules/@scope/core/node_modules/shared/index.js', Buffer.from('export default "nested fixture";\n')],
  ]);
  for (const [path, body] of files) await writeAsset(source, path, body);
  const receipt = { schemaVersion: 1, productionOnly: true, metadataBuilderVersion: '26.15.3',
    phase: 'shell-dependencies-before-community-overlay',
    packages: [
      { path: 'node_modules/a', name: 'a', version: '1.0.0' },
      { path: 'node_modules/@scope/core', name: '@scope/core', version: '1.0.0' },
      { path: 'node_modules/@scope/core/node_modules/shared', name: 'shared', version: '2.0.0' },
    ],
    files: [...files].map(([path, body]) => ({ path, bytes: body.length, sha256: digest(body) })),
  };
  // These pre-overlay files are intentionally absent from the shipped ASAR or changed in it.
  receipt.files.push({ path: 'desktop/launcher.test.cjs', bytes: 10, sha256: digest('unpackaged') });
  receipt.files.push({ path: 'package.json', bytes: 7, sha256: digest('old app') });
  await writeAsset(source, 'package.json', '{"name":"community-app","version":"0.5.0"}\n');
  if (mutate) await mutate({ source, files, receipt });
  const receiptBody = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  await writeAsset(source, 'shell-dependency-receipt.json', receiptBody);
  // The pinned API matches absolute filenames with matchBase:true. A basename also
  // works beneath the hidden .official-build ancestor, unlike a dot:false ** glob.
  await packFixture(source, archive, unpack ? { unpack: 'entry.js' } : {});
  if (unpack) {
    const filesystem = await readAsar(archive);
    assert.equal(filesystem.header.files.node_modules.files.a.files['entry.js'].unpacked, true);
    const unpackedEntry = join(`${archive}.unpacked`, 'node_modules', 'a', 'entry.js');
    assert.equal((await lstat(unpackedEntry)).isFile(), true);
    assert.deepEqual(await readFile(unpackedEntry), files.get('node_modules/a/entry.js'));
  }
  return { source, archive, files, receipt, receiptBody };
}
async function rewriteHeader(archive, change) {
  const filesystem = await readAsar(archive);
  const body = await readFile(archive);
  const data = body.subarray(8 + filesystem.headerSize);
  change(filesystem.header);
  const header = createEmpty();
  header.writeString(JSON.stringify(filesystem.header));
  const headerBody = header.toBuffer();
  const size = createEmpty();
  size.writeUInt32(headerBody.length);
  await writeFile(archive, Buffer.concat([size.toBuffer(), headerBody, data]));
}

test('valid packed closure verifies all assets without executing them and excludes community overlay files', async () => {
  const directory = await privateDirectory();
  try {
    const input = await fixture(directory);
    const result = await verifyOfficialShellAsar(input.archive);
    assert.deepEqual(result, { packageCount: 3, fileCount: 6,
      totalBytes: [...input.files.values()].reduce((total, body) => total + body.length, 0),
      receiptSha256: digest(input.receiptBody), metadataBuilderVersion: '26.15.3' });
  } finally { await cleanup(directory); }
});

test('missing and extra dependency files fail the exact receipt inventory', async () => {
  for (const extra of [false, true]) {
    const directory = await privateDirectory();
    try {
      const input = await fixture(directory, { mutate: async ({ source }) => {
        if (extra) await writeAsset(source, 'node_modules/a/unexpected.js', 'unexpected');
        else await unlink(join(source, 'node_modules/a/entry.js'));
      } });
      await assert.rejects(verifyOfficialShellAsar(input.archive), extra ? /unexpected dependency file/ : /missing dependency file/);
    } finally { await cleanup(directory); }
  }
});

test('same-length tampering and changed lengths fail independent content and length checks', async () => {
  for (const sameLength of [false, true]) {
    const directory = await privateDirectory();
    try {
      const input = await fixture(directory, { mutate: async ({ source, files }) => {
        const original = files.get('node_modules/a/entry.js');
        const changed = sameLength ? Buffer.from(original) : Buffer.concat([original, Buffer.from('extra')]);
        if (sameLength) changed[0] ^= 1;
        await writeAsset(source, 'node_modules/a/entry.js', changed);
      } });
      await assert.rejects(verifyOfficialShellAsar(input.archive), sameLength ? /dependency content mismatch/ : /dependency length mismatch/);
    } finally { await cleanup(directory); }
  }
});

test('duplicate, unsafe and invalid receipt records or package placements are rejected', async () => {
  const mutations = [
    receipt => receipt.files.push({ ...receipt.files[0] }),
    receipt => receipt.files.push({ ...receipt.files[0], path: receipt.files[0].path.toUpperCase() }),
    receipt => { receipt.files[0].path = 'node_modules/../outside'; },
    receipt => { receipt.files[0].path = 'node_modules\\a\\package.json'; },
    receipt => { receipt.files[0].bytes = -1; },
    receipt => { receipt.files[0].sha256 = 'not-a-hash'; },
    receipt => { receipt.packages.push({ ...receipt.packages[0] }); },
    receipt => { receipt.packages[0].path = 'node_modules/unreceipted'; },
    receipt => { receipt.packages = []; },
    receipt => { receipt.files = receipt.files.filter(record => !record.path.startsWith('node_modules/')); },
  ];
  for (const mutate of mutations) {
    const directory = await privateDirectory();
    try {
      const input = await fixture(directory, { mutate: async ({ receipt }) => mutate(receipt) });
      await assert.rejects(verifyOfficialShellAsar(input.archive), /Frozen shell ASAR:/);
    } finally { await cleanup(directory); }
  }
});

test('unqualified metadata-builder versions and unsupported receipt schemas fail closed', async () => {
  for (const changes of [{ metadataBuilderVersion: '26.15.2' }, { schemaVersion: 2 }, { productionOnly: false }]) {
    const directory = await privateDirectory();
    try {
      const input = await fixture(directory, { mutate: async ({ receipt }) => Object.assign(receipt, changes) });
      await assert.rejects(verifyOfficialShellAsar(input.archive), /unsupported receipt schema or metadata builder/);
    } finally { await cleanup(directory); }
  }
});

test('ASAR dependency file links, directory links and case aliases cannot bypass the seal', async () => {
  const mutations = [
    header => { header.files.node_modules.files.a.files['entry.js'] = { link: 'outside.js' }; },
    header => { header.files.node_modules.files.a = { link: 'outside' }; },
    header => { header.files.node_modules.files.A = header.files.node_modules.files.a; },
    header => { header.files.node_modules.files['..'] = { files: {} }; },
    header => { header.files.node_modules.files.a.files['entry.js'].unpacked = 'true'; },
  ];
  for (const mutate of mutations) {
    const directory = await privateDirectory();
    try {
      const input = await fixture(directory);
      await rewriteHeader(input.archive, mutate);
      await assert.rejects(verifyOfficialShellAsar(input.archive), /Frozen shell ASAR:/);
    } finally { await cleanup(directory); }
  }
});

test('a missing, linked, unpacked or invalid JSON receipt is never followed or executed', async () => {
  const mutations = [
    header => { delete header.files['shell-dependency-receipt.json']; },
    header => { header.files['shell-dependency-receipt.json'] = { link: 'node_modules/a/entry.js' }; },
    header => { header.files['shell-dependency-receipt.json'].unpacked = true; },
    header => { header.files['shell-dependency-receipt.json'].unpacked = 'true'; },
  ];
  for (const mutate of mutations) {
    const directory = await privateDirectory();
    try {
      const input = await fixture(directory);
      await rewriteHeader(input.archive, mutate);
      await assert.rejects(verifyOfficialShellAsar(input.archive), /missing or invalid packed receipt/);
    } finally { await cleanup(directory); }
  }
  const directory = await privateDirectory();
  try {
    const input = await fixture(directory);
    await writeAsset(input.source, 'shell-dependency-receipt.json', '{ invalid JSON');
    await packFixture(input.source, input.archive);
    await assert.rejects(verifyOfficialShellAsar(input.archive), /receipt is not valid JSON/);
  } finally { await cleanup(directory); }
});

test('unpacked shell assets are sealed and physical extras or corruption fail closed', async () => {
  for (const mutation of ['none', 'extra', 'missing', 'changed']) {
    const directory = await privateDirectory();
    try {
      const input = await fixture(directory, { unpack: true });
      const unpacked = `${input.archive}.unpacked`;
      if (mutation === 'extra') await writeAsset(unpacked, 'node_modules/a/unexpected.js', 'extra');
      if (mutation === 'missing') await unlink(join(unpacked, 'node_modules/a/entry.js'));
      if (mutation === 'changed') await writeAsset(unpacked, 'node_modules/a/entry.js', 'corrupted');
      if (mutation === 'none') assert.equal((await verifyOfficialShellAsar(input.archive)).fileCount, 6);
      else await assert.rejects(verifyOfficialShellAsar(input.archive), mutation === 'extra' ? /unexpected unpacked dependency entry/ : mutation === 'missing' ? { code: 'ENOENT' } : /unpacked dependency length mismatch/);
    } finally { await cleanup(directory); }
  }
});

test('invalid offsets, sizes and truncated archive bodies are rejected before unsafe reads', async () => {
  const mutations = [
    header => { header.files.node_modules.files.a.files['entry.js'].offset = '-1'; },
    header => { header.files.node_modules.files.a.files['entry.js'].offset = '999999999999999999999'; },
    header => { header.files.node_modules.files.a.files['entry.js'].size = -1; },
    header => { header.files.node_modules.files.a.files['entry.js'].offset = '1oops'; },
  ];
  for (const mutate of mutations) {
    const directory = await privateDirectory();
    try {
      const input = await fixture(directory);
      await rewriteHeader(input.archive, mutate);
      await assert.rejects(verifyOfficialShellAsar(input.archive), /invalid file (?:offset|size)|file range exceeds archive/);
    } finally { await cleanup(directory); }
  }
  const directory = await privateDirectory();
  try {
    const input = await fixture(directory);
    const body = await readFile(input.archive);
    await writeFile(input.archive, body.subarray(0, body.length - 1));
    await assert.rejects(verifyOfficialShellAsar(input.archive), /file range exceeds archive/);
  } finally { await cleanup(directory); }
});

test('the verifier accepts only an absolute regular archive path', async () => {
  await assert.rejects(verifyOfficialShellAsar('app.asar'), /archive path must be absolute/);
  await assert.rejects(verifyOfficialShellAsar(null), /archive path must be absolute/);
  const directory = await privateDirectory();
  try { await assert.rejects(verifyOfficialShellAsar(directory), /archive must be a physical regular file/); }
  finally { await cleanup(directory); }
});
