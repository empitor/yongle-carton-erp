import { DatabaseSync } from 'node:sqlite';

const BUSY_TIMEOUT_MS = 5000;

/** 不写文件的连接设置：等锁的时间和外键检查。判断库的状态之前就可以设，被拒绝的库不会因此改动。 */
export function applySessionPragmas(db: DatabaseSync) {
  db.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}; PRAGMA foreign_keys=ON;`);
}

/** 用只读连接读一个库文件，读完就关：被拒绝的库连 WAL 都不会被合并，文件内容一个字节不变。 */
export function readOnlyDatabase<T>(path: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    applySessionPragmas(db);
    return read(db);
  } finally {
    db.close();
  }
}
