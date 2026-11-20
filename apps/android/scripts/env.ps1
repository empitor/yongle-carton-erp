# 在当前 PowerShell 会话里临时设好安卓构建要的环境变量（不改系统 PATH，关掉窗口就没了）。
# 用法：. .\scripts\env.ps1            （默认工具目录 %LOCALAPPDATA%\YongleToolchains\android）
#       . .\scripts\env.ps1 -Root D:\x  （工具放在别处时）
# 工具目录里要有：jdk\（JDK 21）、sdk\（Android SDK：platform-tools、platforms/android-36、build-tools/36.0.0）。
param([string]$Root = (Join-Path $env:LOCALAPPDATA 'YongleToolchains\android'))

$jdk = Join-Path $Root 'jdk'
$sdk = Join-Path $Root 'sdk'
foreach ($dir in @($jdk, $sdk)) {
    if (-not (Test-Path $dir)) { throw "找不到 $dir，先按 docs/构建与测试.md 准备工具链" }
}
$env:JAVA_HOME = $jdk
$env:ANDROID_HOME = $sdk
$env:GRADLE_USER_HOME = Join-Path $Root 'gradle-home'
$env:Path = (Join-Path $jdk 'bin') + ';' + (Join-Path $sdk 'platform-tools') + ';' + $env:Path
Write-Host "JAVA_HOME=$env:JAVA_HOME"
Write-Host "ANDROID_HOME=$env:ANDROID_HOME"
Write-Host "GRADLE_USER_HOME=$env:GRADLE_USER_HOME"
