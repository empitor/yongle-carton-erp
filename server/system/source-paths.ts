import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { MIB } from '../../shared/core/index.js';
import { AppError } from '../core/index.js';

/**
 * 读程序代码的范围：只认程序自己的几个代码目录，路径先解析成真实的绝对路径再判断。
 * 越界的写法（..、绝对路径、盘符、UNC、符号链接指出去、数据流名）、数据和备份和配置目录、依赖目录、
 * 密钥文件、环境变量文件、数据库文件一律拒绝。只给读，不给写和执行。
 */

/** 能读的代码目录（服务器上的安装包没有 src/，存在哪些读哪些） */
export const sourceDirectories = ['server', 'shared', 'src', 'scripts', 'docs'] as const;
/** root：程序目录；denied：真实数据目录、备份目录、配置目录这类绝对路径，就算落在代码目录里也不给读 */
export type SourceScope = { root: string; denied: string[] };

/** 单个文件最大多少字节才读（再大的不是手写的代码） */
const MAX_FILE_BYTES = MIB;
/** 调用方给的相对路径最多几个字 */
const MAX_PATH_CHARS = 300;
const deniedSegments = new Set(['node_modules', '.git', 'data', 'backups', 'dist', 'security']);
const deniedName =
  /^\.env(\..*)?$|^\.npmrc$|^master\.key$|^id_(rsa|dsa|ecdsa|ed25519)|\.(pem|key|p12|pfx|crt|cer|jks|keystore|sqlite3?|db)(-wal|-shm|-journal)?$/i;
const textFile = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx|json|md|css|html|sql|txt|ya?ml|ps1|sh|cmd|bat)$/i;

const refuse = (why: string) => new AppError('不能读这个路径：' + why, 403, 'permission');
const inside = (child: string, parent: string) => {
  const r = relative(parent, child);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
};
const allowedName = (name: string) => !deniedSegments.has(name.toLowerCase()) && !deniedName.test(name);
const real = (path: string) => (existsSync(path) ? realpathSync.native(path) : resolve(path));

/** 解析好的路径：absolute 是真实路径，path 是相对程序目录、用 / 分隔的写法 */
export type SourcePath = { absolute: string; path: string };

/**
 * 把调用方给的相对路径（如 server/accounts/auth.ts）解析成真实路径并核对范围。目录和文件都可以；不存在的报 404。
 */
export function resolveSourcePath(scope: SourceScope, input: unknown): SourcePath {
  if (typeof input !== 'string' || !input.trim() || input.length > MAX_PATH_CHARS || input.includes('\0'))
    throw new AppError('请给出程序目录下的相对路径，例如 server/accounts/auth.ts。');
  const written = input.trim().replace(/\\/g, '/');
  if (written.startsWith('/') || written.includes(':') || written.startsWith('~'))
    throw refuse('只收程序目录下的相对路径，不收绝对路径、盘符或网络路径。');
  const parts = written.split('/').filter(Boolean);
  if (parts.some((p) => p === '..' || p === '.')) throw refuse('路径里不能有 . 或 ..。');
  const top = parts[0];
  if (!(sourceDirectories as readonly string[]).includes(top))
    throw refuse('只能读 ' + sourceDirectories.join('、') + ' 这几个代码目录。');
  if (!parts.every(allowedName)) throw refuse('数据、备份、配置、依赖目录和密钥、环境变量、数据库文件不给读。');
  const topDir = join(scope.root, top),
    full = resolve(scope.root, ...parts);
  if (!inside(full, topDir)) throw refuse('路径落到了代码目录之外。');
  if (!existsSync(full)) throw new AppError('没有这个文件或目录：' + parts.join('/'), 404, 'not-found');
  // 符号链接、目录联接解析到真实位置后再核对一遍：指出去的、指向机密文件的都拒绝。
  // 真实路径的每一段都过一遍（Windows 短文件名 SECURI~1 这类写法解析后才露出真名）
  const absolute = realpathSync.native(full),
    realTop = real(topDir);
  if (!inside(absolute, realTop) || !relative(realTop, absolute).split(/[\\/]/).filter(Boolean).every(allowedName))
    throw refuse('路径实际指向代码目录之外，或指向不给读的文件。');
  if (scope.denied.some((d) => inside(absolute, real(d)))) throw refuse('这里是数据、备份或配置目录。');
  return { absolute, path: parts.join('/') };
}

/** 是不是能当文字读的代码文件（扩展名对、不超过 1 MB） */
export function readableFile(absolute: string) {
  return textFile.test(absolute) && allowedName(basename(absolute)) && statSync(absolute).size <= MAX_FILE_BYTES;
}

/**
 * 按目录顺序列出范围里能读的文件（相对路径），符号链接一律跳过（不顺着走出去），拒绝的目录和文件不进去。
 * 回调返回 false 时停止。
 */
export function walkSource(scope: SourceScope, start: SourcePath, visit: (file: SourcePath) => boolean | void) {
  const denied = scope.denied.map(real);
  const walk = (dir: string, path: string): boolean => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink() || !allowedName(entry.name)) continue;
      const absolute = join(dir, entry.name),
        child = path + '/' + entry.name;
      if (denied.some((d) => inside(absolute, d))) continue;
      if (entry.isDirectory()) {
        if (walk(absolute, child) === false) return false;
      } else if (entry.isFile() && readableFile(absolute) && visit({ absolute, path: child }) === false) return false;
    }
    return true;
  };
  if (statSync(start.absolute).isDirectory()) walk(start.absolute, start.path);
  else if (readableFile(start.absolute)) visit(start);
}

/** 范围里实际存在的代码目录（服务器上没有 src/） */
export function existingSourceDirectories(scope: SourceScope): SourcePath[] {
  return sourceDirectories
    .filter((d) => existsSync(join(scope.root, d)))
    .map((d) => resolveSourcePath(scope, d));
}
