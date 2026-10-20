import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep, win32 } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// OneDrive cloud placeholders have FILE_ATTRIBUTE_REPARSE_POINT even when Node's
// lstat does not report a symlink. Qualification requires a physical local target.
const scratch = resolve(tmpdir());
const run = promisify(execFile);
const native = process.env.DSH_INSTALLER_NATIVE_TEST === '1' && process.platform === 'win32';
async function privateDirectory() {
  await mkdir(scratch, { recursive: true });
  return mkdtemp(join(scratch, `dsh-location-test-${randomUUID()}-`));
}
async function cleanup(directory) {
  const suffix = relative(scratch, resolve(directory));
  assert(suffix !== '' && suffix !== '..' && !suffix.startsWith(`..${sep}`));
  assert.equal(dirname(resolve(directory)), resolve(scratch));
  assert.match(suffix, /^dsh-location-test-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}-[a-z0-9]+$/i);
  await rm(directory, { recursive: true, force: true });
}
async function compiler() {
  if (process.env.DSH_NSIS_COMPILER) return process.env.DSH_NSIS_COMPILER;
  const base = join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache', 'nsis-3.0.4.1');
  const entries = (await readdir(base, { withFileTypes: true })).filter(entry => entry.isDirectory());
  assert.equal(entries.length, 1);
  return join(base, entries[0].name, 'Bin', 'makensis.exe');
}
async function compile(directory, name, source) {
  assert.match(name, /^[a-z0-9-]+$/);
  const executable = join(directory, `${name}.exe`);
  const script = join(directory, `${name}.nsi`);
  await writeFile(script, `Unicode true
Name "Isolated install location qualification"
OutFile "${executable}"
RequestExecutionLevel user
SilentInstall silent
!include "LogicLib.nsh"
!include "FileFunc.nsh"
${source}
`);
  await run(await compiler(), ['/WX', '/V2', '-INPUTCHARSET', 'UTF8', script], { windowsHide: true });
  return executable;
}
async function execute(executable, target) {
  try { await run(executable, ['/S', `/D=${target}`], { windowsHide: true }); return 0; }
  catch (error) { if (typeof error.code === 'number') return error.code; throw error; }
}
async function productionGuard(directory, name, { registered = false, mutate = value => value, createTarget = false,
  rawTarget, buildUninstaller = false } = {}) {
  let source = await readFile(join(root, 'build', 'community-installer.nsh'), 'utf8');
  source = source.replace('"${__FILEDIR__}\\community-process-guard.nsh"',
    `"${join(root, 'build', 'community-process-guard.nsh')}"`);
  const transaction = '!include "${__FILEDIR__}\\community-installer-directories.nsh"';
  assert.equal(source.split(transaction).length, 2);
  source = source.replace(transaction, '; No payload/directory transaction in this isolated location fixture.');
  if (registered) {
    const lookup = 'ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation';
    assert.equal(source.split(lookup).length, 2);
    source = source.replace(lookup, 'StrCpy $0 "$INSTDIR"'); // Fixture injection, no registry writes.
  }
  const include = join(directory, `${name}.nsh`);
  await writeFile(include, mutate(source));
  const marker = join(directory, `${name}.passed`);
  const executable = await compile(directory, name, `!define INSTALL_REGISTRY_KEY "Software\\DSH-Install-Location-QA\\${randomUUID()}"
${buildUninstaller ? '!define BUILD_UNINSTALLER' : ''}
!define isForAllUsers '0 == 1'
!include "${include}"
Function .onInit
  ${rawTarget ? `StrCpy $INSTDIR "${rawTarget}"` : ''}
  ${createTarget ? 'SetOutPath $INSTDIR' : ''}
  ${buildUninstaller ? '; customInit is not expanded while generating the uninstaller stub.' : '!insertmacro customInit'}
  FileOpen $9 "${marker}" w
  FileWrite $9 "passed"
  FileClose $9
FunctionEnd
Section
SectionEnd`);
  return { executable, marker };
}

test('the pinned builder applies its /D override before customInit but creates the initial directory first', async () => {
  const base = join(dirname(require.resolve('app-builder-lib/package.json')), 'templates', 'nsis');
  const source = await readFile(join(base, 'installer.nsi'), 'utf8');
  assert(source.indexOf('SetOutPath $INSTDIR') < source.indexOf('!insertmacro initMultiUser'));
  assert(source.indexOf('!insertmacro initMultiUser') < source.indexOf('!insertmacro customInit'));
  const mode = await readFile(join(base, 'multiUser.nsh'), 'utf8');
  assert.match(mode, /!insertmacro GetDParameter \$R0\s+\$\{If\} \$R0 != ""\s+StrCpy \$INSTDIR \$R0/);
});

test('real NSIS proves FileExists glob means directory existence, including a path created by SetOutPath',
  { skip: !native }, async () => {
    const directory = await privateDirectory();
    try {
      for (const initial of ['missing', 'empty']) {
        const target = join(directory, initial);
        if (initial === 'empty') await mkdir(target);
        const marker = join(directory, `${initial}.diagnostic`);
        const executable = await compile(directory, `predicate-${initial}`, `Function .onInit
  FileOpen $9 "${marker}" w
  FileWriteUTF16LE $9 "$INSTDIR$\\r$\\n"
  \${If} \${FileExists} "$INSTDIR\\*.*"
    FileWriteUTF16LE $9 "before=1$\\r$\\n"
  \${Else}
    FileWriteUTF16LE $9 "before=0$\\r$\\n"
  \${EndIf}
  SetOutPath $INSTDIR
  \${If} \${FileExists} "$INSTDIR\\*.*"
    FileWriteUTF16LE $9 "after=1$\\r$\\n"
  \${Else}
    FileWriteUTF16LE $9 "after=0$\\r$\\n"
  \${EndIf}
  FileClose $9
FunctionEnd
Section
SectionEnd`);
        assert.equal(await execute(executable, target), 0);
        assert.equal((await readFile(marker)).toString('utf16le'), `${target}\r\n${initial === 'missing' ? 'before=0' : 'before=1'}\r\nafter=1\r\n`);
        assert.deepEqual(await readdir(target), [], 'only an owned empty QA directory was created');
      }
    } finally { await cleanup(directory); }
  });

test('the actual include also compiles its BUILD_UNINSTALLER branch with warnings treated as errors',
  { skip: !native }, async () => {
    const directory = await privateDirectory();
    try {
      const candidate = await productionGuard(directory, 'uninstaller-stub', { buildUninstaller: true });
      assert.equal(await execute(candidate.executable, join(directory, 'unused-target')), 0);
      assert.equal(await readFile(candidate.marker, 'utf8'), 'passed');
    } finally { await cleanup(directory); }
  });

test('production customInit accepts both an empty target and a missing target created by the builder',
  { skip: !native }, async () => {
    const directory = await privateDirectory();
    try {
      for (const initial of ['missing', 'empty']) {
        const target = join(directory, initial);
        if (initial === 'empty') await mkdir(target);
        const candidate = await productionGuard(directory, `production-${initial}`, { createTarget: true });
        assert.equal(await execute(candidate.executable, target), 0);
        assert.equal(await readFile(candidate.marker, 'utf8'), 'passed');
        assert.deepEqual(await readdir(target), []);
      }
    } finally { await cleanup(directory); }
  });

test('production enumeration accepts only documented absence/empty outcomes and captures errors immediately', async () => {
  const source = await readFile(join(root, 'build', 'community-installer.nsh'), 'utf8');
  const macro = source.slice(source.indexOf('!macro customInit'));
  assert.doesNotMatch(macro, /\$\{FileExists\} "\$INSTDIR\\\*\.\*"/);
  assert.match(source, /GetFileAttributesW\(w "\$INSTDIR"\) i\.r0 \?e'\s+Pop \$1/);
  assert.match(source, /FindFirstFileW\(w "\$INSTDIR\\\*\.\*", p r2\) p\.r3 \?e'\s+Pop \$1/);
  assert.match(source, /FindNextFileW\(p r3, p r2\) i\.r0 \?e'\s+Pop \$1/);
  assert.match(source, /\$4 != "\."\s+\$\{AndIf\} \$4 != "\.\."/);
  assert.match(source, /\$1 == 18/);
  assert.match(macro, /\$R0 == "unknown"[\s\S]*SetErrorLevel 2\s+Quit/);
  assert.doesNotMatch(source.slice(0, source.indexOf('!macro customInit')), /(?:CreateDirectory|FileOpen|Delete|RMDir|WriteReg)/);
});

test('real production location guard distinguishes nonexistent, empty, registered and unregistered nonempty targets',
  { skip: !native }, async () => {
    const directory = await privateDirectory();
    try {
      for (const [scenario, existing, content, registered, expected] of [
        ['nonexistent', false, false, false, 0],
        ['empty', true, false, false, 0],
        ['registered-nonempty', true, true, true, 0],
        ['unregistered-nonempty', true, true, false, 2],
        ['unregistered-subdirectory', true, 'directory', false, 2],
      ]) {
        const target = join(directory, scenario);
        if (existing) await mkdir(target);
        if (content === 'directory') await mkdir(join(target, 'only-child-directory'));
        else if (content) await writeFile(join(target, 'owned-fixture.txt'), 'preserve this QA fixture');
        const candidate = await productionGuard(directory, scenario, { registered });
        assert.equal(await execute(candidate.executable, target), expected, scenario);
        if (expected === 0) assert.equal(await readFile(candidate.marker, 'utf8'), 'passed');
        else await assert.rejects(readFile(candidate.marker), { code: 'ENOENT' });
        if (content === true) assert.equal(await readFile(join(target, 'owned-fixture.txt'), 'utf8'), 'preserve this QA fixture');
        if (!existing) await assert.rejects(readdir(target), { code: 'ENOENT' });
      }
    } finally { await cleanup(directory); }
  });

test('real production guard rejects read errors, incomplete enumeration and a regular file target',
  { skip: !native }, async () => {
    const directory = await privateDirectory();
    try {
      for (const [scenario, statement, replacement] of [
        ['attribute-error', 'System::Call \'kernel32::GetFileAttributesW(w "$INSTDIR") i.r0 ?e\'', 'StrCpy $0 -1\n  Push 5'],
        ['first-error', 'System::Call \'kernel32::FindFirstFileW(w "$INSTDIR\\*.*", p r2) p.r3 ?e\'', 'StrCpy $3 -1\n  Push 5'],
        ['next-error', 'System::Call \'kernel32::FindNextFileW(p r3, p r2) i.r0 ?e\'', 'StrCpy $0 0\n  Push 5'],
        ['close-error', 'System::Call \'kernel32::FindClose(p r3) i.r0\'', 'System::Call \'kernel32::FindClose(p r3) i.r0\'\n  StrCpy $0 0'],
      ]) {
        const target = join(directory, scenario);
        await mkdir(target);
        const candidate = await productionGuard(directory, scenario, { mutate: source => {
          assert.equal(source.split(statement).length, 2);
          return source.replace(statement, replacement);
        } });
        assert.equal(await execute(candidate.executable, target), 2, scenario);
        await assert.rejects(readFile(candidate.marker), { code: 'ENOENT' });
        assert.deepEqual(await readdir(target), []);
      }
      const target = join(directory, 'regular-file');
      await writeFile(target, 'unchanged regular file');
      const candidate = await productionGuard(directory, 'regular-file');
      assert.equal(await execute(candidate.executable, target), 2);
      assert.equal(await readFile(target, 'utf8'), 'unchanged regular file');
    } finally { await cleanup(directory); }
  });

test('real production guard rejects the ordinary drive root without writing to that root',
  { skip: !native }, async () => {
    const directory = await privateDirectory();
    try {
      const candidate = await productionGuard(directory, 'drive-root');
      assert.equal(await execute(candidate.executable, win32.parse(directory).root), 2);
      await assert.rejects(readFile(candidate.marker), { code: 'ENOENT' });
    } finally { await cleanup(directory); }
  });

test('real production root validation rejects repeated separators and dot aliases even with matching injected registration',
  { skip: !native }, async () => {
    const directory = await privateDirectory();
    try {
      const driveRoot = win32.parse(directory).root;
      // Only the isolated registered-path read is injected. No root files or registry
      // entries are written, and no payload/transaction macro is present in the fixture.
      for (const [name, alias] of [['repeated', `${driveRoot}\\\\`], ['dot-alias', `${driveRoot}.\\`],
        ['parent-alias', `${driveRoot}owned-unused-component\\..\\`]]) {
        const candidate = await productionGuard(directory, `root-${name}`, { registered: true, rawTarget: alias });
        assert.equal(await execute(candidate.executable, driveRoot), 2, name);
        await assert.rejects(readFile(candidate.marker), { code: 'ENOENT' });
      }
    } finally { await cleanup(directory); }
  });

test('real production root validation fails closed on normalization errors and never rewrites INSTDIR',
  { skip: !native }, async () => {
    const directory = await privateDirectory();
    try {
      const statement = 'System::Call \'kernel32::GetFullPathNameW(w "$INSTDIR", i ${NSIS_MAX_STRLEN}, w .r1, p 0) i.r0\'';
      for (const [name, result] of [['normalization-error', '0'], ['normalization-overflow', '${NSIS_MAX_STRLEN}']]) {
        const target = join(directory, name);
        await mkdir(target);
        const candidate = await productionGuard(directory, name, { mutate: source => {
          assert.equal(source.split(statement).length, 2);
          return source.replace(statement, `StrCpy $0 ${result}`);
        } });
        assert.equal(await execute(candidate.executable, target), 2);
        await assert.rejects(readFile(candidate.marker), { code: 'ENOENT' });
        assert.deepEqual(await readdir(target), []);
      }
      const source = await readFile(join(root, 'build', 'community-installer.nsh'), 'utf8');
      const macro = source.slice(source.indexOf('!macro customInit'), source.indexOf('!macroend', source.indexOf('!macro customInit')));
      assert.match(macro, /GetFullPathNameW[\s\S]*\$\{GetRoot\} "\$1" \$0/);
      assert.doesNotMatch(macro, /StrCpy \$INSTDIR|SetOutPath|CreateDirectory/);
    } finally { await cleanup(directory); }
  });
