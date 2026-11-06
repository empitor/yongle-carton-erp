[CmdletBinding(SupportsShouldProcess)]
param(
  [Parameter(Mandatory)][string]$ConfigFile,
  [Parameter(Mandatory)][string]$LogDirectory,
  [string]$TaskName = 'CartonWorkshopERP',
  [string]$Node = 'node.exe',
  [PSCredential]$Credential
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$config = (Resolve-Path -LiteralPath $ConfigFile).Path
$log = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($LogDirectory)
$nodePath = (Get-Command $Node -CommandType Application).Source
if ($config.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase) -or
    $log.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase) -or $log -eq $root) {
  throw '部署配置和日志必须放在项目目录以外。'
}
if (Test-Path Env:OS) {
  if ($env:OS -ne 'Windows_NT') { throw '此脚本仅支持 Windows。' }
}
if (-not $PSCmdlet.ShouldProcess($TaskName, "注册开机计划任务，配置 $config，日志 $log")) { return }
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  throw '同名计划任务已存在。请先在维护窗口确认现有任务配置。'
}
if (-not $Credential) { $Credential = Get-Credential -Message '请输入专用 Windows 服务账号' }
if (-not $Credential) { throw '缺少 Windows 服务账号。' }
$runner = Join-Path $PSScriptRoot 'run-deployment.mjs'
$arguments = '"{0}" "{1}" "{2}"' -f $runner, $config, $log
$action = New-ScheduledTaskAction -Execute $nodePath -Argument $arguments -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
  -User $Credential.UserName -Password $Credential.GetNetworkCredential().Password -RunLevel Limited |
  Select-Object TaskName, State
