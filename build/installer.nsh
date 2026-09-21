; Windows NSIS extraction may silently omit deeply nested DSH dependencies
; when the complete destination path exceeds MAX_PATH. The longest path in
; the packaged application is 185 characters relative to $INSTDIR, including
; the separator. Keeping $INSTDIR at 74 chars or less leaves total <= 259.
!macro customInit
  StrLen $0 $INSTDIR
  IntCmp $0 74 valid_install_path valid_install_path invalid_install_path

  invalid_install_path:
    IfSilent +2
    MessageBox MB_ICONSTOP|MB_TOPMOST "安装路径过长，可能导致 DeepSeek Harness 缺少文件。请选择更短的路径。"
    SetErrorLevel 2
    Quit

  valid_install_path:
!macroend
