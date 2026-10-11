import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const path = fileURLToPath(new URL('./qualify-official-recovery.mjs', import.meta.url));
test('real-crash qualification is inert without explicit run intent', async () => {
  const result = await promisify(execFile)(process.execPath, [path], { windowsHide: true, timeout: 15000 });
  assert.match(result.stdout, /requires explicit --run/);
  assert.match(result.stdout, /No application was started/);
});

test('qualification tracks owned identities, rejects links and requires confirmed cleanup', async () => {
  const source = await readFile(path, 'utf8');
  assert.match(source, /timeout = 600000/);
  assert.match(source, /DSH_COMMUNITY_EXERCISE_RECOVERY: '1'/);
  assert.match(source, /productionProbationMs: 45000/);
  assert.match(source, /CreationDate\.ToUniversalTime\(\)\.Ticks/);
  assert.match(source, /QA PID was reused/);
  assert.match(source, /for \(const record of records\.values\(\)\) await marker\(record\)/);
  assert.match(source, /stat\.isFile\(\) && !stat\.isSymbolicLink\(\)/);
  assert.match(source, /initialPid = started\.pid/);
  assert.match(source, /const selected = await selectQualificationPayload\(project\)/);
  assert.match(source, /assert\.equal\(selected\.kind, 'official-nsis-candidate'/);
  assert.match(source, /candidatePayloadSha256: selected\.payloadSha256/);
  assert.match(source, /payloadInventory\(selected\.payload\)/);
  assert.match(source, /report\.sourcePayloadUnchanged = false; report\.passed = false/);
  assert.match(source, /if \(!report\.cleanup\.passed\) \{ report\.passed = false/);
  assert.doesNotMatch(source, /(?:taskkill|Stop-Process|TerminateProcess|shell: true|recursive: true, force: true)/i);
});
