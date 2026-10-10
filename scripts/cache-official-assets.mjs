import { readFile, mkdir, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadGithubAsset } from './download-github-asset.mjs';

export async function cacheOfficialAssets(source) {
  const lock = JSON.parse(await readFile(join(source, 'scripts/primary-runtime/lock.json'), 'utf8'));
  const target = lock.targets['win-x64'];
  const python = `cpython-${lock.pythonVersion}+${lock.pythonRelease}-${target.pythonTarget}-install_only_stripped.tar.gz`;
  const items = [
    { url: `https://nodejs.org/dist/v${lock.nodeVersion}/node-v${lock.nodeVersion}-${target.nodeArchive}`, sha256: target.nodeSha256 },
    { url: `https://github.com/astral-sh/python-build-standalone/releases/download/${lock.pythonRelease}/${encodeURIComponent(python)}`, sha256: target.pythonSha256 },
    ...target.wheels, ...lock.wheels
  ];
  const cache = join(source, 'apps/desktop/.desktop-build/downloads');
  await mkdir(cache, { recursive: true });
  let cursor = 0;
  const run = promisify(execFile);
  await Promise.all(Array.from({length: 4}, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      const destination = join(cache, item.sha256);
      const valid = body => createHash('sha256').update(body).digest('hex') === item.sha256;
      try { if (valid(await readFile(destination))) continue; } catch {}
      if (new URL(item.url).hostname === 'github.com') {
        await downloadGithubAsset(item.url, destination, item.sha256);
        console.log('Cached and SHA-256 verified: official GitHub release asset');
        continue;
      }
      await run('curl.exe', ['--silent', '--show-error', '--fail', '--location', '--retry', '2',
        '--connect-timeout', '20', '--max-time', '240', item.url, '--output', `${destination}.download`], { windowsHide: true });
      if (!valid(await readFile(`${destination}.download`))) throw new Error('Official asset checksum mismatch');
      await rename(`${destination}.download`, destination);
      console.log(`Cached and SHA-256 verified: ${new URL(item.url).pathname.split('/').pop()}`);
    }
  }));
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) await cacheOfficialAssets(resolve(process.argv[2]));
