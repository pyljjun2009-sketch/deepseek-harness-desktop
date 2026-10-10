import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { communityInstallSection, communityInstallerExits, communityUninstaller,
  installWindowsCommunityInstaller, windowsApplicationPathBudget } from './windows-community-installer.mjs';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratchRoot = join(root, '.official-build');
const templates = join(dirname(require.resolve('app-builder-lib/package.json')), 'templates/nsis');
const run = promisify(execFile);
async function privateDirectory() { await mkdir(scratchRoot, { recursive: true }); return mkdtemp(join(scratchRoot, 'installer-test-')); }
async function cleanup(directory) {
  const suffix = relative(scratchRoot, resolve(directory));
  assert(suffix !== '' && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !resolve(suffix).startsWith('..'));
  assert(dirname(resolve(directory)) === resolve(scratchRoot));
  await rm(directory, { recursive: true, force: true });
}

test('pinned root template stages before uninstall and promotes before registration', async () => {
  const source = await readFile(join(templates, 'installSection.nsh'), 'utf8');
  const result = communityInstallSection(source);
  assert(result.indexOf('!insertmacro dshStageApplication') < result.indexOf('!insertmacro uninstallOldVersion SHELL_CONTEXT'));
  assert(result.indexOf('Call dshPromoteDirectories') < result.indexOf('!insertmacro registryAddInstallInfo'));
  assert(!result.includes('!insertmacro installApplicationFiles'));
  assert(result.includes('!macroundef extractUsing7za'));
  assert(result.includes('ReadReg') || result.includes('readReg'));
});

test('unexpected template changes fail before payload publication', () => {
  assert.throws(() => communityInstallSection('different upstream template'), /unsupported NSIS template/);
  assert.throws(() => communityUninstaller('no application removal'), /unsupported NSIS template/);
});

test('abort paths clean staged directories and uninstall retains data handling', async () => {
  assert.match(communityInstallerExits('  Quit\n'), /Call dshCleanupDirectories[\s\S]*Quit/);
  const source = await readFile(join(templates, 'uninstaller.nsh'), 'utf8');
  const result = communityUninstaller(source);
  assert(result.includes('RMDir /r "\\\\?\\$INSTDIR"'));
  assert(result.includes('Var /GLOBAL isDeleteAppData'));
  assert(result.includes('DELETE_APP_DATA_ON_UNINSTALL'));
});

test('root builder class is patched exactly once, not the official checkout class', () => {
  require('app-builder-lib');
  const { NsisTarget } = require('app-builder-lib/out/targets/nsis/NsisTarget.js');
  const original = NsisTarget.prototype.computeFinalScript;
  installWindowsCommunityInstaller();
  const installed = NsisTarget.prototype.computeFinalScript;
  assert.notEqual(installed, original);
  installWindowsCommunityInstaller();
  assert.equal(NsisTarget.prototype.computeFinalScript, installed);
});

test('path inventory uses actual output and refuses junctions escaping the application', async () => {
  const directory = await privateDirectory();
  try {
    const application = join(directory, 'application');
    const nested = join(application, 'resources', 'runtime', 'payload');
    await mkdir(nested, { recursive: true }); await writeFile(join(nested, 'longest.txt'), 'payload');
    const budget = await windowsApplicationPathBudget(application);
    assert.equal(budget.longestRelativePath, join('resources', 'runtime', 'payload', 'longest.txt'));
    assert.equal(budget.legacyMaxInstallDirectoryLength, 258 - budget.longestRelativePath.length);
    const external = join(directory, 'external'); await mkdir(external);
    await symlink(external, join(application, 'external-link'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(windowsApplicationPathBudget(application), /linked application path/);
    // Unlink the owned junction first; recursive cleanup never follows it.
    const { unlink } = await import('node:fs/promises'); await unlink(join(application, 'external-link'));
  } finally { await cleanup(directory); }
});

async function cachedNsisCompiler() {
  if (process.env.DSH_NSIS_COMPILER) return process.env.DSH_NSIS_COMPILER;
  const base = join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache', 'nsis-3.0.4.1');
  const children = await readdir(base, { withFileTypes: true });
  const directory = children.find(entry => entry.isDirectory());
  if (!directory) throw new Error('No cached NSIS compiler; supply DSH_NSIS_COMPILER');
  return join(base, directory.name, 'Bin', 'makensis.exe');
}

test('real isolated NSIS payload replaces, restores, rejects corrupt extraction, and supports long paths',
  { skip: process.env.DSH_INSTALLER_NATIVE_TEST !== '1' || process.platform !== 'win32' }, async () => {
    const directory = await privateDirectory();
    try {
      const compiler = await cachedNsisCompiler();
      const { getPath7za } = require('app-builder-lib/out/toolsets/7zip.js');
      const sevenZip = await getPath7za();
      const { NsisTarget } = require('app-builder-lib/out/targets/nsis/NsisTarget.js');
      const { CancellationToken } = require('builder-util-runtime');
      const adapted = await NsisTarget.prototype.computeFinalScript.call({
        outDir: directory, options: { installerLanguages: ['zh_CN', 'en_US'] },
        packager: { info: { cancellationToken: new CancellationToken() },
          fileAssociations: [], signIf: async () => {} },
        isPortable: false, getPreCompressedFileExtensions: () => [],
      }, await readFile(join(templates, 'installer.nsi'), 'utf8'), false, new Map());
      assert(adapted.includes('!define DSH_SEVENZIP_PATH'));
      const rewritten = await readFile(join(directory, '.nsis-community-installer', 'installSection.nsh'), 'utf8');
      assert(rewritten.includes('!insertmacro dshStageApplication'));
      assert.deepEqual(await readFile(join(directory, '.nsis-community-installer', '7za.exe')), await readFile(sevenZip));
      const payload = join(directory, 'payload');
      const relativeFile = join('resources', 'runtime', 'long-name-for-native-installer-validation'.repeat(3), 'payload.txt');
      await mkdir(dirname(join(payload, relativeFile)), { recursive: true });
      await writeFile(join(payload, relativeFile), 'new healthy version');
      const archive = join(directory, 'payload.7z');
      await run(sevenZip, ['a', '-t7z', archive, '.'], { cwd: payload, windowsHide: true, timeout: 30_000 });
      const corrupt = join(directory, 'corrupt.7z'); await writeFile(corrupt, 'not a valid archive');
      const nativeInclude = join(root, 'build/community-installer-directories.nsh');
      const licenseRoot = dirname(dirname(sevenZip));
      for (const round of [1, 2, 3]) for (const scenario of ['replace', 'corrupt', 'failed-promotion', 'locked-predecessor']) {
        const targetName = `target-${round}-${scenario}`;
        const target = join(directory, targetName);
        await mkdir(target); await writeFile(join(target, 'old.txt'), 'previous healthy version');
        const executable = join(directory, `${round}-${scenario}.exe`);
        const fixture = join(directory, `${round}-${scenario}.nsi`);
        await writeFile(fixture, `Unicode true
Name "DSH isolated directory test"
OutFile "${executable}"
RequestExecutionLevel user
SilentInstall silent
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!define DSH_SEVENZIP_PATH "${sevenZip}"
!define DSH_SEVENZIP_LICENSE_DIR "${licenseRoot}"
LangString decompressionFailed 1033 "Extraction failed"
!macro installApplicationFiles
  File /oname=$PLUGINSDIR\\payload.7z "${scenario === 'corrupt' ? corrupt : archive}"
  !insertmacro dshExtractPayload "$PLUGINSDIR\\payload.7z"
!macroend
!include "${nativeInclude}"
Section
  InitPluginsDir
  !insertmacro dshStageApplication
  ${scenario === 'failed-promotion' ? 'RMDir /r "\\\\?\\$dshNewDirectory"' : ''}
  ${scenario === 'locked-predecessor' ? `System::Call 'kernel32::CreateFileW(w "$dshFinalDirectory\\old.txt", i 0x80000000, i 0, p 0, i 3, i 0, p 0) p.r9'` : ''}
  Call dshPromoteDirectories
  IfErrors 0 +3
    SetErrorLevel 2
    Quit
  !insertmacro dshFinishDirectories
SectionEnd
`);
        await run(compiler, ['/V2', '-INPUTCHARSET', 'UTF8', fixture], { windowsHide: true, timeout: 30_000 });
        const result = await run(executable, ['/S', `/D=${target}`], { windowsHide: true, timeout: 30_000 })
          .then(() => ({ code: 0 }), error => ({ code: error.code }));
        if (scenario === 'replace') {
          assert.equal(result.code, 0);
          assert.equal(await readFile(join(target, relativeFile), 'utf8'), 'new healthy version');
          assert(join(target, relativeFile).length > 259, 'fixture must actually exercise a long destination');
          await assert.rejects(readFile(join(target, 'old.txt')), { code: 'ENOENT' });
        } else {
          assert.equal(result.code, 2);
          assert.equal(await readFile(join(target, 'old.txt'), 'utf8'), 'previous healthy version');
          await assert.rejects(readFile(join(target, relativeFile)), { code: 'ENOENT' });
        }
        const leftovers = (await readdir(directory)).filter(name => name.startsWith(`${targetName}.new-`) || name.startsWith(`${targetName}.old-`));
        assert.deepEqual(leftovers, []);
      }
    } finally { await cleanup(directory); }
  });
