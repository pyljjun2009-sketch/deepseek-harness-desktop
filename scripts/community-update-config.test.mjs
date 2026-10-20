import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { communityUpdateConfiguration, writeCommunityUpdateConfiguration, verifyCommunityUpdateConfiguration } from './community-update-config.mjs';

test('update identity is fixed and rejects arbitrary cache names', () => {
  assert.deepEqual(communityUpdateConfiguration('deepseek-harness-desktop'), {
    provider: 'github', owner: 'pyljjun2009-sketch', repo: 'deepseek-harness-desktop', channel: 'latest',
    updaterCacheDirName: 'deepseek-harness-desktop-updater' });
  assert.throws(() => communityUpdateConfiguration('another-app'));
});

test('prepackaged update file is present and rejects extra endpoint fields', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-update-qa-'));
  try {
    await writeCommunityUpdateConfiguration(root, 'deepseek-harness-desktop');
    const path = join(root, 'app-update.yml');
    const content = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(content.owner, 'pyljjun2009-sketch');
    await writeFile(path, JSON.stringify({ ...content, url: 'https://example.invalid' }));
    await assert.rejects(verifyCommunityUpdateConfiguration(root, 'deepseek-harness-desktop'));
    await writeFile(path, 'x'.repeat(4097));
    await assert.rejects(verifyCommunityUpdateConfiguration(root, 'deepseek-harness-desktop'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('update writer refuses a linked resources directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-update-link-qa-'));
  try {
    const linked = join(root, 'linked');
    await symlink(root, linked, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(writeCommunityUpdateConfiguration(linked, 'deepseek-harness-desktop'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
