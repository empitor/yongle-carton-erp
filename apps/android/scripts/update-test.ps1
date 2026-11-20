# 应用内更新的本机测试（不发布、不上传、不碰正式服务器）：
#   打包：打两个测试版，旧版用 gradle.properties 里的版本号，新版版本号加 1，两个都用本机的调试签名（同一签名才能覆盖安装）；
#         新版安装包和版本清单放进 OutDir\site\update\，旧版留在 OutDir 里给人先装。
#   -Serve：用 JDK 自带的 jwebserver 在本机 8787 端口提供 OutDir\site，并用 adb reverse 让手机的 127.0.0.1:8787 连到电脑上
#           （测试版的版本清单地址见 gradle.properties 的 testUpdateUrl），按 Ctrl+C 结束。
# 用法：. .\scripts\env.ps1; .\scripts\update-test.ps1 [-ErpUrl 测试版打开的网址] [-OutDir 目录]
#       .\scripts\update-test.ps1 -Serve [-OutDir 目录]
param(
    [string]$ErpUrl = 'http://127.0.0.1:3198/',
    [string]$OutDir = (Join-Path ([IO.Path]::GetTempPath()) 'yongle-android-update-test'),
    [switch]$Serve
)
$ErrorActionPreference = 'Stop'
$Port = 8787
$Root = Join-Path $PSScriptRoot '..' | Resolve-Path
$Site = Join-Path $OutDir 'site'
$UpdateDir = Join-Path $Site 'update'
$Manifest = Join-Path $UpdateDir 'manifest.json'

if ($Serve) {
    if (-not (Test-Path $Manifest)) { throw "没找到 $Manifest，先不带 -Serve 跑一次打包" }
    if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
        throw "电脑上的 $Port 端口已被占用，先关掉占用它的程序"
    }
    adb.exe reverse "tcp:$Port" "tcp:$Port" | Out-Null
    Write-Host "版本清单：http://127.0.0.1:$Port/update/manifest.json（Ctrl+C 结束）"
    & (Join-Path $env:JAVA_HOME 'bin\jwebserver.exe') -b 127.0.0.1 -p $Port -d $Site -o info
    return
}

function Build-Apk([int]$Code, [string]$Name) {
    Push-Location $Root
    try {
        & .\gradlew.bat assembleDebug --no-daemon -q "-PappVersionCode=$Code" "-PappVersionName=$Name" "-PerpTestUrl=$ErpUrl"
        if ($LASTEXITCODE -ne 0) { throw "测试版 $Name 没打包成功" }
    } finally { Pop-Location }
    $target = Join-Path $OutDir "yongle-erp-test-$Name.apk"
    Copy-Item (Join-Path $Root 'app\build\outputs\apk\debug\app-debug.apk') $target -Force
    return $target
}

$properties = Get-Content (Join-Path $Root 'gradle.properties') -Encoding utf8
$code = [int](($properties | Where-Object { $_ -match '^appVersionCode=' }) -replace '^appVersionCode=', '')
$name = ($properties | Where-Object { $_ -match '^appVersionName=' }) -replace '^appVersionName=', ''
$parts = $name.Split('.')
$nextName = "$($parts[0]).$([int]$parts[1] + 1).0"

New-Item -ItemType Directory -Force $UpdateDir | Out-Null
$old = Build-Apk $code $name
$new = Build-Apk ($code + 1) $nextName
$served = Join-Path $UpdateDir (Split-Path $new -Leaf)
Copy-Item $new $served -Force
$release = [ordered]@{
    versionCode = $code + 1
    versionName = $nextName
    apkUrl      = "http://127.0.0.1:$Port/update/$(Split-Path $new -Leaf)"
    sha256      = (Get-FileHash $new -Algorithm SHA256).Hash.ToLowerInvariant()
    notes       = '测试用的新版本：和旧版只差版本号。'
}
$release | ConvertTo-Json | Set-Content $Manifest -Encoding utf8NoBOM
Write-Host "旧版（先装这个）：$old"
Write-Host "新版（应用内更新会下载它）：$served"
Write-Host "版本清单：$Manifest"
