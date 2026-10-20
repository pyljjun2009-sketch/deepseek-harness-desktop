import assert from 'node:assert/strict';

/** Fail closed if the sealed Host silently regresses to the upstream fixed TCP port. */
export function verifyCommunityHostPort(contents) {
  const source = Buffer.isBuffer(contents) ? contents.toString('utf8') : contents;
  assert.equal(typeof source, 'string');
  const matches = [...source.matchAll(/args:\s*\[\s*["']--no-open["']\s*,\s*(?:["']--host["']\s*,\s*["'](?<host>[^"']+)["']\s*,\s*)?["']--port["']\s*,\s*["'](?<port>[^"']+)["']\s*\]/g)];
  assert.equal(matches.length, 1, 'The Host default port entry is missing or ambiguous');
  assert(matches[0].groups.host === undefined || matches[0].groups.host === '127.0.0.1', 'The Host must bind only its loopback address');
  assert.equal(matches[0].groups.port, '0', 'The Host must let the OS allocate its loopback port');
}
