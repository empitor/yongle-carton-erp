import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { configDirectory, masterKeyName } from '../core/index.js';
import { AiConnectionError } from './errors.js';

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
/** 带版本的密文前缀：哪种加密方式加的 */
const DPAPI_PREFIX = 'dpapi:v1:';
const AES_PREFIX = 'aes256gcm:v1:';
export const windowsProtector: SecretProtector = {
  protect: (secret) => DPAPI_PREFIX + dpapi('protect', secret),
  unprotect: (ciphertext) => {
    if (!ciphertext.startsWith(DPAPI_PREFIX)) throw platformMismatch();
    return dpapi('unprotect', ciphertext.slice(DPAPI_PREFIX.length));
  },
};
const platformMismatch = () => new AiConnectionError('storage', '凭据加密方式不属于当前平台；迁移后请重新填写 AI 密钥或机器人 Secret，原配置未清空。', 503);
const keyError = () => new AiConnectionError('storage', 'Linux 主密钥无法安全读取：目录须为当前服务账号所有且权限 0700，主密钥须为该账号所有的 0600 常规文件（32 字节、非链接）。请检查权限或恢复原主密钥；不会改用明文或覆盖原文件。', 503);

/** Linux 主密钥：目录 0700、文件 0600（只比权限位），32 字节 */
const KEY_DIR_MODE = 0o700;
const KEY_FILE_MODE = 0o600;
const PERMISSION_BITS = 0o7777;
const MASTER_KEY_BYTES = 32;
const isExisting = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'EEXIST';

/** 每次读取都检查权限和所有者；不修正已有权限，不输出路径或密钥内容。 */
export function linuxMasterKey(root = configDirectory()): Buffer {
  if (process.platform !== 'linux') throw keyError();
  const directory = join(root, 'credentials'), file = join(directory, masterKeyName);
  try {
    // Linux 上一定有 getuid；没有就当权限核对不过
    const uid = process.getuid?.();
    if (uid === undefined) throw keyError();
    for (const dir of [root, directory]) {
      try { mkdirSync(dir, { recursive: true, mode: KEY_DIR_MODE }); } catch { throw keyError(); }
      const stat = lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & PERMISSION_BITS) !== KEY_DIR_MODE) throw keyError();
    }
    let fd: number | undefined;
    try {
      fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, KEY_FILE_MODE);
      const key = randomBytes(MASTER_KEY_BYTES);
      try { writeFileSync(fd, key); fsyncSync(fd); } finally { key.fill(0); }
    } catch (error) {
      if (!isExisting(error)) throw keyError();
    } finally { if (fd !== undefined) closeSync(fd); }
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || (stat.mode & PERMISSION_BITS) !== KEY_FILE_MODE || stat.size !== MASTER_KEY_BYTES) throw keyError();
      return readFileSync(fd);
    } finally { closeSync(fd); }
  } catch { throw keyError(); }
}

/** AES-256-GCM 密文的排法：12 字节随机 IV、16 字节认证标签，后面是加密的内容 */
const IV_BYTES = 12;
const TAG_BYTES = 16;
const TAG_END = IV_BYTES + TAG_BYTES;
const AES_AAD = 'ZhixuERP.credentials.aes256gcm.v1';

/** keyProvider 返回调用方持有的临时副本，用后清零；随机 IV 和认证标签均存于带版本的密文中。 */
export function aesProtector(keyProvider: () => Buffer): SecretProtector {
  return {
    protect(secret) {
      const key = keyProvider();
      try {
        const iv = randomBytes(IV_BYTES), cipher = createCipheriv('aes-256-gcm', key, iv);
        cipher.setAAD(Buffer.from(AES_AAD));
        const bytes = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
        return AES_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64');
      } finally { key.fill(0); }
    },
    unprotect(ciphertext) {
      if (!ciphertext.startsWith(AES_PREFIX)) throw platformMismatch();
      const key = keyProvider();
      try {
        const encoded = ciphertext.slice(AES_PREFIX.length), bytes = Buffer.from(encoded, 'base64');
        if (bytes.length < TAG_END || bytes.toString('base64') !== encoded) throw new Error();
        const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, IV_BYTES));
        cipher.setAAD(Buffer.from(AES_AAD));
        cipher.setAuthTag(bytes.subarray(IV_BYTES, TAG_END));
        return Buffer.concat([cipher.update(bytes.subarray(TAG_END)), cipher.final()]).toString('utf8');
      } catch { throw new AiConnectionError('storage', 'Linux 凭据无法解密或校验失败，请确认使用原主密钥；迁移后请重新填写凭据，原配置未清空。', 503); }
      finally { key.fill(0); }
    },
  };
}
export const platformProtector: SecretProtector = process.platform === 'win32' ? windowsProtector : aesProtector(() => linuxMasterKey());
/** 在取得业务库锁、打开数据库和监听端口之前调用，权限不合格就拒绝启动。 */
export function initializeCredentialProtection() {
  if (process.platform === 'linux') linuxMasterKey().fill(0);
  else if (process.platform !== 'win32') throw new AiConnectionError('storage', '此版本仅支持 Windows 和 Linux。', 503);
}
// 固定用户目录，与项目目录、构建目录、启动工作目录无关。
export function defaultAiSettingsPath() {
  return join(configDirectory(), 'ai', 'settings.sqlite');
}
