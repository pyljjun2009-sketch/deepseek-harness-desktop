const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { once } = require('node:events');

test('scheme registration acknowledgement is local and absent for an ordinary official launch', async () => {
  const { communitySchemeRegistered } = await import('./community-adapter.ts');
  assert.equal(communitySchemeRegistered(), false);
  const acknowledge = resolve => resolve();
  process.on('community:scheme-registered', acknowledge);
  try { assert.equal(communitySchemeRegistered(), true); }
  finally { process.removeListener('community:scheme-registered', acknowledge); }
  assert.equal(communitySchemeRegistered(), false);
});

test('authenticated local RPC health probe validates envelope without model calls', async () => {
  const { communityHealthProbe } = await import('./community-adapter.ts');
  let requests = 0;
  const server = createServer(async (req, res) => {
    requests++;
    assert.equal(req.url, '/api/productAnalytics/enabled');
    assert.equal(req.headers.cookie, 'test=private');
    let body = '';
    for await (const part of req) body += part;
    const request = JSON.parse(body);
    assert.equal(request.method, 'productAnalytics/enabled');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: false } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const probe = communityHealthProbe(`http://127.0.0.1:${server.address().port}/?auth=private`, 'test=private');
    assert.equal(await probe(), true);
    assert.equal(requests, 1);
    assert.equal(await communityHealthProbe('https://example.com', 'test=private')(), false);
    assert.equal(await communityHealthProbe(`http://127.0.0.1:${server.address().port}`, 'test=x\r\nHost: bad')(), false);
    assert.equal(requests, 1);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('HTTP error and malformed RPC must fail probation', async () => {
  const { communityHealthProbe } = await import('./community-adapter.ts');
  let status = 500;
  const server = createServer((req, res) => { req.resume(); res.statusCode = status; res.end('{"type":"server-response"}'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const probe = communityHealthProbe(`http://127.0.0.1:${server.address().port}`, 'test=x');
    assert.equal(await probe(), false);
    status = 200; assert.equal(await probe(), false);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('an unresponsive local Host has a bounded health timeout', async () => {
  const { communityHealthProbe } = await import('./community-adapter.ts');
  const server = createServer(req => req.resume());
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const start = Date.now();
  try {
    assert.equal(await communityHealthProbe(`http://127.0.0.1:${server.address().port}`, 'test=x')(), false);
    assert.ok(Date.now() - start < 5000);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
