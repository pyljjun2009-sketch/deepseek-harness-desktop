/** Main-process/CLI upgrade adapter v1. Official installers are never executed here. */
'use strict';
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const { dirname, join, resolve } = require('node:path');
const { createRequire } = require('node:module');
// Resolve maintained parsers through the declared electron-updater production dependency.
const updaterRequire = createRequire(require.resolve('electron-updater/package.json'));
const yaml = updaterRequire('js-yaml');
const semver = updaterRequire('semver');

const OFFICIAL_FEED = 'https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml';
const MAX_FEED_BYTES = 32768;
const MAX_PACKAGE_BYTES = 1024 * 1024 * 1024;
class OfficialUpgradeError extends Error {
  constructor(code) { super(code); this.name = 'OfficialUpgradeError'; this.code = code; }
}
function ensure(value, code) { if (!value) throw new OfficialUpgradeError(code); }
function version(value) { ensure(typeof value === 'string' && semver.valid(value) === value, 'INVALID_VERSION'); return value; }
function localPath(value, code) {
  ensure(typeof value === 'string' && value.length > 0 && !/[\x00-\x1f\x7f]/.test(value) &&
    !/^(?:\\\\|\/\/)/.test(value) && resolve(value) === value, code);
}

/** Validate a wire/file descriptor. Only the exact official Windows x64 artifact URL is admitted. */
function validateOfficialArtifact(artifact) {
  ensure(artifact && typeof artifact === 'object' && !Array.isArray(artifact), 'INVALID_ARTIFACT');
  ensure(artifact.interfaceVersion === 1 && artifact.provider === 'deepseek-official-desktop' &&
    artifact.platform === 'win32' && artifact.arch === 'x64', 'UNSUPPORTED_UPGRADE_INTERFACE');
  const v = version(artifact.version);
  ensure(artifact.url === `https://download.deepseek.com/dsh-desk/bin/win-x64/deepseek-harness-${v}-win-x64.exe`, 'UNTRUSTED_ARTIFACT_URL');
  ensure(typeof artifact.sha512 === 'string' && /^[A-Za-z0-9+/]{86}==$/.test(artifact.sha512) &&
    Buffer.from(artifact.sha512, 'base64').length === 64 &&
    Buffer.from(artifact.sha512, 'base64').toString('base64') === artifact.sha512, 'INVALID_SHA512');
  ensure(Number.isSafeInteger(artifact.size) && artifact.size > 0 && artifact.size <= MAX_PACKAGE_BYTES, 'INVALID_ARTIFACT_SIZE');
  ensure(typeof artifact.releaseDate === 'string' && Number.isFinite(Date.parse(artifact.releaseDate)) &&
    new Date(artifact.releaseDate).toISOString() === artifact.releaseDate, 'INVALID_RELEASE_DATE');
  return { interfaceVersion: 1, provider: artifact.provider, platform: 'win32', arch: 'x64', version: v,
    url: artifact.url, sha512: artifact.sha512, size: artifact.size, releaseDate: artifact.releaseDate };
}

/** Read the official electron-updater feed without accepting scripts, duplicate YAML keys or divergent digests. */
function parseOfficialFeed(text) {
  ensure(typeof text === 'string' && Buffer.byteLength(text) <= MAX_FEED_BYTES, 'INVALID_FEED_SIZE');
  let feed;
  try { feed = yaml.load(text, { schema: yaml.JSON_SCHEMA }); }
  catch { throw new OfficialUpgradeError('INVALID_FEED_YAML'); }
  ensure(feed && typeof feed === 'object' && !Array.isArray(feed) && Array.isArray(feed.files) &&
    feed.files.length === 1 && feed.files[0] && typeof feed.files[0] === 'object', 'INVALID_FEED_FIELDS');
  const entry = feed.files[0];
  ensure(feed.path === entry.url && feed.sha512 === entry.sha512, 'AMBIGUOUS_FEED_ARTIFACT');
  return validateOfficialArtifact({ interfaceVersion: 1, provider: 'deepseek-official-desktop',
    platform: 'win32', arch: 'x64', version: feed.version, url: entry.url,
    sha512: entry.sha512, size: entry.size, releaseDate: feed.releaseDate });
}

async function physicalAncestors(path) {
  for (let current = resolve(path); ; current = dirname(current)) {
    const stat = await fs.lstat(current);
    ensure(!stat.isSymbolicLink(), 'LINKED_CACHE_PATH');
    if (dirname(current) === current) break;
  }
}
/** Read-only byte verification, including physical-file and size checks; no installer launch or account access. */
async function verifyOfficialPackage(file, descriptor) {
  const artifact = validateOfficialArtifact(descriptor);
  localPath(file, 'NONCANONICAL_PACKAGE_PATH');
  await physicalAncestors(file);
  const stat = await fs.lstat(file);
  ensure(stat.isFile() && stat.size === artifact.size, 'PACKAGE_SIZE_MISMATCH');
  const digest = createHash('sha512');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  ensure(digest.digest('base64') === artifact.sha512, 'PACKAGE_SHA512_MISMATCH');
  return { verified: true, version: artifact.version, size: artifact.size, sha512: artifact.sha512,
    installerExecuted: false, codeSignatureVerified: false };
}

/** A versioned, non-installing plan for the existing source-build and community qualification pipeline. */
function planOfficialUpgrade(descriptor, baselineVersion) {
  const artifact = validateOfficialArtifact(descriptor);
  version(baselineVersion);
  ensure(!semver.lt(artifact.version, baselineVersion), 'OFFICIAL_DOWNGRADE_REFUSED');
  return { interfaceVersion: 1, operation: 'prepare-community-rebuild', artifact,
    baselineVersion, prerelease: semver.prerelease(artifact.version) !== null,
    requiresMatchingOfficialSource: true, requiresCompleteRuntime: true,
    requiredQualifications: ['sealed-payload', 'isolated-install', 'real-crash-recovery', 'native-manual-acceptance'],
    automaticInstallAllowed: false, userDataMigrationAllowed: false,
    reason: 'Official app identity cannot overwrite the community recovery app identity.' };
}

/** Owns explicit checks and verified cache downloads; fetch is injectable only for in-process tests/adapters. */
function createOfficialUpgradeProvider({ fetch: request = globalThis.fetch } = {}) {
  ensure(typeof request === 'function', 'FETCH_UNAVAILABLE');
  async function response(url, timeout) {
    let result;
    try { result = await request(url, { redirect: 'error', signal: AbortSignal.timeout(timeout),
      headers: { Accept: url === OFFICIAL_FEED ? 'text/yaml, text/plain' : 'application/octet-stream' } }); }
    catch { throw new OfficialUpgradeError('OFFICIAL_TRANSPORT_FAILED'); }
    if (result.status !== 200 || result.redirected || (result.url && result.url !== url)) {
      await result.body?.cancel();
      throw new OfficialUpgradeError('OFFICIAL_RESPONSE_REJECTED');
    }
    ensure(result.body && typeof result.body[Symbol.asyncIterator] === 'function', 'MISSING_RESPONSE_BODY');
    return result;
  }
  return Object.freeze({
    interfaceVersion: 1, id: 'deepseek-official-desktop',
    capabilities: Object.freeze(['check', 'download', 'verify', 'prepare']),
    async check({ baselineVersion, allowPrerelease = false }) {
      version(baselineVersion);
      ensure(typeof allowPrerelease === 'boolean', 'INVALID_PREVIEW_POLICY');
      const result = await response(OFFICIAL_FEED, 30000);
      let size = 0; const chunks = [];
      try {
        for await (const chunk of result.body) {
          const bytes = Buffer.from(chunk); size += bytes.length;
          ensure(size <= MAX_FEED_BYTES, 'INVALID_FEED_SIZE'); chunks.push(bytes);
        }
      } catch (error) { if (error instanceof OfficialUpgradeError) throw error; throw new OfficialUpgradeError('OFFICIAL_TRANSPORT_FAILED'); }
      const artifact = parseOfficialFeed(Buffer.concat(chunks).toString('utf8'));
      const newer = semver.gt(artifact.version, baselineVersion);
      const preview = semver.prerelease(artifact.version) !== null;
      return { interfaceVersion: 1, artifact, newer, preview, policyAllowed: !preview || allowPrerelease,
        automaticInstallAllowed: false, installed: false };
    },
    async download(descriptor, cacheDirectory) {
      const artifact = validateOfficialArtifact(descriptor);
      localPath(cacheDirectory, 'NONCANONICAL_CACHE_PATH');
      // Validate existing ancestors before mkdir, then reject links again after it.
      let parent = cacheDirectory;
      for (;;) {
        try { await physicalAncestors(parent); break; }
        catch (error) { if (error.code !== 'ENOENT') throw error; parent = dirname(parent); }
      }
      await fs.mkdir(cacheDirectory, { recursive: true });
      await physicalAncestors(cacheDirectory);
      ensure((await fs.lstat(cacheDirectory)).isDirectory(), 'INVALID_CACHE_DIRECTORY');
      const key = Buffer.from(artifact.sha512, 'base64').toString('hex');
      const file = join(cacheDirectory, `${key}.exe`);
      try {
        await fs.lstat(file); await verifyOfficialPackage(file, artifact);
        return { ...artifact, file, cached: true, installerExecuted: false };
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const temporary = join(cacheDirectory, `${randomUUID()}.download`);
      const handle = await fs.open(temporary, 'wx', 0o600);
      let closed = false;
      try {
        const result = await response(artifact.url, 600000);
        const hash = createHash('sha512'); let bytes = 0;
        for await (const chunk of result.body) {
          const body = Buffer.from(chunk); bytes += body.length;
          ensure(bytes <= artifact.size, 'PACKAGE_SIZE_MISMATCH');
          hash.update(body);
          let offset = 0;
          while (offset < body.length) {
            const written = await handle.write(body, offset, body.length - offset);
            ensure(written.bytesWritten > 0, 'CACHE_WRITE_FAILED'); offset += written.bytesWritten;
          }
        }
        ensure(bytes === artifact.size, 'PACKAGE_SIZE_MISMATCH');
        ensure(hash.digest('base64') === artifact.sha512, 'PACKAGE_SHA512_MISMATCH');
        await handle.sync(); await handle.close(); closed = true;
        // Exclusive publication never overwrites a cache file that appeared concurrently.
        await fs.link(temporary, file);
        await verifyOfficialPackage(file, artifact);
        return { ...artifact, file, cached: false, installerExecuted: false };
      } catch (error) {
        if (error instanceof OfficialUpgradeError) throw error;
        throw new OfficialUpgradeError('OFFICIAL_DOWNLOAD_FAILED');
      } finally {
        if (!closed) await handle.close();
        await fs.unlink(temporary);
      }
    },
    verify: verifyOfficialPackage,
    prepare: planOfficialUpgrade,
  });
}

module.exports = { OFFICIAL_FEED, OfficialUpgradeError, createOfficialUpgradeProvider,
  validateOfficialArtifact, parseOfficialFeed, verifyOfficialPackage, planOfficialUpgrade };
