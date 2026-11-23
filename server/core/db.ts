import type { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { APP_VERSION } from '../../shared/core/index.js';
import { rows } from './schema/rows.js';
import { exists, many } from './sql.js';
import { openBusinessDatabase, optimizeDatabase, reclaimSpace } from './schema/index.js';
import { assertRecordKind } from './record-kinds.js';

export const defaultDbPath = resolve(process.env.DB_PATH || 'data/erp.sqlite');
const archivedRow = rows.record_lifecycle.pick({ record_id: true });
/** 某类记录的归档编号：Store.archivedIds 用它；只拿到库连接的（财务的只读窗口）直接调 */
export const archivedIdsIn = (db: DatabaseSync, entity: string) =>
  new Set(many(db, archivedRow, 'SELECT record_id FROM record_lifecycle WHERE entity=?', entity).map((r) => r.record_id));
/** 一组编号（json_each 用的 JSON 数组文字）里归档了的，按主键查：Store.archivedAmong 用它；只拿到库连接的直接调 */
export const archivedAmongIn = (db: DatabaseSync, entity: string, idsJson: string) =>
  new Set(
    many(
      db,
      archivedRow,
      'SELECT record_id FROM record_lifecycle WHERE entity=? AND record_id IN (SELECT value FROM json_each(?)) ORDER BY record_id',
      entity,
      idsJson,
    ).map((r) => r.record_id),
  );
export class Store {
  db: DatabaseSync;
  readonly path: string;
  constructor(path = defaultDbPath) {
    this.path = path;
    // 建表、认版本、升级都在 schema/：旧库、比程序新的库、不是本系统的文件会被拒绝（抛 SchemaError），数据不动
    this.db = openBusinessDatabase(path, { appVersion: APP_VERSION });
  }
  /** 更新查询计划用的统计信息：关闭前会跑，服务运行中每天也跑一次（server/index.ts）。失败不影响业务。 */
  optimize() {
    optimizeDatabase(this.db);
  }
  /**
   * 把删掉数据后空出来的空间还给磁盘，返回还了多少页：服务运行中每天跑一次（server/index.ts）。
   * 内存库、正开着事务时不做，返回 0；失败不影响业务。
   */
  reclaimSpace() {
    return reclaimSpace(this.db);
  }
  close() {
    this.optimize();
    this.db.close();
  }
  /**
   * 归档：在归档标记表里登记。表归基础，删除归档、单据流转都调这里，不直接写这张表。
   * entity 要是各模块登记过的记录种类（record-kinds.ts），没登记的报错。
   */
  markArchived(entity: string, id: number, actorId: string, options: { ignoreExisting?: boolean } = {}) {
    assertRecordKind(entity);
    this.db
      .prepare((options.ignoreExisting ? 'INSERT OR IGNORE' : 'INSERT') + ' INTO record_lifecycle(entity,record_id,archived_at,actor_id) VALUES(?,?,?,?)')
      .run(entity, id, new Date().toISOString(), actorId);
  }
  /** 恢复（或删掉记录时）：去掉归档标记 */
  unarchive(entity: string, id: number) {
    this.db.prepare('DELETE FROM record_lifecycle WHERE entity=? AND record_id=?').run(entity, id);
  }
  archived(entity: string, id: number) {
    return exists(this.db, 'SELECT 1 FROM record_lifecycle WHERE entity=? AND record_id=?', entity, id);
  }
  /** 一次取回某类记录的归档编号，避免列表逐行查询。 */
  archivedIds(entity: string) {
    return archivedIdsIn(this.db, entity);
  }
  /** 这些编号里归档了的（按主键查，只读给的这几条） */
  archivedAmong(entity: string, ids: readonly number[]) {
    return ids.length ? archivedAmongIn(this.db, entity, JSON.stringify(ids)) : new Set<number>();
  }
}
