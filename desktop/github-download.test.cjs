const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

const modulePromise = import('../scripts/download-github-asset.mjs');
const browserUrl = 'https://github.com/astral-sh/python-build-standalone/releases/download/20260901/cpython-3.12.14%2B20260901-x86_64-pc-windows-msvc-install_only_stripped.tar.gz';
const payload = Buffer.from('offline test asset, not a real Python archive');
const sha256 = createHash('sha256').update(payload).digest('hex');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-github-download-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, destination: path.join(root, 'cache', sha256) };
}

function releaseMetadata() {
  return {
    tag_name: '20260901',
    assets: [{
      id: 539916141,
      name: 'cpython-3.12.14+20260901-x86_64-pc-windows-msvc-install_only_stripped.tar.gz',
      size: payload.length,
      digest: `sha256:${sha256}`,
      url: 'https://api.github.com/repos/astral-sh/python-build-standalone/releases/assets/539916141',
      browser_download_url: browserUrl
    }]
  };
}

function mockedExecFile(options = {}) {
  const calls = [];
  let downloads = 0;
  const transport = (command, args, executionOptions, callback) => {
    calls.push({ command, args, executionOptions });
    queueMicrotask(() => {
      try {
        const request = args[args.indexOf('--url') + 1];
        if (request.includes('/releases/tags/')) {
          if (options.metadataFailure) throw options.metadataFailure;
          const metadata = releaseMetadata();
          options.metadata?.(metadata);
          callback(null, JSON.stringify(metadata), '');
        } else if (request.includes('/releases/assets/')) {
          const location = options.location ?? 'https://release-assets.githubusercontent.com/github-production-release-asset/test?jwt=PRIVATE_SIGNED_TEST_TOKEN';
          callback(null, options.headers ?? `HTTP/1.1 200 Connection established\r\n\r\nHTTP/1.1 302 Found\r\nLocation: ${location}\r\n\r\n`, '');
        } else {
          downloads++;
          options.beforeDownload?.(args, downloads);
          if (options.downloadFailure && downloads <= (options.failedAttempts ?? Infinity)) throw options.downloadFailure;
          const output = args[args.indexOf('--output') + 1];
          fs.writeFileSync(output, options.payload ?? payload);
          callback(null, '', '');
        }
      } catch (error) { callback(error, '', error.message); }
    });
  };
  return { transport, calls };
}

test('API-first downloader verifies repo, encoded asset, fixed size and SHA-256 without visiting github.com', async t => {
  const f = fixture(t); const mock = mockedExecFile();
  const { createGithubAssetDownloader } = await modulePromise;
  const result = await createGithubAssetDownloader(mock.transport)(browserUrl, f.destination, sha256, payload.length);
  assert.equal(result, f.destination);
  assert.deepEqual(fs.readFileSync(result), payload);
  assert.equal(mock.calls.length, 3);
  assert.match(mock.calls[0].args[mock.calls[0].args.indexOf('--url') + 1], /^https:\/\/api\.github\.com\/repos\/astral-sh\/python-build-standalone\/releases\/tags\/20260901\?dsh_transport=/);
  assert.ok(mock.calls[1].args.includes('Accept: application/octet-stream'));
  for (const call of mock.calls) {
    assert.equal(call.executionOptions.shell, false);
    assert.equal(call.executionOptions.windowsHide, true);
    assert.ok(call.executionOptions.timeout <= 125000);
    assert.equal(call.args[0], '--disable');
    assert.equal(call.args.includes('--location'), false);
    assert.equal(call.args.includes(browserUrl), false);
    assert.equal(call.args[call.args.indexOf('--proto') + 1], '=https');
    assert.equal(call.args[call.args.indexOf('--connect-timeout') + 1], '10');
  }
});

test('already verified cache is reused without any transport calls', async t => {
  const f = fixture(t); fs.mkdirSync(path.dirname(f.destination)); fs.writeFileSync(f.destination, payload);
  const mock = mockedExecFile(); const { createGithubAssetDownloader } = await modulePromise;
  assert.equal(await createGithubAssetDownloader(mock.transport)(browserUrl, f.destination, sha256, payload.length), f.destination);
  assert.equal(mock.calls.length, 0);
});

test('old invalid cache remains untouched until a verified replacement is committed', async t => {
  const f = fixture(t); fs.mkdirSync(path.dirname(f.destination)); fs.writeFileSync(f.destination, 'previous cache');
  const mock = mockedExecFile({ beforeDownload(args) {
    assert.equal(fs.readFileSync(f.destination, 'utf8'), 'previous cache');
    assert.notEqual(args[args.indexOf('--output') + 1], f.destination);
  } });
  const { createGithubAssetDownloader } = await modulePromise;
  await createGithubAssetDownloader(mock.transport)(browserUrl, f.destination, sha256);
  assert.deepEqual(fs.readFileSync(f.destination), payload);
  assert.deepEqual(fs.readdirSync(path.dirname(f.destination)), [sha256]);
});

test('hash mismatch cannot overwrite a prior cache and removes only its own temporary file', async t => {
  const f = fixture(t); fs.mkdirSync(path.dirname(f.destination)); fs.writeFileSync(f.destination, 'keep this cache');
  fs.writeFileSync(path.join(path.dirname(f.destination), 'unrelated.file'), 'keep this too');
  const corrupt = Buffer.from(payload); corrupt[0] ^= 1;
  const mock = mockedExecFile({ payload: corrupt }); const { createGithubAssetDownloader } = await modulePromise;
  await assert.rejects(createGithubAssetDownloader(mock.transport)(browserUrl, f.destination, sha256, payload.length), /failed pinned SHA-256 or size/);
  assert.equal(fs.readFileSync(f.destination, 'utf8'), 'keep this cache');
  assert.deepEqual(fs.readdirSync(path.dirname(f.destination)).sort(), [sha256, 'unrelated.file'].sort());
  assert.equal(mock.calls.length, 3);
});

test('older API metadata without a digest still requires final pinned SHA-256 verification', async t => {
  const f = fixture(t); const mock = mockedExecFile({ metadata(value) { value.assets[0].digest = null; } });
  const { createGithubAssetDownloader } = await modulePromise;
  await createGithubAssetDownloader(mock.transport)(browserUrl, f.destination, sha256.toUpperCase());
  assert.deepEqual(fs.readFileSync(f.destination), payload);
});

const invalidMetadata = [
  ['wrong tag', value => { value.tag_name = 'another-tag'; }],
  ['duplicate name', value => { value.assets.push({ ...value.assets[0] }); }],
  ['missing name', value => { value.assets[0].name = 'another-file.tar.gz'; }],
  ['wrong repository', value => { value.assets[0].browser_download_url = browserUrl.replace('astral-sh/', 'attacker/'); }],
  ['wrong API asset id', value => { value.assets[0].url = value.assets[0].url.replace('539916141', '539916142'); }],
  ['untrusted API host', value => { value.assets[0].url = value.assets[0].url.replace('api.github.com', 'api.github.com.invalid'); }],
  ['API URL credentials', value => { value.assets[0].url = value.assets[0].url.replace('https://', 'https://secret@'); }],
  ['wrong digest', value => { value.assets[0].digest = `sha256:${'0'.repeat(64)}`; }],
  ['wrong size', value => { value.assets[0].size++; }],
  ['invalid id', value => { value.assets[0].id = -1; }]
];
for (const [name, mutate] of invalidMetadata) {
  test(`reject inconsistent official API metadata before CDN access: ${name}`, async t => {
    const f = fixture(t); const mock = mockedExecFile({ metadata: mutate });
    const { createGithubAssetDownloader } = await modulePromise;
    await assert.rejects(createGithubAssetDownloader(mock.transport)(browserUrl, f.destination, sha256, payload.length));
    assert.equal(mock.calls.length, 1);
    assert.equal(fs.existsSync(f.destination), false);
  });
}

for (const [name, location] of [
  ['HTTP', 'http://release-assets.githubusercontent.com/file'],
  ['untrusted host', 'https://github.com.invalid/file'],
  ['untrusted port', 'https://release-assets.githubusercontent.com:8443/file'],
  ['credentials', 'https://credential@release-assets.githubusercontent.com/file'],
  ['fragment', 'https://release-assets.githubusercontent.com/file#secret']
]) {
  test(`reject CDN redirects outside the exact allowlist: ${name}`, async t => {
    const f = fixture(t); const mock = mockedExecFile({ location }); const { createGithubAssetDownloader } = await modulePromise;
    await assert.rejects(createGithubAssetDownloader(mock.transport)(browserUrl, f.destination, sha256), /outside the allowed HTTPS CDN/);
    assert.equal(mock.calls.length, 2);
    assert.equal(fs.existsSync(f.destination), false);
  });
}

test('API response must contain exactly one binary redirect', async t => {
  const f = fixture(t); const mock = mockedExecFile({ headers: 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n' });
  const { createGithubAssetDownloader } = await modulePromise;
  await assert.rejects(createGithubAssetDownloader(mock.transport)(browserUrl, f.destination, sha256), /one binary redirect/);
  assert.equal(mock.calls.length, 2);
});

test('transport failure is bounded to two attempts and never retains signed URL, stderr, cmd or cause', async t => {
  const f = fixture(t);
  const error = new Error('curl.exe https://release-assets.githubusercontent.com/file?jwt=PRIVATE_SIGNED_TEST_TOKEN');
  error.code = 28; error.cmd = error.message; error.stderr = error.message;
  const mock = mockedExecFile({ downloadFailure: error }); const { createGithubAssetDownloader } = await modulePromise;
  let captured;
  await assert.rejects(createGithubAssetDownloader(mock.transport)(browserUrl, f.destination, sha256), value => { captured = value; return true; });
  assert.equal(mock.calls.length, 6);
  assert.equal(captured.message, 'GitHub asset CDN transport failed (curl code 28)');
  assert.equal(captured.stack.includes('PRIVATE_SIGNED_TEST_TOKEN'), false);
  assert.equal(Object.hasOwn(captured, 'cmd'), false);
  assert.equal(Object.hasOwn(captured, 'stderr'), false);
  assert.equal(Object.hasOwn(captured, 'cause'), false);
  assert.deepEqual(fs.readdirSync(path.dirname(f.destination)), []);
});

test('one transient CDN failure retries through a fresh API lookup and then verifies the file', async t => {
  const f = fixture(t); const failure = new Error('private transport details'); failure.code = 28;
  const mock = mockedExecFile({ downloadFailure: failure, failedAttempts: 1 }); const { createGithubAssetDownloader } = await modulePromise;
  await createGithubAssetDownloader(mock.transport)(browserUrl, f.destination, sha256, payload.length);
  assert.equal(mock.calls.length, 6);
  assert.notEqual(mock.calls[0].args.at(-1), mock.calls[3].args.at(-1));
  assert.notEqual(mock.calls[1].args.at(-1), mock.calls[4].args.at(-1));
  assert.deepEqual(fs.readFileSync(f.destination), payload);
});

test('reject malformed input before making any network request', async t => {
  const f = fixture(t); const mock = mockedExecFile(); const { createGithubAssetDownloader } = await modulePromise;
  const download = createGithubAssetDownloader(mock.transport);
  for (const url of [
    browserUrl.replace('https:', 'http:'), browserUrl.replace('github.com', 'github.com.invalid'),
    browserUrl.replace('https://', 'https://credential@'), `${browserUrl}?unexpected=1`, `${browserUrl}#fragment`,
    browserUrl.replace('20260901', '%0A'), browserUrl.replace('cpython-', 'nested%2Fcpython-')
  ]) await assert.rejects(download(url, f.destination, sha256));
  await assert.rejects(download(browserUrl, f.destination, 'unpinned'));
  await assert.rejects(download(browserUrl, f.destination, sha256, -1));
  await assert.rejects(download(browserUrl, f.destination, sha256, NaN));
  assert.equal(mock.calls.length, 0);
  assert.equal(fs.existsSync(path.dirname(f.destination)), false);
});

test('destination symlink or directory is refused before transport', async t => {
  const f = fixture(t); const mock = mockedExecFile(); const { createGithubAssetDownloader } = await modulePromise;
  const existing = path.join(f.root, 'existing'); fs.mkdirSync(existing);
  const linked = path.join(f.root, 'linked'); fs.symlinkSync(existing, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const download = createGithubAssetDownloader(mock.transport);
  await assert.rejects(download(browserUrl, existing, sha256), /directory or symbolic link/);
  await assert.rejects(download(browserUrl, linked, sha256), /directory or symbolic link/);
  assert.equal(mock.calls.length, 0);
});

test('synchronously thrown execFile failures are also redacted and bounded', async t => {
  const f = fixture(t); const { createGithubAssetDownloader } = await modulePromise; let calls = 0;
  const transport = () => { calls++; throw new Error('PRIVATE_SIGNED_TEST_TOKEN'); };
  await assert.rejects(createGithubAssetDownloader(transport)(browserUrl, f.destination, sha256), error =>
    error.message === 'GitHub release metadata transport failed' && !error.stack.includes('PRIVATE_SIGNED_TEST_TOKEN'));
  assert.equal(calls, 2);
});
