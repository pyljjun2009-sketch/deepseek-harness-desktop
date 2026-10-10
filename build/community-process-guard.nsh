; Never terminate an application during installation or uninstallation.
; nsProcess _FindProcess: 0 = found, 603 = not running; any other result is unsafe.
; https://nsis.sourceforge.io/NsProcess_plugin
; An isolated qualification installer may deliberately define its own guard first.
!ifmacrondef customCheckAppRunning
  !macro customCheckAppRunning
    Push $R0
    nsProcess::_FindProcess "${APP_EXECUTABLE_FILENAME}"
    Pop $R0
    ${If} $R0 == 0
      Pop $R0
      MessageBox MB_OK|MB_ICONSTOP "DeepSeek Harness Desktop 仍在运行。请保存工作并手动退出应用，然后重新运行安装程序。安装程序不会强制关闭应用。" /SD IDOK
      SetErrorLevel 2
      Quit
    ${ElseIf} $R0 != 603
      Pop $R0
      MessageBox MB_OK|MB_ICONSTOP "无法可靠确认 DeepSeek Harness Desktop 是否已退出，安装已停止。请手动退出应用后重试；若仍失败，请重新启动电脑。" /SD IDOK
      SetErrorLevel 2
      Quit
    ${EndIf}
    Pop $R0
  !macroend
!endif
