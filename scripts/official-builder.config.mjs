import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { relative } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { installWindowsCommunityInstaller, windowsApplicationPathBudget } from './windows-community-installer.mjs';
import { verifyOfficialShellAsar } from './verify-official-shell-asar.mjs';
import { communityPackageName, writeCommunityUpdateConfiguration } from './community-update-config.mjs';
import { verifyCommunityHostPort } from './verify-official-host.mjs';
import { officialDependencyHooks } from './official-dependency-hooks.mjs';
installWindowsCommunityInstaller();
const root = fileURLToPath(new URL('../', import.meta.url));
const prepared = JSON.parse(readFileSync(join(root, '.official-build/paths.json'), 'utf8'));
const { source, staging, paths, officialVersion } = prepared;
const officialLock = JSON.parse(readFileSync(join(root, 'official.lock.json'), 'utf8'));
const scripts = join(source, 'apps/desktop/scripts');
const { prepareWindowsAsarUnpack, verifyWindowsAsarUnpack } = await import(pathToFileURL(join(scripts, 'windows-asar-unpack.mjs')));
const { officePackageDirectories } = await import(pathToFileURL(join(source, 'scripts/libreoffice-packages.mjs')));
const { windowsRuntimeCode } = await import(pathToFileURL(join(scripts, 'windows-runtime-signature.mjs')));
const dsh = join(paths, 'dsh');
let windowsCode = [];

/** Reused by the full build and explicit NSIS-only repackage. Never skips the payload gates. */
export async function verifyPackagedOfficial(appOutDir) {
  const { verifyDesktopRuntime } = await import(pathToFileURL(join(source, 'apps/desktop/lib/types/runtime-tree.js')));
  const descriptor = await verifyDesktopRuntime(dsh, officialVersion, { platform: 'win32', arch: 'x64' });
  const resources = join(appOutDir, 'resources');
  const asar = createRequire(import.meta.url)('@electron/asar');
  verifyCommunityHostPort(asar.extractFile(join(resources, 'app.asar'),
    join('dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js')));
  const shell = await verifyOfficialShellAsar(join(resources, 'app.asar'));
  assert.equal(shell.receiptSha256, prepared.shellReceiptSha256, 'Packaged shell receipt differs from build record');
  assert.equal(createHash('sha256').update(readFileSync(join(staging, 'shell-dependency-receipt.json'))).digest('hex'), prepared.shellReceiptSha256);
  assert.equal(createHash('sha256').update(readFileSync(join(dsh, 'pnpm-lock.yaml'))).digest('hex'), prepared.runtimeLockSha256);
  console.log('Frozen shell ASAR:', shell);
  const code = windowsCode.length ? windowsCode : (await windowsRuntimeCode(dsh)).map(file => relative(dsh, file));
  await verifyWindowsAsarUnpack(dsh, resources, code);
  const sourceRequire = createRequire(join(source, 'package.json'));
  const { tsImport } = await import(pathToFileURL(sourceRequire.resolve('tsx/esm/api')));
  const { smokePreparedRuntime } = await tsImport(pathToFileURL(join(scripts, 'smoke-prepared-runtime.ts')).href, import.meta.url);
  await smokePreparedRuntime(join(resources, 'app.asar/dsh'), join(appOutDir, 'DeepSeekHarness.exe'),
    join(resources, 'runtime'), descriptor);
  console.log('Packaged path inventory:', await windowsApplicationPathBudget(appOutDir));
}
export default {
  extends: null,
  electronVersion: officialLock.electron,
  appId: 'com.deepseek.harness.desktop', productName: 'DeepSeek Harness Desktop',
  directories: { app: staging, output: join(root, 'release') },
  asar: true, ...officialDependencyHooks, electronDist: join(paths, 'electron'),
  electronFuses: { runAsNode: true },
  files: ['lib/**/*', 'renderer/**/*', 'desktop/*.cjs', 'package.json', 'official.lock.json', 'LICENSE.official', 'shell-dependency-receipt.json',
    '!desktop/*.test.cjs', { from: dsh, to: 'dsh', filter: ['**/*'] },
    { from: join(staging, 'node_modules'), to: 'node_modules', filter: ['**/*'] },
    { from: join(dsh, 'node_modules'), to: 'dsh/node_modules', filter: ['**/*'] }],
  asarUnpack: ['**/*.{node,dll,exe,so,dylib}', '**/node_modules/@deepseek-ai/libreoffice-kit-win32-x64/**/*'],
  extraResources: [{ from: join(paths, 'runtime'), to: 'runtime' },
    { from: join(source, 'apps/desktop/resources/icon-windows.png'), to: 'icon.png' },
    { from: join(source, 'apps/desktop/resources/tray-windows.ico'), to: 'tray.ico' },
    { from: join(root, 'desktop'), to: 'recovery', filter: ['recovery.cjs', 'watchdog.cjs'] }],
  beforePack: async context => {
    const directories = await officePackageDirectories(dsh, { platform: 'win32', arch: 'x64' });
    context.packager.config.asarUnpack.push(...directories.map(directory => `**/${relative(dsh, directory).replaceAll('\\', '/')}/**/*`));
    windowsCode = await prepareWindowsAsarUnpack(context, dsh);
  },
  afterPack: async context => {
    await verifyPackagedOfficial(context.appOutDir);
    assert.equal(context.packager.appInfo.name, communityPackageName);
    await writeCommunityUpdateConfiguration(join(context.appOutDir, 'resources'), communityPackageName);
  },
  protocols: [{ name: 'DeepSeek Harness', schemes: ['dsh'] }],
  win: { executableName: 'DeepSeekHarness', signAndEditExecutable: false, target: ['nsis'],
    icon: join(source, 'apps/desktop/resources/icon-windows.png'),
    artifactName: 'DeepSeek-Harness-Desktop-${version}-${arch}.${ext}' },
  nsis: { oneClick: false, perMachine: false, allowElevation: true, allowToChangeInstallationDirectory: false,
    include: join(root, 'build/community-installer.nsh'), installerLanguages: ['zh_CN', 'en_US'],
    createDesktopShortcut: true, createStartMenuShortcut: true, deleteAppDataOnUninstall: false },
  detectUpdateChannel: false,
  publish: [{ provider: 'github', owner: 'pyljjun2009-sketch', repo: 'deepseek-harness-desktop', channel: 'latest' }]
};
