/** Stage complete Windows installations before replacing a registered application.
 * Adapted from deepseek-ai/deepseek-harness at 639ed015397290b3745d163aafe02ffee4aa3f84,
 * apps/desktop/scripts/windows-directory-installer.mjs, under the MIT license.
 */
import { copyFile, mkdir, readFile, readdir, lstat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';

// Resolve the same root installation electron-builder used by build-official.mjs.
const require = createRequire(import.meta.url);
const patched = Symbol.for('deepseek-harness-desktop/community-directory-installer');

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`Community installer: unsupported NSIS template: ${before}`);
  return source.replace(before, after);
}

/** Keep registration and shortcuts after complete payload extraction and directory promotion. */
export function communityInstallSection(source) {
  let result = source.replaceAll('\r\n', '\n');
  result = replaceOnce(result, '!include installer.nsh', `!include installer.nsh
!macroundef extractUsing7za
!macro extractUsing7za FILE
  !insertmacro dshExtractPayload "\${FILE}"
!macroend
!macroundef uninstallOldVersion
!macro uninstallOldVersion ROOT_KEY
  !insertmacro readReg $R4 "\${ROOT_KEY}" "\${INSTALL_REGISTRY_KEY}" InstallLocation
  \${If} $R4 == $INSTDIR
    StrCpy $R0 0
    ClearErrors
  \${Else}
    Push "\${ROOT_KEY}"
    Call uninstallOldVersion
  \${EndIf}
!macroend`);
  result = replaceOnce(result, '!insertmacro setLinkVars', '!insertmacro setLinkVars\n!insertmacro dshStageApplication');
  result = replaceOnce(result, '!insertmacro installApplicationFiles', `Call dshPromoteDirectories
IfErrors 0 +4
  SetErrorLevel 2
  MessageBox MB_OK|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDOK
  Quit`);
  return replaceOnce(result, '!ifdef UNINSTALLER_ICON\n  File /oname=uninstallerIcon.ico "${UNINSTALLER_ICON}"\n!endif\n', '');
}

/** Clean installer-owned staging and restore a renamed predecessor on normal abort paths. */
export function communityInstallerExits(source) {
  return source.replaceAll(/^(\s*)Quit\s*$/gm,
    '$1!ifndef BUILD_UNINSTALLER\n$1Call dshCleanupDirectories\n$1!endif\n$1Quit');
}

/** Enable long-path application removal while keeping upstream optional user-data cleanup. */
export function communityUninstaller(source) {
  return replaceOnce(source.replaceAll('\r\n', '\n'), 'RMDir /r $INSTDIR', 'RMDir /r "\\\\?\\$INSTDIR"');
}

/** Install an idempotent, version-checked patch on this project's actual NSIS builder class. */
export function installWindowsCommunityInstaller() {
  const manifest = require('app-builder-lib/package.json');
  if (manifest.version !== '26.15.3') throw new Error(`Community installer: qualify builder ${manifest.version} before use`);
  require('app-builder-lib');
  const { NsisTarget } = require('app-builder-lib/out/targets/nsis/NsisTarget.js');
  const prototype = NsisTarget.prototype;
  if (prototype[patched]) return;
  const templates = join(dirname(require.resolve('app-builder-lib/package.json')), 'templates/nsis');
  const { getPath7za } = require('app-builder-lib/out/toolsets/7zip.js');
  const compute = prototype.computeFinalScript;
  prototype.computeFinalScript = async function (source, ...args) {
    const directory = join(this.outDir, '.nsis-community-installer');
    await mkdir(directory, { recursive: true });
    const section = join(directory, 'installSection.nsh');
    await writeFile(section, communityInstallSection(await readFile(join(templates, 'installSection.nsh'), 'utf8')));
    const sourceTool = await getPath7za();
    const tool = join(directory, '7za.exe');
    await copyFile(sourceTool, tool);
    await this.packager.signIf(tool);
    let adapted = replaceOnce(source, '!include "installSection.nsh"', `!include "${section}"`);
    for (const name of ['allowOnlyOneInstallerInstance.nsh', 'installUtil.nsh']) {
      const helper = join(directory, name);
      await writeFile(helper, communityInstallerExits(await readFile(join(templates, 'include', name), 'utf8')));
      adapted = replaceOnce(adapted, `!include "${name}"`, `!include "${helper}"`);
    }
    const uninstaller = join(directory, 'uninstaller.nsh');
    await writeFile(uninstaller, communityUninstaller(await readFile(join(templates, 'uninstaller.nsh'), 'utf8')));
    adapted = replaceOnce(adapted, '!include "uninstaller.nsh"', `!include "${uninstaller}"`);
    return `!define DSH_SEVENZIP_PATH "${tool}"\n!define DSH_SEVENZIP_LICENSE_DIR "${dirname(dirname(sourceTool))}"\n${await compute.call(this, adapted, ...args)}`;
  };
  prototype[patched] = true;
}

/** Inventory final physical application paths, refusing links into a build checkout or store.
 * @param {string} application - Final win-unpacked directory.
 * @returns {Promise<{ longestRelativePath: string, longestRelativeLength: number, legacyMaxInstallDirectoryLength: number, stagingSuffixLength: number }>} Diagnostic path budget for final extraction tests.
 */
export async function windowsApplicationPathBudget(application) {
  const root = resolve(application);
  let longestRelativePath = '';
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      const stat = await lstat(file);
      if (stat.isSymbolicLink()) throw new Error(`Community installer: linked application path ${relative(root, file)}`);
      if (stat.isDirectory()) await visit(file);
      else if (stat.isFile()) {
        const name = relative(root, file);
        if (name.length > longestRelativePath.length) longestRelativePath = name;
      } else throw new Error(`Community installer: unsupported filesystem entry ${relative(root, file)}`);
    }
  }
  await visit(root);
  // NSIS's legacy decoder is no longer used; this value is diagnostic, not a new hard limit.
  return { longestRelativePath, longestRelativeLength: longestRelativePath.length,
    legacyMaxInstallDirectoryLength: 259 - 1 - longestRelativePath.length,
    stagingSuffixLength: '.new-{00000000-0000-0000-0000-000000000000}'.length };
}
