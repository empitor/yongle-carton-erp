import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { AiConnectionError } from './connection-error.js';

export interface SecretProtector {
  protect(secret: string): string;
  unprotect(ciphertext: string): string;
}
// CurrentUser DPAPI: Windows 管理加密密钥。传入值走 stdin，不进入命令行、文件或日志。
const script = `
$ErrorActionPreference='Stop'
try {
  Add-Type -AssemblyName System.Security
  $inputDoc = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $entropy = [Text.Encoding]::UTF8.GetBytes('ZhixuERP.AI.Credentials.v1')
  if ($inputDoc.action -eq 'protect') {
    $bytes = [Text.Encoding]::UTF8.GetBytes($inputDoc.value)
    $result = [Security.Cryptography.ProtectedData]::Protect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Console]::Out.Write([Convert]::ToBase64String($result))
    [Array]::Clear($bytes,0,$bytes.Length)
  } elseif ($inputDoc.action -eq 'unprotect') {
    $bytes = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($inputDoc.value),$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))
    [Array]::Clear($bytes,0,$bytes.Length)
  } else { exit 1 }
} catch { exit 1 }
`;
function dpapi(action: string, value: string) {
  if (process.platform !== 'win32')
    throw new AiConnectionError(
      'storage',
      '本版本密钥持久保存需要 Windows DPAPI，不会降级为明文存储。',
      503,
    );
  const executable = join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const result = spawnSync(
    executable,
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    {
      input: JSON.stringify({ action, value }),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 65536,
    },
  );
  if (result.status !== 0 || result.error || !result.stdout)
    throw new AiConnectionError(
      'storage',
      'Windows 加密凭据无法读取或保存。请使用原 Windows 用户登录，检查系统权限；已有配置未清空。',
      503,
    );
  return result.stdout.trim();
}
export const windowsProtector: SecretProtector = {
  protect: (secret) => dpapi('protect', secret),
  unprotect: (ciphertext) => dpapi('unprotect', ciphertext),
};
// 固定用户目录，与项目目录、构建目录、启动工作目录无关。
export function defaultAiSettingsPath() {
  return join(
    process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'),
    'ZhixuERP',
    'ai',
    'settings.sqlite',
  );
}
