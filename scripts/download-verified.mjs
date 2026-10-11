import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

// Bounded range retries are only a transport workaround. A final upstream checksum is mandatory.
export async function downloadVerified(url, destination, bytes, integrity) {
  const [algorithm, expected] = integrity.split('-');
  if (!['sha256', 'sha512'].includes(algorithm) || !expected) throw new Error('Expected upstream integrity');
  const encoding = algorithm === 'sha256' && /^[a-f0-9]{64}$/.test(expected) ? 'hex' : 'base64';
  const matches = body => createHash(algorithm).update(body).digest(encoding) === expected;
  try { if (matches(await readFile(destination))) return destination; } catch {}
  await mkdir(dirname(destination), { recursive: true });
  const chunkSize = 100000;
  const count = Math.ceil(bytes / chunkSize);
  let cursor = 0;
  const run = promisify(execFile);
  await Promise.all(Array.from({length: 8}, async () => {
    while (cursor < count) {
      const index = cursor++;
      const start = index * chunkSize; const end = Math.min(bytes - 1, start + chunkSize - 1);
      const part = `${destination}.part-${index}`;
      let complete = false;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          if ((await stat(part)).size === end - start + 1) { complete = true; break; }
        } catch {}
        try {
          await run('curl.exe', ['--silent', '--show-error', '--fail', '--location', '--http1.1',
            '--connect-timeout', '15', '--max-time', '45', '--range', `${start}-${end}`,
            `${url}?range=${index}&attempt=${attempt}`, '--output', part], { windowsHide: true });
          if ((await stat(part)).size !== end - start + 1) throw new Error('Incorrect range length');
          complete = true; break;
        } catch (error) { if (attempt === 3) throw error; }
      }
      if (!complete) throw new Error(`Incomplete download range ${index}`);
      console.log(`Verified transport range ${index + 1}/${count}`);
    }
  }));
  const body = Buffer.concat(await Promise.all(Array.from({length: count}, (_, i) => readFile(`${destination}.part-${i}`))));
  if (body.length !== bytes || !matches(body)) throw new Error('Upstream integrity mismatch: download rejected');
  await writeFile(destination, body, { mode: 0o600 });
  return destination;
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  await downloadVerified(...process.argv.slice(2).map((arg, i) => i === 2 ? Number(arg) : arg));
}
