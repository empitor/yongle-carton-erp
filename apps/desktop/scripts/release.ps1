# 打 Windows 客户端的正式安装包：打包、给更新包签名、写好版本清单，都放进输出目录（不上传）。
# 用法：.\scripts\release.ps1 -Keys <放密钥的目录> -Out <输出目录> -Notes "这次改了什么"
# <放密钥的目录> 在仓库外，里面要有更新签名私钥 yongle-erp.key 和加密保存的密码 signing-passwords.clixml
# （怎么生成、怎么存见 docs/构建与测试.md“正式更新签名密钥”）。密码只在本进程的环境变量里用，不显示、不落盘。
param(
  [Parameter(Mandatory)][string]$Keys,
  [Parameter(Mandatory)][string]$Out,
  [string]$Notes = ''
)
$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'env.ps1') | Out-Null

$config = Get-Content -LiteralPath (Join-Path $project 'config\app.json') -Raw | ConvertFrom-Json
if (-not $config.updateUrl -or -not $config.updatePubkey) { throw 'config\app.json 里的 updateUrl、updatePubkey 要先填好' }
$version = (Get-Content -LiteralPath (Join-Path $project 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json).version

# 公钥也要写进打包配置（Tauri 签名时核对它），只在这次打包时加
$overrides = Join-Path ([IO.Path]::GetTempPath()) "yongle-erp-release-$PID.conf.json"
@{ bundle = @{ createUpdaterArtifacts = $true }; plugins = @{ updater = @{ pubkey = $config.updatePubkey } } } |
  ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $overrides -Encoding utf8

$password = (Import-Clixml -LiteralPath (Join-Path $Keys 'signing-passwords.clixml')).desktop
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -LiteralPath (Join-Path $Keys 'yongle-erp.key') -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = [Net.NetworkCredential]::new('', $password).Password
Push-Location $project
try {
  npx tauri build --no-binary-patching --config $overrides -- --lib
  if ($LASTEXITCODE -ne 0) { throw "打包没成（退出码 $LASTEXITCODE）" }
} finally {
  Pop-Location
  Remove-Item Env:\TAURI_SIGNING_PRIVATE_KEY, Env:\TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $overrides -ErrorAction SilentlyContinue
}

# 安装包按版本起名、只用字母数字（服务器上的文件名规矩），清单的地址和 updateUrl 在同一个目录
$built = Join-Path $project "src-tauri\target\release\bundle\nsis\甬勒ERP_${version}_x64-setup.exe"
$name = "yongle-erp-$version-x64-setup.exe"
New-Item -ItemType Directory -Force -Path $Out | Out-Null
Copy-Item -LiteralPath $built -Destination (Join-Path $Out $name) -Force
$base = $config.updateUrl.Substring(0, $config.updateUrl.LastIndexOf('/') + 1)
[ordered]@{
  version   = $version
  notes     = $Notes
  pub_date  = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  platforms = [ordered]@{ 'windows-x86_64' = [ordered]@{ signature = (Get-Content -LiteralPath "$built.sig" -Raw).Trim(); url = $base + $name } }
} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $Out 'latest.json') -Encoding utf8
Write-Host "版本 $version：安装包和清单在 $Out（先传安装包、确认能下载，再传 latest.json）"
