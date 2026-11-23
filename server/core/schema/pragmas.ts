import type { DatabaseSync } from 'node:sqlite';
import { MIB } from '../../../shared/core/index.js';
import { applySessionPragmas } from '../storage/sqlite/connection.js';
import { pragmaInteger } from '../storage/sqlite/sql.js';
import { SCHEMA_APPLICATION_ID } from './version.js';

/** 页缓存 64MB（负数表示按 KB 算）。默认只有 2MB，全量余额这类查询会反复读盘。 */
const CACHE_SIZE_KB = 65536;
/** -wal 文件在检查点之后最多留 64MB，初始化、永久删除这类大事务撑大的会缩回来。 */
const JOURNAL_SIZE_LIMIT_MB = 64;
const JOURNAL_SIZE_LIMIT = JOURNAL_SIZE_LIMIT_MB * MIB;

/**
 * 建库时设一次、写进文件里的设置，在建第一张表之前、事务之外执行。顺序不能换：
 * 1. auto_vacuum=INCREMENTAL：只能在文件头写出去之前设，之后要改得整库 VACUUM；
 * 2. application_id：会把文件头写出去，所以排在 auto_vacuum 后面；
 * 3. WAL：先开 WAL 再设 auto_vacuum 不生效，所以排最后。
 */
export function applyCreationPragmas(db: DatabaseSync) {
  db.exec('PRAGMA auto_vacuum=INCREMENTAL');
  // 文件头已经写出去的空文件（比如上次建库中途断掉）：库里还没有表，VACUUM 一次让设置生效
  if (pragmaInteger(db, 'auto_vacuum') !== 2) db.exec('VACUUM');
  if (pragmaInteger(db, 'auto_vacuum') !== 2) throw new Error('auto_vacuum 没有设成 INCREMENTAL');
  db.exec(`PRAGMA application_id=${SCHEMA_APPLICATION_ID}`);
  db.exec('PRAGMA journal_mode=WAL');
}

/**
 * 每次打开连接都要设的。WAL 记在文件里，但恢复出来的快照（VACUUM INTO 的结果）不是 WAL，所以每次都设一遍；
 * 内存库没有 WAL，这一句对它不起作用也不报错。synchronous 显式写 FULL，不依赖编译时的默认值。
 */
export function applyConnectionPragmas(db: DatabaseSync) {
  applySessionPragmas(db);
  db.exec(
    `PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA cache_size=-${CACHE_SIZE_KB}; PRAGMA journal_size_limit=${JOURNAL_SIZE_LIMIT};`,
  );
}

/**
 * 让查询计划用上统计信息（全项目不手工跑 ANALYZE）：
 * - 打开已有的库时查一遍全部表（0x10002），只对行数变化大的表重新统计；
 * - 关闭连接前、服务运行中每天再跑一次普通的 optimize，只看这个连接查询过的表。
 * 统计失败不影响业务，所以不抛错。
 */
export function optimizeDatabase(db: DatabaseSync, allTables = false) {
  try {
    if (db.isOpen && !db.isTransaction) db.exec(allTables ? 'PRAGMA optimize=0x10002' : 'PRAGMA optimize');
  } catch {
    /* 统计信息只影响查询快慢 */
  }
}

/**
 * 把删掉数据后空出来的空间还给磁盘，返回还了多少页。
 * 建库时设的是 auto_vacuum=INCREMENTAL：删除只把页记成空闲，文件不会自己变小，要有人跑这一句才还。
 * 作为每日清理的一项跑（server/index.ts 装配，定时见 server/core/backup/cleanup.ts）。还完做一次不等人的检查点：WAL 模式下文件要到检查点才真的变小。
 * 正开着事务时不做，留到下一次（事务里做会混进别人的事务）；内存库、没有空闲页的库直接返回 0。
 * 失败不影响业务，也返回 0。
 */
export function reclaimSpace(db: DatabaseSync) {
  try {
    if (!db.isOpen || db.isTransaction) return 0;
    // 内存库没有文件，database_list 里主库的文件名是空的
    if (!db.prepare('PRAGMA database_list').all().some((row) => row.name === 'main' && row.file)) return 0;
    const free = pragmaInteger(db, 'freelist_count');
    if (!free) return 0;
    db.exec('PRAGMA incremental_vacuum');
    const reclaimed = free - pragmaInteger(db, 'freelist_count');
    try {
      if (reclaimed > 0) db.exec('PRAGMA wal_checkpoint(PASSIVE)');
    } catch {
      /* 这次检查点没做成，文件等下一次检查点再变小 */
    }
    return reclaimed;
  } catch {
    /* 空间没还成只是文件大一些，下次再试 */
    return 0;
  }
}
