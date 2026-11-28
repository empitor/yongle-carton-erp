// 挡板里路径的统一写法和比对（rules.mjs、data-commands.mjs、hook-input.mjs 共用）：小写、正斜杠、Git Bash 盘符、
// \\?\ 前缀、8.3 短名展开、$PWD/$HOME 这类变量、通配写法盖不盖得住项目根目录下的 data、backups。
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix, resolve, win32 } from 'node:path';

export const DATA_RULE = '（AGENTS.md“碰不得的”）。测试用 :memory: 或临时目录配虚构数据；确实要动真实数据请用户自己操作。';
export const DATA_DIRS = ['data', 'backups'];

/** 统一成正斜杠；Git Bash 的 /c/Users 转成 c:/Users；去掉 \\?\、\\.\ 前缀（Windows 的长路径写法）。cased 为真时不转小写。 */
export const norm = (text, cased = false) => {
  const out = String(text)
    .replaceAll('\\', '/')
    .replace(/(^|[\s"'=(])\/\/[?.]\/(?!unc\/)/gi, '$1')
    .replace(/(^|[\s"'=(])\/([a-z])\//gi, '$1$2:/')
    .replace(/\/{2,}/g, '/');
  return cased ? out : out.toLowerCase();
};

/** 项目根目录统一成 norm 的样子、去掉末尾斜杠，好和路径、命令文字比对 */
export const normRoot = (root) => norm(root).replace(/\/$/, '');

const WINDOWS_PATH = /^[a-z]:[\\/]/i;
const fromBashDrive = (path) => path.replace(/^[\\/]{2}[?.][\\/](?!unc[\\/])/i, '').replace(/^\/([a-z])\//i, '$1:/');
/** 拼绝对路径：带盘符的按 Windows 的规矩拼，在哪种系统上跑结果都一样（Linux 上不这样拼会把 C:\… 当成相对路径，该拦的拦不住） */
export function absolute(base, path) {
  const target = fromBashDrive(path);
  const cwd = fromBashDrive(base);
  const resolver = WINDOWS_PATH.test(target) || WINDOWS_PATH.test(cwd) ? win32.resolve : resolve;
  return resolver(cwd, target);
}

/** 命令参数里的当前目录、用户目录变量（$PWD、$(pwd)、~、$HOME、$env:USERPROFILE）换成真实路径再拼绝对路径；别的变量原样 */
export function resolveArg(cwd, word) {
  const expanded = word
    .replace(/^(?:\$\{?pwd\}?|\$\(pwd\)|\$pwd\.path|\$\(get-location\))(?=$|[\\/])/i, () => cwd)
    .replace(/^(?:~|\$\{?home\}?|\$env:(?:userprofile|home)|%userprofile%)(?=$|[\\/])/i, () => homedir());
  return absolute(cwd, expanded);
}

/**
 * 带 8.3 短名（ADMINI~1、纸箱厂~1）的绝对路径展开成长名：存在的最长前缀交给系统展开，其余照接。
 * 没有短名写法的、展开不了的原样返回。路径的两种写法都要查，展开只多拦、不少拦。
 */
export function longPath(path) {
  if (!/~\d/.test(path)) return path;
  const api = WINDOWS_PATH.test(path) ? win32 : posix;
  try {
    for (let head = path, tail = ''; ; ) {
      if (existsSync(head)) return api.join(realpathSync.native(head), tail);
      const parent = api.dirname(head);
      if (parent === head) return path;
      tail = api.join(api.basename(head), tail);
      head = parent;
    }
  } catch {
    return path;
  }
}

/** 一个绝对路径要比对的写法：原样和展开短名后的（统一成 norm 的样子） */
export const pathForms = (abs) => [...new Set([abs, longPath(abs)].map(normRoot))];

/** 统一过的绝对路径落在哪个项目根目录的 data、backups 里：目录名，不在返回空串 */
export function protectedDataDir(abs, roots) {
  for (const root of roots)
    for (const dir of DATA_DIRS)
      if (abs === root + '/' + dir || abs.startsWith(root + '/' + dir + '/'))
        return dir;
  return '';
}

export const dataReason = (dir) => '不能读写真实业务数据目录 ' + dir + '/' + DATA_RULE;

/** 一段路径（小写）和通配写法比：* ? [] {a,b} 照 shell 的意思，** 什么都配 */
export function segmentMatches(pattern, name) {
  if (pattern === name) return true;
  if (!/[*?[{]/.test(pattern)) return false;
  const source = pattern
    .replace(/[.+^$()|\\]/g, '\\$&')
    .replace(/\*+/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\[!/g, '[^')
    .replace(/\{([^}]*)\}/g, (_, list) => '(?:' + list.split(',').join('|') + ')');
  try {
    return new RegExp('^' + source + '$').test(name);
  } catch {
    return true;
  }
}

/** 这个路径（统一过，可带通配）是项目根目录、根目录的上级，或通配写法盖住了根目录下的 data、backups */
export function sweepsData(abs, roots) {
  const segments = abs.split('/');
  return roots.some((root) => {
    const rootSegments = root.split('/');
    for (let i = 0; i < segments.length; i++) {
      if (i === rootSegments.length) return DATA_DIRS.some((dir) => segmentMatches(segments[i], dir));
      if (!segmentMatches(segments[i], rootSegments[i])) return false;
    }
    return true;
  });
}
