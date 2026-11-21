import { dirname, join } from 'node:path';
import { backupDirectory, configDirectory, defaultDbPath, programRoot } from '../core/index.js';
import type { SourceScope } from './source-paths.js';

/**
 * 运行日志的默认位置（装配时用）：跟着业务库目录放在 logs/ 下，和出错记录库（server/core/diagnostics/paths.ts）同一目录。
 * 测试一律传临时目录，不用这里的默认位置。
 */
export const defaultRunLogPath = () => join(dirname(defaultDbPath), 'logs', 'run.log');

/** 读程序代码的范围：程序目录，另外把真实的数据、备份、配置目录列为禁区（就算被设到了程序目录里面） */
export function programSource(): SourceScope {
  return { root: programRoot, denied: [dirname(defaultDbPath), backupDirectory(), configDirectory()] };
}
