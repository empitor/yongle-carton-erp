; 安装包的钩子（tauri.conf.json 的 bundle.windows.nsis.installerHooks）。
; 安装包的主程序是启动器（甬勒ERP.exe），模板只管它；客户端核心 yongle_erp_core.dll 是 cargo 编出来的库，
; 不能写进 bundle.resources（tauri-build 编译时就要复制资源，那时 dll 还没编出来），所以在这里装、在这里删。
; 宏在模板插入它的地方才展开，那时模板已经定义了 MAINBINARYSRCPATH（编出来、按 mainBinaryName 改过名的启动器的
; 完整路径），核心 dll 和它在同一个目录（target\release\）。

; 模板已经请正在运行的程序（加载着核心 dll 的 甬勒ERP.exe）退出，这时 dll 才能覆盖
!macro NSIS_HOOK_POSTINSTALL
  !searchreplace CORE_DLL "${MAINBINARYSRCPATH}" "${MAINBINARYNAME}.exe" "yongle_erp_core.dll"
  File "/oname=$INSTDIR\yongle_erp_core.dll" "${CORE_DLL}"
!macroend

; 开机自启的登记（tauri-plugin-autostart 经 auto-launch 写在当前用户下，值名是 productName，即 ${PRODUCTNAME}）：
; Run 里的启动命令，和任务管理器“启动应用”的开关 StartupApproved\Run。模板只删前一项，这里两项都删。
; 升级（/UPDATE）时不删，保留用户勾的选择。$UpdateMode 是模板在卸载程序 un.onInit 里设的变量
!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$INSTDIR\yongle_erp_core.dll"
  RMDir "$INSTDIR"
  ${If} $UpdateMode <> 1
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCTNAME}"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "${PRODUCTNAME}"
  ${EndIf}
!macroend
