; Community recovery edition. Directory transaction adapted from the official
; DeepSeek Harness source at 639ed015397290b3745d163aafe02ffee4aa3f84 (MIT).
; Uses complete 7za.exe for long-path extraction, not the legacy NSIS decoder.
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "${__FILEDIR__}\community-process-guard.nsh"

; Read-only enumeration. FileExists "$INSTDIR\*.*" means the directory exists,
; not that it has entries. Distinguish normal empty enumeration from read errors.
; $R0 is missing, empty, nonempty, or unknown; unknown must never be accepted.
!ifndef BUILD_UNINSTALLER
Function dshInspectInstallDirectory
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  StrCpy $R0 "unknown"
  System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR") i.r0 ?e'
  Pop $1
  ${If} $0 == -1
    ${If} $1 == 2
    ${OrIf} $1 == 3
      StrCpy $R0 "missing"
    ${EndIf}
  ${Else}
    IntOp $5 $0 & 0x410
    ; A physical directory only: refuse regular files and selected reparse points.
    ${If} $5 == 16
      ; WIN32_FIND_DATAW is 592 bytes; cFileName starts at byte 44.
      System::Alloc 592
      Pop $2
      ${If} $2 != 0
        System::Call 'kernel32::FindFirstFileW(w "$INSTDIR\*.*", p r2) p.r3 ?e'
        Pop $1
        ${If} $3 == -1
          ${If} $1 == 2
            StrCpy $R0 "empty"
          ${EndIf}
        ${Else}
          ${Do}
            System::Call '*$2(i,l,l,l,i,i,i,i,&w260 .r4)'
            ${If} $4 == ""
              ; An empty filename after a successful find is an invalid result.
              ${ExitDo}
            ${ElseIf} $4 != "."
            ${AndIf} $4 != ".."
              StrCpy $R0 "nonempty"
              ${ExitDo}
            ${EndIf}
            System::Call 'kernel32::FindNextFileW(p r3, p r2) i.r0 ?e'
            Pop $1
            ${If} $0 == 0
              ${If} $1 == 18
                ; ERROR_NO_MORE_FILES is the only successful end of enumeration.
                StrCpy $R0 "empty"
              ${EndIf}
              ${ExitDo}
            ${EndIf}
          ${Loop}
          System::Call 'kernel32::FindClose(p r3) i.r0'
          ${If} $0 == 0
            StrCpy $R0 "unknown"
          ${EndIf}
        ${EndIf}
        System::Free $2
      ${EndIf}
    ${EndIf}
  ${EndIf}
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd
!endif

!macro customInit
  ; Never replace a drive/share root or an unregistered nonempty directory.
  ; Keep the literal root check: NSIS can trim repeated separators to "C:",
  ; which GetFullPathName would otherwise interpret as a drive-relative directory.
  StrCpy $2 0
  ${GetRoot} "$INSTDIR" $0
  ${If} $INSTDIR == $0
  ${OrIf} $INSTDIR == "$0\"
    StrCpy $2 1
  ${EndIf}
  ; Normalize only for validation. Do not change the selected transaction target.
  System::Call 'kernel32::GetFullPathNameW(w "$INSTDIR", i ${NSIS_MAX_STRLEN}, w .r1, p 0) i.r0'
  ${If} $0 == 0
  ${OrIf} $0 >= ${NSIS_MAX_STRLEN}
    MessageBox MB_OK|MB_ICONSTOP "无法可靠确认安装位置，安装已停止。请使用有效的空目录后重试。" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
  ${GetRoot} "$1" $0
  ${If} $2 == 1
  ${OrIf} $1 == $0
  ${OrIf} $1 == "$0\"
    MessageBox MB_OK|MB_ICONSTOP "安装位置不能是磁盘或共享根目录。" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
  ${If} ${isForAllUsers}
    MessageBox MB_OK|MB_ICONSTOP "此社区版仅支持为当前用户安装。" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
  Call dshInspectInstallDirectory
  ${If} $R0 == "unknown"
    MessageBox MB_OK|MB_ICONSTOP "无法可靠读取安装位置，安装已停止。请使用可访问的空目录后重试。" /SD IDOK
    SetErrorLevel 2
    Quit
  ${ElseIf} $R0 == "nonempty"
    ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${If} $0 != $INSTDIR
      MessageBox MB_OK|MB_ICONSTOP "安装位置已有文件且不是已登记的安装目录，请使用新的空目录。" /SD IDOK
      SetErrorLevel 2
      Quit
    ${EndIf}
  ${EndIf}
!macroend

!ifndef BUILD_UNINSTALLER
  !include "${__FILEDIR__}\community-installer-directories.nsh"
!endif

!macro customInstall
  !insertmacro dshFinishDirectories
!macroend
