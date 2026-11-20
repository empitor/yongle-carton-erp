# 在当前 PowerShell 会话里临时设好 Rust 工具链（不改系统 PATH，关掉窗口就没了）。
# 用法：. .\scripts\env.ps1            （默认工具目录 %LOCALAPPDATA%\YongleToolchains\rust）
#       . .\scripts\env.ps1 -Root D:\x  （工具放在别处时）
# 另外需要：Node.js 24（npx tauri）、Visual Studio 2022 生成工具的“使用 C++ 的桌面开发”、WebView2 运行库（Win10/11 自带）。
param([string]$Root = (Join-Path $env:LOCALAPPDATA 'YongleToolchains\rust'))

$cargo = Join-Path $Root 'cargo'
if (-not (Test-Path (Join-Path $cargo 'bin\cargo.exe'))) { throw "找不到 $cargo\bin\cargo.exe，先按 docs/构建与测试.md 准备工具链" }
$env:RUSTUP_HOME = Join-Path $Root 'rustup'
$env:CARGO_HOME = $cargo
$env:Path = (Join-Path $cargo 'bin') + ';' + $env:Path
Write-Host "RUSTUP_HOME=$env:RUSTUP_HOME"
Write-Host "CARGO_HOME=$env:CARGO_HOME"
