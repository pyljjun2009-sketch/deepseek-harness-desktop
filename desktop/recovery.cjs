// Recovery snapshots are physical installations: Electron's patched fs treats
// app.asar as a virtual directory instead of preserving the archive's bytes.
const fs = process.versions.electron ? require('original-fs') : require('node:fs');
const { cp, mkdir, rename, readdir, lstat, rm } = fs.promises;
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');

const manifestName = '.dsh-recovery-manifest.json';
const sha256IsValid = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

const releaseIsValid = value => value === undefined ||
  (value !== null && safeId(value.version) && safeId(value.home) &&
    (value.manifestSha256 === undefined || sha256IsValid(value.manifestSha256)));

function safeId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(value) && !value.includes('..');
}

function readState(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value.schemaVersion === 1 && safeId(value.active) && safeId(value.home) &&
        Number.isInteger(value.failures) && value.failures >= 0 &&
        releaseIsValid(value.stable) && releaseIsValid(value.previousStable) &&
        (value.rejected === undefined || safeId(value.rejected))) return value;
  } catch { /* Missing or interrupted metadata is not a usable backup. */ }
  return undefined;
}

function atomicWrite(file, contents) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, contents);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function regularDirectory(file) {
  try { const stat = fs.lstatSync(file); return stat.isDirectory() && !stat.isSymbolicLink(); }
  catch { return false; }
}

function manifestPathIsValid(value) {
  return typeof value === 'string' && value.length > 0 && !/[\\:\0]/.test(value) &&
    value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

function readManifest(directory, version, expectedDigest) {
  try {
    if (!regularDirectory(directory) || !regularDirectory(path.dirname(directory))) return undefined;
    const file = path.join(directory, manifestName);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024) return undefined;
    const contents = fs.readFileSync(file);
    const digest = createHash('sha256').update(contents).digest('hex');
    if (expectedDigest !== undefined && digest !== expectedDigest) return undefined;
    const value = JSON.parse(contents.toString('utf8'));
    if (value.schemaVersion !== 1 || value.version !== version || !Array.isArray(value.entries)) return undefined;
    const entries = new Map();
    for (const entry of value.entries) {
      if (!manifestPathIsValid(entry.path) || entry.path === manifestName || entries.has(entry.path) ||
          !['file', 'directory'].includes(entry.type)) return undefined;
      if (entry.type === 'file' && (!Number.isSafeInteger(entry.size) || entry.size < 0 || !sha256IsValid(entry.sha256))) return undefined;
      entries.set(entry.path, entry);
    }
    if (entries.get('DeepSeekHarness.exe')?.type !== 'file') return undefined;
    return { entries, digest };
  } catch { return undefined; }
}

function digestFileSync(file) {
  const descriptor = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(128 * 1024);
  const hash = createHash('sha256');
  try {
    let count;
    while ((count = fs.readSync(descriptor, buffer, 0, buffer.length, null)) !== 0) hash.update(buffer.subarray(0, count));
    return hash.digest('hex');
  } finally { fs.closeSync(descriptor); }
}

/** Compare the entire installation closure, not merely the presence of its entry executable. */
function verifySnapshotSync(directory, version, expectedDigest) {
  const manifest = readManifest(directory, version, expectedDigest);
  if (!manifest) return undefined;
  let count = 0;
  const visit = (current, prefix = '') => {
    for (const name of fs.readdirSync(current)) {
      if (prefix === '' && name === manifestName) continue;
      const relative = prefix === '' ? name : `${prefix}/${name}`;
      const entry = manifest.entries.get(relative);
      const file = path.join(current, name);
      const stat = fs.lstatSync(file);
      if (!entry || stat.isSymbolicLink()) return false;
      count++;
      if (stat.isDirectory()) {
        if (entry.type !== 'directory' || !visit(file, relative)) return false;
      } else if (!stat.isFile() || entry.type !== 'file' || stat.size !== entry.size || digestFileSync(file) !== entry.sha256) return false;
    }
    return true;
  };
  try { return visit(directory) && count === manifest.entries.size ? manifest.digest : undefined; }
  catch { return undefined; }
}

async function snapshotEntries(directory) {
  const entries = [];
  const visit = async (current, prefix = '') => {
    for (const name of (await readdir(current)).sort()) {
      if (prefix === '' && name === manifestName) continue;
      const relative = prefix === '' ? name : `${prefix}/${name}`;
      if (!manifestPathIsValid(relative)) throw new Error('Unsafe stable snapshot path');
      const file = path.join(current, name);
      const before = await lstat(file);
      if (before.isSymbolicLink()) throw new Error('Stable snapshot must not contain symbolic links');
      if (before.isDirectory()) {
        entries.push({ path: relative, type: 'directory' });
        await visit(file, relative);
      } else if (before.isFile()) {
        const hash = createHash('sha256');
        for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
        const after = await lstat(file);
        if (!after.isFile() || after.isSymbolicLink() || before.size !== after.size ||
            before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) throw new Error('Stable snapshot changed while being verified');
        entries.push({ path: relative, type: 'file', size: after.size, sha256: hash.digest('hex') });
      } else throw new Error('Stable snapshot contains an unsupported file');
    }
  };
  await visit(directory);
  if (!entries.some(entry => entry.path === 'DeepSeekHarness.exe' && entry.type === 'file')) throw new Error('Stable snapshot executable missing');
  return entries;
}

async function verifySnapshot(directory, version, expectedDigest) {
  const manifest = readManifest(directory, version, expectedDigest);
  if (!manifest) return undefined;
  try {
    const actual = await snapshotEntries(directory);
    if (actual.length !== manifest.entries.size) return undefined;
    for (const entry of actual) {
      const expected = manifest.entries.get(entry.path);
      if (!expected || entry.type !== expected.type || (entry.type === 'file' &&
          (entry.size !== expected.size || entry.sha256 !== expected.sha256))) return undefined;
    }
    return manifest.digest;
  } catch { return undefined; }
}

/** Release and home are selected together, so downgraded code never reads a newer data slot. */
class DesktopRecovery {
  constructor(root, version, installation) {
    if (!safeId(version)) throw new Error('Invalid desktop version');
    this.root = path.resolve(root);
    this.version = version;
    this.installation = path.resolve(installation);
    this.file = path.join(this.root, 'official-recovery', 'state.json');
    this.epoch = 0;
    this.state = this.read();
  }

  read() {
    for (const file of [this.file, `${this.file}.bak`]) {
      const value = readState(file);
      if (value) return value;
    }
    return { schemaVersion: 1, active: this.version, home: `home-${this.version}`, failures: 0 };
  }

  persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // Never replace the last good backup with the damaged primary we just recovered from.
    const primary = readState(this.file);
    if (primary) atomicWrite(`${this.file}.bak`, `${JSON.stringify(primary, null, 2)}\n`);
    atomicWrite(this.file, `${JSON.stringify(this.state, null, 2)}\n`);
  }

  home(id = this.state.home) {
    if (!safeId(id)) throw new Error('Invalid data slot');
    return path.join(this.root, 'official-homes', id);
  }

  fallbackRelease() {
    const releases = [this.state.stable, this.state.previousStable].filter(Boolean);
    for (const release of [...releases.filter(item => item.version !== this.version),
      ...releases.filter(item => item.version === this.version)]) {
      const executable = path.join(this.root, 'stable-releases', release.version, 'DeepSeekHarness.exe');
      if (path.resolve(executable) === path.join(this.installation, 'DeepSeekHarness.exe')) continue;
      // Old snapshots without a checksum manifest are kept, but are not an automatic recovery target.
      if (sha256IsValid(release.manifestSha256) && regularDirectory(path.dirname(this.home(release.home))) &&
          regularDirectory(this.home(release.home)) &&
          verifySnapshotSync(path.dirname(executable), release.version, release.manifestSha256)) return { ...release, executable };
    }
    return undefined;
  }

  async cloneData(source, destination) {
    await mkdir(destination, { recursive: true });
    if (!fs.existsSync(source)) return;
    await cp(source, destination, {
      recursive: true,
      filter: file => !['profiles', 'dsh-runtimes'].includes(path.relative(source, file).split(path.sep)[0]) &&
        !fs.lstatSync(file).isSymbolicLink()
    });
  }

  legacyHome() {
    try {
      const state = JSON.parse(fs.readFileSync(path.join(this.root, 'recovery', 'state.json'), 'utf8'));
      const id = state.schemaVersion === 1 ? 'default' : state.activeHomeId;
      if (id === 'default') return path.join(this.root, 'harness-home');
      if (safeId(id) && id.startsWith('slot-')) return path.join(this.root, 'profile-homes', id);
    } catch { /* No legacy desktop installation; never inspect the global ~/.dsh. */ }
    return undefined;
  }

  /** Clone only product data. Executable profiles are initialized by the matching official Desktop. */
  async prepare() {
    const fallback = this.state.rejected === this.version ? this.fallbackRelease() : undefined;
    if (this.state.rejected === this.version && fallback) return fallback.executable;
    if (this.state.active !== this.version) {
      const previousHome = this.home();
      const nextHome = `home-${this.version}-${randomUUID().slice(0, 8)}`;
      const destination = this.home(nextHome);
      await this.cloneData(previousHome, destination);
      this.state = { ...this.state, active: this.version, home: nextHome, failures: 0 };
    }
    if (!fs.existsSync(this.home()) && !fs.existsSync(this.file)) {
      const legacy = this.legacyHome();
      if (legacy) await this.cloneData(legacy, this.home());
    }
    await mkdir(this.home(), { recursive: true });
    this.persist();
    return undefined;
  }

  /** Bound retries across application relaunches; plugin reset remains the official recovery operation. */
  failure() {
    this.epoch++;
    this.state.failures++;
    let action = this.state.failures === 1 ? 'retry' : this.state.failures === 2 ? 'disable-plugins' : 'manual';
    const stable = this.state.failures >= 3 ? this.fallbackRelease() : undefined;
    if (this.state.failures >= 3 && stable) {
      this.state.rejected = this.version;
      this.state.active = stable.version;
      this.state.home = stable.home;
      this.state.failures = 0;
      if (this.state.previousStable?.version === stable.version) {
        this.state.stable = { version: stable.version, home: stable.home, manifestSha256: stable.manifestSha256 };
        delete this.state.previousStable;
      }
      action = 'fallback';
    }
    this.persist();
    return { action, executable: action === 'fallback' ? stable.executable : undefined };
  }

  /** Save a complete executable installation only after the official Host and UI survive probation. */
  async healthy(stillHealthy = () => true) {
    const epoch = this.epoch;
    const destination = path.join(this.root, 'stable-releases', this.version);
    if (this.root === this.installation || this.root.startsWith(`${this.installation}${path.sep}`)) {
      throw new Error('Recovery storage must be outside the application installation');
    }
    const expectedDigest = this.state.stable?.version === this.version ? this.state.stable.manifestSha256 : undefined;
    let manifestSha256 = await verifySnapshot(destination, this.version, expectedDigest);
    if (!manifestSha256) {
      if (this.installation === destination) throw new Error('A damaged stable snapshot cannot repair itself');
      const staging = `${destination}.staging-${randomUUID()}`;
      if (fs.existsSync(path.dirname(destination)) && !regularDirectory(path.dirname(destination))) {
        throw new Error('Stable recovery storage must not be a symbolic link');
      }
      await mkdir(path.dirname(destination), { recursive: true });
      try {
        await cp(this.installation, staging, {
          recursive: true,
          filter: source => {
            if (fs.lstatSync(source).isSymbolicLink()) throw new Error('Stable installation must not contain symbolic links');
            return source !== path.join(this.installation, manifestName);
          }
        });
        const entries = await snapshotEntries(staging);
        const contents = `${JSON.stringify({ schemaVersion: 1, version: this.version, entries }, null, 2)}\n`;
        manifestSha256 = createHash('sha256').update(contents).digest('hex');
        atomicWrite(path.join(staging, manifestName), contents);
        if (this.epoch !== epoch || !stillHealthy()) return false;
        // Preserve any old or damaged cache for diagnostics; never delete an installation.
        if (fs.existsSync(destination)) await rename(destination, `${destination}.quarantined-${randomUUID()}`);
        await rename(staging, destination);
      } finally {
        // This is an explicitly owned, freshly generated sibling temporary directory.
        if (path.dirname(staging) !== path.join(this.root, 'stable-releases')) throw new Error('Invalid staging cleanup target');
        await rm(staging, { recursive: true, force: true });
      }
    }
    if (this.epoch !== epoch || !stillHealthy()) return false;
    if (this.state.stable && this.state.stable.version !== this.version) this.state.previousStable = this.state.stable;
    this.state.stable = { version: this.version, home: this.state.home, manifestSha256 };
    this.state.failures = 0;
    // A healthy cached copy must not reactivate a rejected installed copy of the same version.
    this.persist();
    return true;
  }
}

module.exports = { DesktopRecovery, safeId };
