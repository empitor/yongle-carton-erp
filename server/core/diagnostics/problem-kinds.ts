import { isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROBLEM_TEXT } from '../../../shared/core/index.js';
import { StoredDataError } from '../errors.js';
import { programRoot } from './source-paths.js';
import { safeText } from './redact.js';

/**
 * 出错记录怎么分类、5xx 留哪些线索。纯函数：只看状态码、错误类别、说法和错误对象，不碰库和请求。
 */

/** 出错记录的类别（给人看的中文，筛选时按它）。最后四个只给页面上报用，不和服务端的混用 */
export const problemCategories = [
  '出错',
  '数据规则',
  '校验没过',
  '没权限',
  '版本冲突',
  '重复提交',
  '冲突',
  '不存在',
  '太频繁',
  '页面请求失败',
  '连不上服务器',
  '页面报错',
  '出错提示',
] as const;
export type ProblemCategory = (typeof problemCategories)[number];

/** 页面凭证过期的几种说法：服务重启后页面会自动重读凭证重发，不算问题 */
const staleCredential = /页面.{0,4}(已过期|凭证无效)/;

/**
 * 一次失败的回答算哪一类；不该记的返回 null：没出错的、没登录（401）、页面凭证过期。
 */
export function problemCategory(status: number, code: unknown, message: unknown): ProblemCategory | null {
  const text = typeof message === 'string' ? message : '';
  if (status < 400 || status === 401) return null;
  if (status >= 500) return code === 'data-rule' ? '数据规则' : '出错';
  if (status === 403) return staleCredential.test(text) ? null : '没权限';
  if (status === 409) {
    if (code === 'duplicate' || /重复/.test(text)) return '重复提交';
    return code === 'stale' || /已被|刷新|版本|已变化|已更新/.test(text) ? '版本冲突' : '冲突';
  }
  if (status === 404 || status === 410) return '不存在';
  if (status === 429) return '太频繁';
  return '校验没过';
}

const FRAME = /^\s*at (?:(.+?) \()?(.+?):(\d+):\d+\)?$/;
/** 程序目录以外的文件只留路径最后几段 */
const OUTSIDE_SEGMENTS = 2;
const shortFile = (file: string) => {
  const path = file.startsWith('file://') ? fileURLToPath(file) : file;
  if (!isAbsolute(path)) return path;
  const r = relative(programRoot, path);
  return r.startsWith('..') || isAbsolute(r) ? path.split(/[\\/]/).slice(-OUTSIDE_SEGMENTS).join('/') : r.replace(/\\/g, '/');
};

/**
 * 堆栈前 5 行：只有函数名、文件（程序目录下的写相对路径，别处只留最后两段）和行号，没有源码内容。
 */
export function stackLines(error: unknown): string[] {
  const stack = typeof error === 'object' && error !== null && 'stack' in error ? error.stack : undefined;
  if (typeof stack !== 'string') return [];
  const lines: string[] = [];
  for (const line of stack.split('\n')) {
    const m = FRAME.exec(line);
    if (!m) continue;
    lines.push(safeText((m[1] ? m[1] + ' ' : '') + shortFile(m[2]) + ':' + m[3], PROBLEM_TEXT.stackLine));
    if (lines.length === PROBLEM_TEXT.stackLines) break;
  }
  return lines;
}

/** 原因摘要：错误的类名和说法的第一行（打码、截到 300 字），不带堆栈。库里数据对不上的，取写明哪句 SQL、哪几列的 detail */
export function errorReason(error: unknown): string {
  if (!(error instanceof Error)) return safeText(error, PROBLEM_TEXT.reason);
  const text = error instanceof StoredDataError ? error.detail : error.message;
  return safeText(error.name + ': ' + (text.split('\n')[0] ?? ''), PROBLEM_TEXT.reason);
}
