import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, lstat, open, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const cdnHost = 'release-assets.githubusercontent.com';
const curl = process.platform === 'win32' ? 'curl.exe' : 'curl';
const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';

class TransportFailure extends Error {
  constructor(phase, code) {
    // execFile errors contain cmd/args and may therefore expose the signed CDN URL.
    const status = typeof code === 'number' && Number.isInteger(code) ? ` (curl code ${code})` : '';
    super(`${phase} transport failed${status}`);
    this.name = 'TransportFailure';
  }
}

function githubReleaseAsset(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Expected a GitHub release asset URL'); }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash) {
    throw new Error('Expected an unauthenticated HTTPS GitHub release asset URL');
  }
  const match = /^\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9_.-]{1,100})\/releases\/download\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  if (!match || ['.', '..'].includes(match[2])) throw new Error('Invalid GitHub release asset path');
  let tag; let name;
  try { tag = decodeURIComponent(match[3]); name = decodeURIComponent(match[4]); }
  catch { throw new Error('Invalid GitHub release asset encoding'); }
  if (!tag || tag.length > 200 || /[\\\x00-\x1f\x7f]/.test(tag) || ['.', '..'].includes(tag) ||
      !name || name.length > 255 || /[\/\\\x00-\x1f\x7f]/.test(name) || ['.', '..'].includes(name)) {
    throw new Error('Invalid GitHub release tag or asset name');
  }
  return { owner: match[1], repository: match[2], tag, name };
}

async function fileMatches(file, expectedSha256, bytes) {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (bytes !== undefined && stat.size !== bytes)) return false;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest('hex') === expectedSha256;
  } catch { return false; }
}

function matchingAsset(metadata, expected, expectedSha256, bytes) {
  if (metadata?.tag_name !== expected.tag || !Array.isArray(metadata.assets)) throw new Error('GitHub release metadata does not match the requested tag');
  const candidates = metadata.assets.filter(asset => asset?.name === expected.name);
  if (candidates.length !== 1) throw new Error('Expected exactly one matching GitHub release asset');
  const asset = candidates[0];
  if (!Number.isSafeInteger(asset.id) || asset.id <= 0 || !Number.isSafeInteger(asset.size) || asset.size <= 0 ||
      (bytes !== undefined && asset.size !== bytes)) throw new Error('GitHub asset metadata does not match the expected size');
  // Old releases may have no API digest; the caller's pinned SHA-256 is always mandatory.
  if (asset.digest !== undefined && asset.digest !== null && asset.digest !== `sha256:${expectedSha256}`) {
    throw new Error('GitHub asset metadata does not match the pinned SHA-256');
  }
  const original = githubReleaseAsset(asset.browser_download_url);
  if (original.owner.toLowerCase() !== expected.owner.toLowerCase() || original.repository.toLowerCase() !== expected.repository.toLowerCase() ||
      original.tag !== expected.tag || original.name !== expected.name) throw new Error('GitHub asset metadata does not match the requested repository');
  let api;
  try { api = new URL(asset.url); } catch { throw new Error('Invalid GitHub asset API URL'); }
  const expectedPath = `/repos/${expected.owner}/${expected.repository}/releases/assets/${asset.id}`;
  if (api.protocol !== 'https:' || api.hostname !== 'api.github.com' || api.port || api.username || api.password || api.search || api.hash ||
      api.pathname.toLowerCase() !== expectedPath.toLowerCase()) throw new Error('Invalid GitHub asset API identity');
  return asset;
}

function signedRedirect(headers) {
  const statuses = [...headers.matchAll(/^HTTP\/\S+\s+(\d{3})\b/gim)];
  const locations = [...headers.matchAll(/^location:\s*([^\r\n]+)$/gim)];
  const status = Number(statuses.at(-1)?.[1]);
  if (![302, 303, 307].includes(status) || locations.length !== 1) throw new Error('GitHub asset API did not return one binary redirect');
  let target;
  try { target = new URL(locations[0][1].trim()); } catch { throw new Error('Invalid GitHub asset CDN redirect'); }
  if (target.protocol !== 'https:' || target.hostname !== cdnHost || target.port || target.username || target.password || target.hash ||
      target.href.length > 16384) throw new Error('GitHub asset redirect is outside the allowed HTTPS CDN');
  return target.href;
}

/** A callback-compatible execFile seam makes transport tests fully offline. */
export function createGithubAssetDownloader(transport = execFile) {
  if (typeof transport !== 'function') throw new Error('Expected an execFile transport');
  const run = (args, phase, maximumSeconds) => new Promise((accept, reject) => {
    const options = { windowsHide: true, shell: false, timeout: (maximumSeconds + 5) * 1000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' };
    const callback = (error, stdout) => {
      if (error) reject(new TransportFailure(phase, error.code));
      else accept(typeof stdout === 'string' ? stdout : String(stdout ?? ''));
    };
    try { transport(curl, args, options, callback); }
    catch (error) { reject(new TransportFailure(phase, error?.code)); }
  });
  const argumentsFor = maximumSeconds => [
    '--disable', '--silent', '--show-error', '--fail', '--http1.1', '--proto', '=https',
    '--connect-timeout', '10', '--max-time', String(maximumSeconds)
  ];
  const apiHeaders = accept => ['--header', `Accept: ${accept}`, '--header', 'X-GitHub-Api-Version: 2022-11-28',
    '--header', 'User-Agent: DeepSeek-Harness-Community-Build'];

  return async function downloadGithubAsset(url, destination, expectedSha256, bytes) {
    const expected = githubReleaseAsset(url);
    if (typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(expectedSha256)) throw new Error('A pinned SHA-256 is required');
    expectedSha256 = expectedSha256.toLowerCase();
    if (bytes !== undefined && (!Number.isSafeInteger(bytes) || bytes <= 0)) throw new Error('Expected a positive asset byte count');
    if (typeof destination !== 'string' || !destination || /[\x00\r\n]/.test(destination)) throw new Error('Expected a download destination');
    const target = resolve(destination);
    if (await fileMatches(target, expectedSha256, bytes)) return target;
    try {
      const existing = await lstat(target);
      if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('Download destination must not be a directory or symbolic link');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await mkdir(dirname(target), { recursive: true });
    let lastFailure;
    for (let attempt = 0; attempt < 2; attempt++) {
      const temporary = `${target}.${randomUUID()}.download`;
      try {
        // API-first avoids waiting for an unreachable github.com binary endpoint.
        const metadataUrl = `https://api.github.com/repos/${expected.owner}/${expected.repository}/releases/tags/${encodeURIComponent(expected.tag)}?dsh_transport=${randomUUID()}`;
        const body = await run([...argumentsFor(30), ...apiHeaders('application/vnd.github+json'), '--url', metadataUrl], 'GitHub release metadata', 30);
        let metadata;
        try { metadata = JSON.parse(body); } catch { throw new Error('Invalid GitHub release JSON metadata'); }
        const asset = matchingAsset(metadata, expected, expectedSha256, bytes);
        const assetUrl = `${asset.url}?dsh_transport=${randomUUID()}`;
        const headers = await run([...argumentsFor(30), ...apiHeaders('application/octet-stream'), '--dump-header', '-',
          '--output', nullDevice, '--url', assetUrl], 'GitHub binary redirect', 30);
        const location = signedRedirect(headers);
        // Do not follow further redirects: each network hop must remain on the explicit allowlist.
        await run([...argumentsFor(120), '--speed-limit', '1000', '--speed-time', '15', '--max-filesize', String(asset.size),
          '--output', temporary, '--url', location], 'GitHub asset CDN', 120);
        if (!await fileMatches(temporary, expectedSha256, asset.size)) throw new Error('Downloaded GitHub asset failed pinned SHA-256 or size verification');
        const descriptor = await open(temporary, 'r+');
        try { await descriptor.sync(); } finally { await descriptor.close(); }
        await rename(temporary, target);
        return target;
      } catch (error) {
        if (!(error instanceof TransportFailure)) throw error;
        lastFailure = error;
      } finally {
        // Only this attempt's nonce-named file is removed, never an existing cache or directory.
        await rm(temporary, { force: true });
      }
    }
    throw lastFailure;
  };
}

export const downloadGithubAsset = createGithubAssetDownloader();

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [url, destination, expectedSha256, byteArgument] = process.argv.slice(2);
  try {
    await downloadGithubAsset(url, destination, expectedSha256, byteArgument === undefined ? undefined : Number(byteArgument));
    console.log('GitHub asset cached and verified against the pinned SHA-256.');
  } catch (error) {
    console.error(`GitHub asset download failed: ${error instanceof Error ? error.message : 'Unknown failure'}`);
    process.exitCode = 1;
  }
}
