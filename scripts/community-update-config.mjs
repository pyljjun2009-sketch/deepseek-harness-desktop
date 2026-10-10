/** Fixed community update identity; prepackaged builds skip builder's afterPack publish hook. */
import assert from 'node:assert/strict';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const communityPackageName = 'deepseek-harness-desktop';

export function communityUpdateConfiguration(packageName) {
  assert.equal(packageName, communityPackageName, 'Unexpected community package identity');
  return { provider: 'github', owner: 'pyljjun2009-sketch', repo: 'deepseek-harness-desktop',
    channel: 'latest', updaterCacheDirName: `${communityPackageName}-updater` };
}

export async function verifyCommunityUpdateConfiguration(resources, packageName) {
  const path = join(resources, 'app-update.yml');
  const stat = await lstat(path);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 4096, 'Invalid community update file');
  const yaml = require('js-yaml');
  const parsed = yaml.load(await readFile(path, 'utf8'), { schema: yaml.JSON_SCHEMA });
  assert.deepEqual(parsed, communityUpdateConfiguration(packageName), 'Unexpected community update feed');
}

export async function writeCommunityUpdateConfiguration(resources, packageName) {
  // Read-only parent checks prevent redirecting the generated file through a linked tree.
  let current = resolve(resources);
  while (true) {
    assert((await lstat(current)).isDirectory() && !(await lstat(current)).isSymbolicLink());
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
  const path = join(resources, 'app-update.yml');
  try { const stat = await lstat(path); assert(stat.isFile() && !stat.isSymbolicLink()); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  // JSON is valid YAML, and contains no credentials or input-controlled endpoint.
  await writeFile(path, `${JSON.stringify(communityUpdateConfiguration(packageName), null, 2)}\n`);
  await verifyCommunityUpdateConfiguration(resources, packageName);
}
