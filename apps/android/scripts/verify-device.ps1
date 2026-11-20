# 安卓外壳真机验证：只用 adb 和 JDK 自带的 jwebserver，像人一样看屏幕上的字、点、按返回键，再查手机“下载”文件夹里文件到底有没有。
# 前提：手机开了 USB 调试并已授权；测试版（cn.nbyongle.erp.test）已装好（vivo 等手机 adb install 会被拦，见 docs/构建与测试.md）。
# 用法：. .\scripts\env.ps1; .\scripts\verify-device.ps1 [-Install] [-OutDir 截图目录]
# 结果：每项打印“通过 / 不通过 / 观察”，有不通过的退出码为 1。只用 test-site/ 的虚构页面，不碰 ERP。
param(
    [switch]$Install,
    [string]$OutDir = (Join-Path ([IO.Path]::GetTempPath()) 'yongle-android-verify')
)
$ErrorActionPreference = 'Stop'
$Package = 'cn.nbyongle.erp.test'
$Activity = "$Package/cn.nbyongle.erp.MainActivity"
$Port = 8787
$Site = Join-Path $PSScriptRoot '..\test-site' | Resolve-Path
$Apk = Join-Path $PSScriptRoot '..\app\build\outputs\apk\debug\app-debug.apk'
$Downloads = '/sdcard/Download'
$TestFiles = @('yongle-blob-test.txt', 'yongle-http-test.bin', 'sample-download.bin')
$script:Results = @()
$script:Server = $null
New-Item -ItemType Directory -Force $OutDir | Out-Null
$SiteLog = Join-Path $OutDir 'site.log'

function Record([string]$Name, [string]$State, [string]$Detail = '') {
    $script:Results += [pscustomobject]@{ 项目 = $Name; 结果 = $State; 说明 = $Detail }
    Write-Host "[$State] $Name $Detail"
}
function Check([string]$Name, [bool]$Ok, [string]$Detail = '') {
    Record $Name ($(if ($Ok) { '通过' } else { '不通过' })) $Detail
}
function AdbText {
    # adb 输出是 UTF-8；pwsh 默认按系统代码页（GBK）解读，会把中文后面紧跟的英文字母吞掉，所以调用时临时按 UTF-8 读
    $previous = [Console]::OutputEncoding
    [Console]::OutputEncoding = [Text.Encoding]::UTF8
    try { (& adb.exe @args 2>&1 | Out-String).Trim() } finally { [Console]::OutputEncoding = $previous }
}
function Shell([string]$Command) { AdbText shell $Command }

function Start-Site {
    # 端口被别的进程占着时，停不掉它，离线那一步就测不准，所以直接报错
    if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
        throw "电脑上的 $Port 端口已被占用，先关掉占用它的程序"
    }
    $jweb = Join-Path $env:JAVA_HOME 'bin\jwebserver.exe'
    $args_ = @('-b', '127.0.0.1', '-p', "$Port", '-d', "`"$Site`"", '-o', 'info')
    $script:Server = Start-Process $jweb -ArgumentList $args_ -RedirectStandardOutput $SiteLog `
        -RedirectStandardError "$SiteLog.err" -PassThru -WindowStyle Hidden
    Start-Sleep -Seconds 2
}
function Stop-Site {
    if ($script:Server -and -not $script:Server.HasExited) { Stop-Process -Id $script:Server.Id -Force }
    Start-Sleep -Seconds 1
}

function Read-Screen {
    Shell 'uiautomator dump /sdcard/yongle-window.xml' | Out-Null
    $file = Join-Path $OutDir 'window.xml'
    adb.exe exec-out cat /sdcard/yongle-window.xml > $file
    ([xml](Get-Content $file -Raw -Encoding UTF8)).SelectNodes('//node')
}
function Find-Label([string]$Label) {
    Read-Screen | Where-Object { $_.text -eq $Label -or $_.'content-desc' -eq $Label } | Select-Object -First 1
}
function Wait-Label([string]$Label, [int]$Seconds = 15) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        if (Find-Label $Label) { return $true }
        Start-Sleep -Milliseconds 700
    }
    return $false
}
function Tap-Label([string]$Label) {
    # uiautomator 偶尔读回空界面，先等这个字出现再点
    Wait-Label $Label 10 | Out-Null
    $node = Find-Label $Label
    if (-not $node) { throw "屏幕上找不到「$Label」" }
    $n = [regex]::Matches($node.bounds, '\d+') | ForEach-Object { [int]$_.Value }
    Shell "input tap $([int](($n[0] + $n[2]) / 2)) $([int](($n[1] + $n[3]) / 2))" | Out-Null
}
function Top-Package {
    $line = Shell 'dumpsys activity activities' -split "`n" | Where-Object { $_ -match 'topResumedActivity|mResumedActivity' } |
        Select-Object -First 1
    if ($line -match '\s([\w.]+)/') { $Matches[1] } else { '' }
}
function Shot([string]$Name) { adb.exe exec-out screencap -p > (Join-Path $OutDir "$Name.png") }

# 截一张图，比状态栏左上角（避开时间图标）和网页顶部往下 20 像素处的颜色是否一样
function Test-BarColor([string]$Name, [string]$Shot) {
    Start-Sleep -Seconds 1
    Shot $Shot
    $web = Read-Screen | Where-Object { $_.class -eq 'android.webkit.WebView' } | Select-Object -First 1
    $webTop = ([regex]::Matches($web.bounds, '\d+') | ForEach-Object { [int]$_.Value })[1]
    Add-Type -AssemblyName System.Drawing
    $image = [Drawing.Bitmap]::FromFile((Join-Path $OutDir "$Shot.png"))
    try {
        $bar = $image.GetPixel(4, 4).ToArgb().ToString('X8')
        $page = $image.GetPixel(4, $webTop + 20).ToArgb().ToString('X8')
    } finally { $image.Dispose() }
    Check $Name ($bar -eq $page) "状态栏 #$bar，网页顶部 #$page"
}
function Launch { Shell "am start -W -n $Activity" | Out-Null }
function Device-File([string]$Name) { (Shell "ls $Downloads/$Name 2>/dev/null") -eq "$Downloads/$Name" }

function Prepare {
    if ((AdbText devices) -notmatch "`tdevice") { throw '没有连上已授权的手机' }
    # 屏幕熄了读不到界面：先点亮；锁着屏（带密码）脚本解不开，要人先解锁
    Shell 'input keyevent KEYCODE_WAKEUP' | Out-Null
    Shell 'wm dismiss-keyguard' | Out-Null
    Start-Sleep -Seconds 1
    # 锁屏时焦点在系统界面的 NotificationShade 上（vivo 上实测），各家的 keyguard 标记写法不一，一并认
    if ((Shell 'dumpsys window') -match 'mCurrentFocus=.*NotificationShade|isKeyguardShowing=true|mShowingLockscreen=true') {
        throw '手机锁着屏，先解锁（开发者选项里开“保持唤醒状态”可免得中途熄屏）'
    }
    if ($Install) { AdbText install -r -t $Apk | Write-Host }
    if ((Shell "pm path --user 0 $Package") -notmatch 'package:') { throw "手机上没装测试版 $Package" }
    foreach ($f in $TestFiles) { Shell "rm -f $Downloads/$f" | Out-Null }
    Shell "am force-stop $Package" | Out-Null
    Shell "pm clear --user 0 $Package" | Out-Null
    AdbText logcat -c | Out-Null
    AdbText reverse "tcp:$Port" "tcp:$Port" | Out-Null
    Start-Site
}

function Test-OpenAndFill {
    Launch
    Check '打开测试网址' (Wait-Label '外壳测试首页') "测试页 http://127.0.0.1:$Port/"
    Shot '01-home'
    $screen = (Shell 'wm size') -replace '.*:\s*', ''
    $width = [int]($screen -split 'x')[0]
    $web = Read-Screen | Where-Object { $_.class -eq 'android.webkit.WebView' } | Select-Object -First 1
    $n = [regex]::Matches($web.bounds, '\d+') | ForEach-Object { [int]$_.Value }
    $others = Read-Screen | Where-Object { $_.package -and $_.package -ne $Package -and $_.package -ne 'com.android.systemui' }
    Check '网页铺满、没有浏览器界面' (($n[2] - $n[0]) -eq $width -and -not $others) "网页区域 $($web.bounds)，屏幕 $screen"
    Test-BarColor '状态栏底色跟网页顶部一致' '01-bar-color'
}

function Test-BackKey {
    Tap-Label '进入第二页'
    Check '站内跳转留在应用里' ((Wait-Label '外壳测试第二页') -and (Top-Package) -eq $Package)
    # 测试页的 bridge.js 代替 ERP 回答返回键：第二页回首页（handled），首页回 home
    Shell 'input keyevent KEYCODE_BACK' | Out-Null
    Check '返回键按网页回执回到首页' ((Wait-Label '外壳测试首页') -and (Top-Package) -eq $Package)
    Shell 'input keyevent KEYCODE_BACK' | Out-Null
    Start-Sleep -Seconds 3
    Check '首页按一次返回只提示，不退出' ((Top-Package) -eq $Package) "当前前台：$(Top-Package)"
    Shell 'input keyevent KEYCODE_BACK' | Out-Null
    Start-Sleep -Milliseconds 400
    Shell 'input keyevent KEYCODE_BACK' | Out-Null
    Start-Sleep -Seconds 2
    Check '首页 2 秒内连按两次返回才退出' ((Top-Package) -ne $Package) "当前前台：$(Top-Package)"
    Launch
    Check '再打开回到测试首页' (Wait-Label '外壳测试首页')
}

function Test-ExternalLink {
    Tap-Label '打开外部网页'
    Start-Sleep -Seconds 5
    $front = Top-Package
    $opened = (Get-Content $SiteLog -Raw) -match 'GET /external\.html'
    # 没设默认浏览器的手机会先弹系统的“打开方式”，这也说明外壳已经把网址交给系统了
    $chooser = [bool](Find-Label '打开方式')
    Shot '02-external'
    $handed = $opened -or $chooser -or $front -ne $Package
    Check '外部网页交给系统浏览器' $handed "前台：$front；浏览器打开了测试页：$opened；弹出打开方式：$chooser"
    if ($chooser) { Shell 'input keyevent KEYCODE_BACK' | Out-Null }
    Launch
    Check '回到应用时页面没被外部网页替换' (Wait-Label '外壳测试首页')
}

function Test-Downloads {
    Tap-Label '下载 blob 文件'
    # 有的手机日志缓冲很快被挤满，点完马上反复查外壳那一行
    $logged = $false
    foreach ($i in 1..12) {
        if ((AdbText logcat -d -s YongleShell) -match 'blob') { $logged = $true; break }
        Start-Sleep -Milliseconds 500
    }
    Start-Sleep -Seconds 3
    $blobSaved = Device-File 'yongle-blob-test.txt'
    Record 'blob: 下载是否落盘' '观察' "文件在「下载」里：$blobSaved；外壳收到 blob 地址并记日志：$logged"
    Tap-Label '下载服务器文件'
    $name = $null
    foreach ($i in 1..20) {
        $name = @('yongle-http-test.bin', 'sample-download.bin') | Where-Object { Device-File $_ } | Select-Object -First 1
        if ($name) { break }
        Start-Sleep -Seconds 1
    }
    $same = $name -and ((AdbText exec-out cat "$Downloads/$name" | Out-String).Trim() -eq 'YONGLE-SHELL-HTTP-TEST')
    Check '普通 http 下载真的存进“下载”文件夹' ([bool]$same) "文件名：$name"
    Check '下载后没有误盖离线页' (-not (Find-Label '暂时无法连接 ERP') -and [bool](Find-Label '外壳测试首页'))
}

function Test-Offline {
    Stop-Site
    # 清掉应用数据（含网页缓存），模拟第一次打开就连不上；测试页不带缓存头，不清会直接从缓存显示
    Shell "am force-stop $Package" | Out-Null
    Shell "pm clear --user 0 $Package" | Out-Null
    Launch
    $shown = Wait-Label '暂时无法连接 ERP' 20
    Shot '03-offline'
    Check '连不上时显示“暂时无法连接 ERP”和“重试”' ($shown -and [bool](Find-Label '重试'))
    Test-BarColor '离线页的状态栏底色也跟着变' '04-offline-bar-color'
    Start-Site
    Tap-Label '重试'
    Check '点“重试”后恢复打开网页' (Wait-Label '外壳测试首页' 20)
}

function Cleanup {
    foreach ($f in $TestFiles) { Shell "rm -f $Downloads/$f" | Out-Null }
    Shell 'rm -f /sdcard/yongle-window.xml' | Out-Null
    AdbText reverse --remove "tcp:$Port" | Out-Null
    Stop-Site
}

try {
    Prepare
    Test-OpenAndFill
    Test-BackKey
    Test-ExternalLink
    Test-Downloads
    Test-Offline
} catch {
    Record '验证中断' '不通过' $_.Exception.Message
} finally {
    Cleanup
}
$script:Results | Format-Table -AutoSize | Out-String -Width 200 | Write-Host
$script:Results | Export-Csv (Join-Path $OutDir 'results.csv') -NoTypeInformation -Encoding utf8
Write-Host "截图、日志和结果表（results.csv）：$OutDir"
if ($script:Results.结果 -contains '不通过') { exit 1 }
