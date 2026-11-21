import { dirname, join } from 'node:path';
import { backupDirectory, configDirectory } from '../config-paths.js';
import { defaultDbPath } from '../db.js';
import { registerVersionedSqlite } from '../versioned-sqlite-spec.js';
import { problemLogDatabase } from './problem-log.js';
import { programRoot, type SourceScope } from './source-paths.js';

/**
 * 诊断记录的默认位置（装配时用）：跟着业务库目录放在 logs/ 下，出错记录库和运行日志各一个文件。
 * 测试一律传 ':memory:' 或临时目录，不用这里的默认位置。
 */
export const defaultProblemLogPath = () => join(dirname(defaultDbPath), 'logs', 'problems.sqlite');
export const defaultRunLogPath = () => join(dirname(defaultDbPath), 'logs', 'run.log');
// 登记默认位置：恢复备份时认得出备份里的 logs/problems.sqlite 是哪个库、支持到第几版
registerVersionedSqlite(problemLogDatabase, defaultProblemLogPath);

/** 读程序代码的范围：程序目录，另外把真实的数据、备份、配置目录列为禁区（就算被设到了程序目录里面） */
export function programSource(): SourceScope {
  return { root: programRoot, denied: [dirname(defaultDbPath), backupDirectory(), configDirectory()] };
}
