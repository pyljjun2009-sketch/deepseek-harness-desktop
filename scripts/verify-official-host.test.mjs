import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyCommunityHostPort } from './verify-official-host.mjs';

test('sealed Host accepts the supported system-assigned port', () => {
  verifyCommunityHostPort(Buffer.from('args: ["--no-open", "--port", "0"]'));
  verifyCommunityHostPort("args:['--no-open','--port','0']");
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
