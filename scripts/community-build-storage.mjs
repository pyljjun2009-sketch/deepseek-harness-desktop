/** Closed set of owned QA namespaces. Never follow user-relocated legacy junctions. */
import { win32 } from 'node:path';
import assert from 'node:assert/strict';
import { lstat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

export const nativeStorage = Object.freeze({
  candidate: 'C:\\DSHNative\\payloads',
  installer: 'C:\\DSHNative\\installer',
  installerCopy: 'C:\\DSHNative\\installer-copies',
  recovery: 'C:\\DSHNative\\recovery',
  ui: 'C:\\DSHNative\\ui',
});
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export async function assertPhysicalAncestors(path) {
  for (let current = resolve(path); ; current = dirname(current)) {
    try { assert(!(await lstat(current)).isSymbolicLink(), 'QA path contains a link or junction'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (dirname(current) === current) break;
  }
}

export function candidateStorageRoot(payload, identity) {
  if (typeof identity !== 'string' || !uuid.test(identity)) return undefined;
  return ['C:\\DSHBP', nativeStorage.candidate]
    .find(root => payload === win32.join(root, identity, 'app'));
}

export function expectedRecoveryHome(home, identity) {
  if (typeof identity !== 'string' || !uuid.test(identity)) return false;
  return ['C:\\DSHRQ', nativeStorage.recovery]
    .some(root => home === win32.join(root, identity, 'home'));
}
