# 只读本机启动区域诊断；兼容Windows PowerShell5.1及PowerShell7。
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$ErrorActionPreference='Stop'
$taskSource=@'
using System;
using System.Runtime.InteropServices;
[ComImport, Guid("79EAC9EE-BAF9-11CE-8C82-00AA004BA90B"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ErpReadSecurityZone {
 [PreserveSig] int SetSecuritySite(IntPtr site);
 [PreserveSig] int GetSecuritySite(out IntPtr site);
 [PreserveSig] int MapUrlToZone([MarshalAs(UnmanagedType.LPWStr)] string url, out int zone, int flags);
}
public static class ErpZoneDiagnostic {
 [DllImport("urlmon.dll")] private static extern int CoInternetCreateSecurityManager(IntPtr provider, out ErpReadSecurityZone manager, int reserved);
 public static string Read(string path) { return ReadFlags(path,0); }
 public static string ReadFlags(string path,int flags) { ErpReadSecurityZone manager; var hr=CoInternetCreateSecurityManager(IntPtr.Zero,out manager,0); if(hr<0)return "create="+hr; try{int zone;hr=manager.MapUrlToZone(path,out zone,flags);return "hr="+hr+",zone="+zone;}finally{Marshal.ReleaseComObject(manager);} }
}
'@
Add-Type -TypeDefinition $taskSource
$taskRoot=Split-Path -Parent $PSScriptRoot
$taskTargets=@($taskRoot,
 (Join-Path $taskRoot 'README.md'),(Join-Path $taskRoot 'package.json'),
 (Join-Path $taskRoot '启动系统.cmd'),(Join-Path $taskRoot '停止系统.cmd'),
 (Join-Path $taskRoot 'scripts\start-system.mjs'),
 (Join-Path $taskRoot 'node_modules\tsx\dist\cli.mjs'),$env:ComSpec)
foreach($taskFile in $taskTargets){
 [PSCustomObject]@{Path=$taskFile;Zone=[ErpZoneDiagnostic]::Read($taskFile);UrlZone=[ErpZoneDiagnostic]::Read(([Uri]$taskFile).AbsoluteUri)} | ConvertTo-Json -Compress
}