import { renameSync, rmSync } from 'node:fs';
import { readOnlyDatabase } from './connection.js';

/** 做到一半的副本文件名的后缀 */
export const PARTIAL_SUFFIX = '.partial';

/**
 * 给一个 SQLite 文件做一份一致的副本（删除前快照、业务库升级前快照、配置库升级前备份和换回都用它）：
 * 用单独的只读连接 VACUUM INTO target.partial，拿到的是已提交的一致内容（WAL 模式的库连 WAL 里的一起），
 * 调用方自己开着事务、持有写锁也能做；prepare 在副本上核对或清理（拿到的是 .partial 的路径），抛错就不要这份。
 * 都过了才改名成 target，半截文件不会被当成副本。失败时删掉 .partial，抛原来的错。
 */
export function consistentCopy(source: string, target: string, prepare?: (copy: string) => void) {
  const staged = target + PARTIAL_SUFFIX;
  try {
    readOnlyDatabase(source, (db) => db.prepare('VACUUM INTO ?').run(staged));
    prepare?.(staged);
    renameSync(staged, target);
  } catch (error) {
    try {
      rmSync(staged, { force: true });
    } catch {
      /* 要报的是上面的原因；删不掉的 .partial 不会被当成副本 */
    }
    throw error;
  }
}
