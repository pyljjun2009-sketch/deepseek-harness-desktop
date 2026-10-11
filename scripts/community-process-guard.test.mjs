import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = join(root, '.official-build');
const guardPath = join(root, 'build', 'community-process-guard.nsh');
const run = promisify(execFile);
const wait = milliseconds => new Promise(complete => setTimeout(complete, milliseconds));
const native = process.env.DSH_INSTALLER_NATIVE_TEST === '1' && process.platform === 'win32';

async function privateDirectory() {
  await mkdir(scratch, { recursive: true });
  return mkdtemp(join(scratch, 'process-guard-test-'));
}
async function cleanup(directory) {
  const suffix = relative(scratch, resolve(directory));
  assert(suffix !== '' && suffix !== '..' && !suffix.startsWith(`..${sep}`));
  assert.equal(dirname(resolve(directory)), resolve(scratch));
  await rm(directory, { recursive: true, force: true });
}
async function cacheDirectory(name) {
  const base = join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache', name);
  const directories = (await readdir(base, { withFileTypes: true })).filter(entry => entry.isDirectory());
  assert.equal(directories.length, 1, `Expected one qualified cached ${name} directory`);
  return join(base, directories[0].name);
}
async function nativeTools() {
  const compiler = process.env.DSH_NSIS_COMPILER || join(await cacheDirectory('nsis-3.0.4.1'), 'Bin', 'makensis.exe');
  const plugins = join(await cacheDirectory('nsis-resources-3.4.1'), 'plugins', 'x86-unicode');
  return { compiler, plugins };
}
async function compile(directory, tools, name, source) {
  assert.match(name, /^[a-z0-9-]+$/);
  const executable = join(directory, `${name}.exe`);
  const script = join(directory, `${name}.nsi`);
  await writeFile(script, `Unicode true
Name "Isolated process guard qualification"
OutFile "${executable}"
RequestExecutionLevel user
SilentInstall silent
!addplugindir /x86-unicode "${tools.plugins}"
!include "LogicLib.nsh"
${source}
`);
  await run(tools.compiler, ['/V2', '-INPUTCHARSET', 'UTF8', script], { windowsHide: true });
  return executable;
}
async function installer(directory, tools, name, processName, guard = guardPath, override = '') {
  const marker = join(directory, `${name}.passed`);
  const executable = await compile(directory, tools, name, `!define APP_EXECUTABLE_FILENAME "${processName}"
${override}
!include "${guard}"
Section
  !insertmacro customCheckAppRunning
  FileOpen $0 "${marker}" w
  FileWrite $0 "passed"
  FileClose $0
SectionEnd
`);
  return { executable, marker };
}
async function execute(executable) {
  try { await run(executable, ['/S'], { windowsHide: true }); return 0; }
  catch (error) { if (typeof error.code === 'number') return error.code; throw error; }
}
async function absent(path) { await assert.rejects(readFile(path), { code: 'ENOENT' }); }

test('the production hook is readonly, rejects all uncertain results, and preserves explicit overrides', async () => {
  const guard = await readFile(guardPath, 'utf8');
  const include = await readFile(join(root, 'build', 'community-installer.nsh'), 'utf8');
  const templates = join(dirname(require.resolve('app-builder-lib/package.json')), 'templates', 'nsis', 'include');
  const builder = await readFile(join(templates, 'allowOnlyOneInstallerInstance.nsh'), 'utf8');
  const api = await readFile(join(templates, 'nsProcess.nsh'), 'utf8');
  assert.match(include, /!include "\$\{__FILEDIR__\}\\community-process-guard\.nsh"/);
  assert.match(guard, /!ifmacrondef customCheckAppRunning/);
  assert.match(guard, /nsProcess::_FindProcess "\$\{APP_EXECUTABLE_FILENAME\}"/);
  assert.equal((guard.match(/nsProcess::/g) || []).length, 1);
  assert.match(guard, /\$\{If\} \$R0 == 0/);
  assert.match(guard, /\$\{ElseIf\} \$R0 != 603/);
  assert.equal((guard.match(/SetErrorLevel 2\s+Quit/g) || []).length, 2);
  assert.doesNotMatch(guard, /(?:_KillProcess|_CloseProcess|taskkill|Stop-Process|TerminateProcess|nsExec::Exec|ExecWait)/i);
  assert.match(builder, /!ifmacrodef customCheckAppRunning\s+!insertmacro customCheckAppRunning\s+!else/);
  assert.match(api, /nsProcess::_FindProcess \/NOUNLOAD/);
});

test('real isolated NSIS denies a live UUID sleeper without terminating it, then allows its natural exit',
  { skip: !native }, async () => {
    const directory = await privateDirectory();
    let sleeper;
    let completion;
    try {
      const tools = await nativeTools();
      const name = `guard-sleeper-${randomUUID()}`;
      const ready = join(directory, 'sleeper.ready');
      const exited = join(directory, 'sleeper.exited');
      const executable = await compile(directory, tools, name, `Section
  FileOpen $0 "${ready}" w
  FileWrite $0 "ready"
  FileClose $0
  Sleep 6000
  FileOpen $0 "${exited}" w
  FileWrite $0 "natural exit"
  FileClose $0
SectionEnd
`);
      const candidate = await installer(directory, tools, 'live-check', `${name}.exe`);
      sleeper = spawn(executable, ['/S'], { windowsHide: true, stdio: 'ignore' });
      completion = new Promise((complete, reject) => {
        sleeper.once('error', reject);
        sleeper.once('close', (code, signal) => complete({ code, signal }));
      });
      for (let attempt = 0; ; attempt++) {
        try { assert.equal(await readFile(ready, 'utf8'), 'ready'); break; }
        catch (error) {
          if (error.code !== 'ENOENT') throw error;
          assert(attempt < 200 && sleeper.exitCode === null, 'owned sleeper failed to become ready');
          await wait(10);
        }
      }
      assert.equal(sleeper.exitCode, null);
      assert.equal(await execute(candidate.executable), 2);
      assert.equal(sleeper.exitCode, null, 'installer must leave the owned sleeper running');
      assert.equal(sleeper.signalCode, null);
      await absent(candidate.marker);
      await absent(exited);
      assert.deepEqual(await completion, { code: 0, signal: null });
      assert.equal(await readFile(exited, 'utf8'), 'natural exit');
      assert.equal(await execute(candidate.executable), 0);
      assert.equal(await readFile(candidate.marker, 'utf8'), 'passed');
    } finally {
      // The owned sleeper exits by itself. No process termination, even during cleanup.
      if (completion) await completion;
      await cleanup(directory);
    }
  });

test('real NSIS rejects injected probe errors and accepts only the documented absent code',
  { skip: !native }, async () => {
    const directory = await privateDirectory();
    try {
      const tools = await nativeTools();
      const source = await readFile(guardPath, 'utf8');
      const probe = 'nsProcess::_FindProcess "${APP_EXECUTABLE_FILENAME}"';
      assert.equal(source.split(probe).length, 2);
      for (const result of ['601', '602', '604', '605', '606', '607', '608', '609', '610', '611', 'error', '', '603']) {
        const name = `probe-${result || 'empty'}`;
        const injected = join(directory, `${name}.nsh`);
        await writeFile(injected, source.replace(probe, `Push "${result}"`));
        const candidate = await installer(directory, tools, name, `absent-${randomUUID()}.exe`, injected);
        assert.equal(await execute(candidate.executable), result === '603' ? 0 : 2);
        if (result === '603') assert.equal(await readFile(candidate.marker, 'utf8'), 'passed');
        else await absent(candidate.marker);
      }
    } finally { await cleanup(directory); }
  });

test('real NSIS retains a deliberately supplied isolated customCheckAppRunning macro',
  { skip: !native }, async () => {
    const directory = await privateDirectory();
    try {
      const tools = await nativeTools();
      const overrideMarker = join(directory, 'override.used');
      const candidate = await installer(directory, tools, 'override-check', `absent-${randomUUID()}.exe`, guardPath,
        `!macro customCheckAppRunning
  FileOpen $0 "${overrideMarker}" w
  FileWrite $0 "explicit override"
  FileClose $0
!macroend`);
      assert.equal(await execute(candidate.executable), 0);
      assert.equal(await readFile(candidate.marker, 'utf8'), 'passed');
      assert.equal(await readFile(overrideMarker, 'utf8'), 'explicit override');
    } finally { await cleanup(directory); }
  });
