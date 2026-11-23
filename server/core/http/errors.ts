import { inspect } from 'node:util';
import { errorMessage } from '../../../shared/core/index.js';

/**
 * 业务上可预期的失败：带 HTTP 状态码和错误类别，消息直接给用户看（简体中文）。
 * 各模块的服务和路由都抛它，app.ts 统一转成 { message, code } 的响应。
 */
export class AppError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly code = 'validation',
  ) {
    super(message);
  }
}

/** 读出来的数据和结构对不上时给用户看的话：是程序或数据的问题，不是用户填错了 */
export const STORED_DATA_MESSAGE = '库里有数据和程序要求的样子对不上，没有读出来。请联系维护人员查看服务日志。';
/**
 * 库里读出来的数据（行、JSON 列）没通过结构校验：接口回 500，助手也不会当成自己参数给错了。
 * 给人看的是 STORED_DATA_MESSAGE；detail 写明是哪句 SQL（或哪一列 JSON）、哪几列、哪条规则，
 * 抛出时写进服务端日志，出错记录的原因摘要也取它（diagnostics/problem-kinds.ts 的 errorReason）。
 */
export class StoredDataError extends AppError {
  constructor(readonly detail: string) {
    super(STORED_DATA_MESSAGE, 500, 'stored-data');
    this.name = 'StoredDataError';
  }
}

/** 上传的文件不收（类型不对、内容和扩展名不符、带宏带脚本、损坏）：消息直接给用户看，接口回 415 */
export const unsupportedFile = (message: string) => new AppError(message, 415);

/** 输入不对（缺项、对不上、不允许的修改）：消息直接给用户看，接口回 400 */
export class InputError extends Error {}
/** 版本号对不上：别的页面先改了这条记录，接口回 409 */
export class ConflictError extends Error {
  constructor() {
    super('记录已被其他页面修改，请刷新后重试');
  }
}

/** 数据库约束没过时给用户看的话。原始错误是英文的、带约束表达式，只写进服务端日志。 */
export const CONSTRAINT_MESSAGE = '数据没有保存：有内容不符合数据规则，请联系维护人员。';

/** SQLite 的基本错误码（按 SQLite 文档的编号），和 sqliteCode 取出来的值比 */
export const SQLITE_CODE = { busy: 5, locked: 6, corrupt: 11, constraint: 19, notADatabase: 26 } as const;
/** 扩展错误码的低 8 位是基本错误码 */
const PRIMARY_CODE_BITS = 0xff;
/** node:sqlite 抛的错带 errcode（SQLite 的扩展错误码）：取出基本错误码；不是 SQLite 的错返回 null */
export function sqliteCode(error: unknown): number | null {
  if (typeof error !== 'object' || error === null || !('errcode' in error) || typeof error.errcode !== 'number') return null;
  return error.errcode & PRIMARY_CODE_BITS;
}

/**
 * 是不是 SQLite 的约束错误：CHECK、NOT NULL、UNIQUE、外键，以及 STRICT 表的类型不符。
 * 业务代码应该在写库之前就拦住并说清原因；真走到数据库这一层才被挡，说明代码写出了不合规则的值，是程序问题。
 */
export function isConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ERR_SQLITE_ERROR' &&
    sqliteCode(error) === SQLITE_CODE.constraint
  );
}

/**
 * 统一出错处理的最后一层用：是约束错误就把原始错误写进服务端日志（where 说明是哪个入口），
 * 返回给用户看的那句中文；不是约束错误返回 null，调用方照原来的办法处理。错误不在这里吞掉。
 */
export function constraintFailure(error: unknown, where: string, options: { stack?: boolean } = {}): string | null {
  if (!isConstraintError(error)) return null;
  // 约束错误的文字只有约束表达式，不带写入的值；堆栈默认一起记，方便找是哪段代码写的。
  // 只传单个参数给 console.error，避免 where（如 req.path）里的 %s/%d 被 util.format 当成格式符吞掉错误详情。
  const detail = options.stack === false ? errorMessage(error) : inspect(error);
  console.error('[数据规则] ' + where + '：数据库约束拦下了一次写入 ' + detail);
  return CONSTRAINT_MESSAGE;
}

/**
 * 逐条处理、把失败原因放进结果或审计的地方用：约束错误换成中文并记日志（同 constraintFailure），
 * 其他 Error 用它自己的 message，都不是用 fallback。错误本身不在这里吞掉，要不要再抛由调用方决定。
 */
export function failureMessage(error: unknown, where: string, fallback: string): string {
  return (
    constraintFailure(error, where) ??
    (error instanceof Error ? error.message : fallback)
  );
}
