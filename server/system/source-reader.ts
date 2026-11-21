import { readFileSync, statSync } from 'node:fs';
import { AppError, clip, pageWindow, redactCodeSecrets, requireSuperAdmin, type Actor, type PageSize } from '../core/index.js';
import {
  existingSourceDirectories,
  readableFile,
  resolveSourcePath,
  walkSource,
  type SourcePath,
  type SourceScope,
} from './source-paths.js';

/**
 * 读程序代码（用户同意：只读、只给超级管理员）：按文字搜索、按文件和行号读。范围和拒绝规则在 source-paths.ts；
 * 交出去的每一行都打码、截到 300 字。没有写、没有执行。
 */

const MAX_READ_LINES = 200;
const MAX_MATCHES = 200;
/** 搜索默认给几条、最多几条 */
const MATCH_PAGE: PageSize = { size: 50, max: MAX_MATCHES };
/** 交出去的一行最多几个字；搜索的文字最多几个字 */
const LINE_CHARS = 300,
  SEARCH_TEXT_MAX = 200;
/** 一次搜索最多翻多少个文件（防止整棵目录树被反复扫） */
const MAX_FILES = 5000;

// 程序代码用轻一档的打码（只遮密钥前缀、长串、网址口令）：运行日志那套按名字遮，会把叫 key、token 的变量行遮成残句
const lineText = (text: string) => clip(redactCodeSecrets(text.replace(/\t/g, '  ').trimEnd()), LINE_CHARS);

/**
 * 按文字搜索（不分大小写，就是普通文字，不是正则）。directory 可以缩小到某个代码目录或子目录，不给就搜全部代码目录。
 * 给 limit 条（默认 50，最多 200），按文件路径、行号排。
 */
export function searchProgramSource(
  scope: SourceScope,
  actor: Actor | null | undefined,
  input: { text: string; directory?: string; limit?: number },
) {
  requireSuperAdmin(actor, '程序代码');
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (text.length < 2 || text.length > SEARCH_TEXT_MAX) throw new AppError('搜索的文字要 2 到 200 个字。');
  const needle = text.toLowerCase(),
    limit = pageWindow(input.limit, 0, MATCH_PAGE).limit;
  const starts: SourcePath[] = input.directory ? [resolveSourcePath(scope, input.directory)] : existingSourceDirectories(scope);
  const matches: { file: string; line: number; text: string }[] = [];
  let files = 0,
    truncated = false;
  /** 到上限：记下“没搜完”，让 walkSource 停下 */
  const stop = () => {
    truncated = true;
    return false;
  };
  for (const start of starts) {
    walkSource(scope, start, (file) => {
      if (++files > MAX_FILES) return stop();
      const lines = readFileSync(file.absolute, 'utf8').split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].toLowerCase().includes(needle)) continue;
        if (matches.length === limit) return stop();
        matches.push({ file: file.path, line: i + 1, text: lineText(lines[i]) });
      }
    });
    if (truncated) break;
  }
  return { matches, truncated };
}

/**
 * 按文件和行号读（from、to 从 1 算，含两头）。一次最多 200 行，不给 to 就从 from 往下读 200 行。
 */
export function readProgramSource(
  scope: SourceScope,
  actor: Actor | null | undefined,
  input: { file: string; from?: number; to?: number },
) {
  requireSuperAdmin(actor, '程序代码');
  const file = resolveSourcePath(scope, input.file);
  if (statSync(file.absolute).isDirectory()) throw new AppError('这是目录，请给出文件路径；要找文件可以先搜索。');
  if (!readableFile(file.absolute)) throw new AppError('这个文件不是能读的代码文件（或超过 1 MB）。', 403, 'permission');
  const all = readFileSync(file.absolute, 'utf8').split(/\r?\n/);
  const from = Math.max(1, Math.trunc(input.from ?? 1)),
    to = Math.min(all.length, from + MAX_READ_LINES - 1, Math.trunc(input.to ?? Number.MAX_SAFE_INTEGER));
  if (from > all.length) throw new AppError(`这个文件只有 ${all.length} 行。`);
  return {
    file: file.path,
    from,
    to,
    totalLines: all.length,
    lines: all.slice(from - 1, to).map((text, i) => ({ number: from + i, text: lineText(text) })),
  };
}
