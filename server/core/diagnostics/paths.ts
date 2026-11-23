import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultDbPath } from '../storage/db.js';
import { registerVersionedSqlite } from '../backup/versioned-sqlite-spec.js';
import { problemLogDatabase } from './problem-log.js';

/**
 * 出错记录库的默认位置（装配时用）：跟着业务库目录放在 logs/ 下（运行日志在同一目录，见 server/system/paths.ts）。
 * 测试一律传 ':memory:' 或临时目录，不用这里的默认位置。
 */
export const defaultProblemLogPath = () => join(dirname(defaultDbPath), 'logs', 'problems.sqlite');
// 登记默认位置：恢复备份时认得出备份里的 logs/problems.sqlite 是哪个库、支持到第几版
registerVersionedSqlite(problemLogDatabase, defaultProblemLogPath);

/** 程序目录（这个文件在 server/core/diagnostics/ 下）：出错记录里的调用栈按它写成相对路径，读程序代码也从它读起 */
export const programRoot = fileURLToPath(new URL('../../../', import.meta.url));
