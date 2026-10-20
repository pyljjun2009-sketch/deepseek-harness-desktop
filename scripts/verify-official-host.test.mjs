import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyCommunityHostPort } from './verify-official-host.mjs';

test('sealed Host accepts the supported system-assigned port', () => {
  verifyCommunityHostPort(Buffer.from('args: ["--no-open", "--port", "0"]'));
  verifyCommunityHostPort("args:['--no-open','--port','0']");
  verifyCommunityHostPort("args:['--no-open','--host','127.0.0.1','--port','0']");
});
test('explicit listeners must remain loopback-only and cannot regress to a reserved port', () => {
  for (const host of ['0.0.0.0', '::', 'localhost', '192.168.1.1', '127.0.0.1.attacker.invalid']) {
    assert.throws(() => verifyCommunityHostPort(`args:['--no-open','--host','${host}','--port','0']`));
  }
  assert.throws(() => verifyCommunityHostPort("args:['--no-open','--host','127.0.0.1','--port','19387']"));
});
test('sealed Host refuses the upstream fixed port and invalid values', () => {
  for (const port of ['19387', '1', '-1', 'NaN', '0x0', '']) {
    assert.throws(() => verifyCommunityHostPort(`args: ["--no-open", "--port", "${port}"]`));
  }
});
test('missing and ambiguous port entries cannot pass sealing', () => {
  assert.throws(() => verifyCommunityHostPort(''));
  assert.throws(() => verifyCommunityHostPort('args: ["--no-open", "--port", "0"]; args: ["--no-open", "--port", "19387"]'));
});
