import type { DatabaseSync } from 'node:sqlite';
import { applyCreationPragmas } from './pragmas.js';
import { upgradeSteps, type UpgradeStep } from './steps.js';
import { assistantTables } from './tables/assistant.js';
import { baseTables } from './tables/base.js';
import { businessTables } from './tables/business.js';
import { documentsTables } from './tables/documents.js';
import { financeCostTables } from './tables/finance-costs.js';
import { financeDealingTables } from './tables/finance-dealings.js';
import { financeLedgerTables } from './tables/finance-ledger.js';
import { financeSeed } from './tables/finance-seed.js';
import { flowTables } from './tables/flow.js';
import { importTables } from './tables/import.js';
import { operationsTables } from './tables/operations.js';
import { SCHEMA_BASELINE, SCHEMA_BASELINE_NAME } from './version.js';

/**
 * 当前完整结构的建表语句，按表的主人分组（和 tests/module-table-owners.test.ts 的 tableOwnerList 对应），按这个先后建。
 * scripts/schema-dump.ts 也按这个分组生成行结构（server/core/schema/rows/）。
 */
export const schemaTableGroups = {
  base: baseTables,
  operations: operationsTables,
  flow: flowTables,
  documents: documentsTables,
  business: businessTables,
  import: importTables,
  financeLedger: financeLedgerTables,
  financeDealings: financeDealingTables,
  financeCosts: financeCostTables,
  assistant: assistantTables,
};
/** 一套建表：在建库的事务里建全部表、写预置数据（版本记录由 createSchema 写） */
export type SchemaBuild = (db: DatabaseSync) => void;
/** 当前程序的建表：按 tables/ 的分组建全部表，写财务的预置数据 */
export const buildTables: SchemaBuild = (db) => {
  for (const sql of Object.values(schemaTableGroups)) db.exec(sql);
  db.exec(financeSeed);
};

/** 新库带预置数据的表。结构比较时连它们的行一起比。 */
export const seededTables = ['fin_settings', 'fin_accounts', 'fin_templates'] as const;

/**
 * 空库按“当前完整结构”一次建好：先设建库的设置（事务外），再在一个事务里建全部表、写预置数据和版本记录。
 * 版本记录写第 20 版到当前版本各一行（tables/ 里始终是当前结构，新库不用再跑升级步骤）。
 * 中途失败整体回滚，库里不会留下建了一半的表。
 * build、steps 默认是当前程序的建表和升级步骤；测试换一套时两者要配套（走完步骤和直接建出来是同一个结构）。
 */
export function createSchema(
  db: DatabaseSync,
  options: { appVersion: string; steps?: readonly UpgradeStep[]; build?: SchemaBuild },
) {
  applyCreationPragmas(db);
  db.exec('BEGIN IMMEDIATE');
  try {
    (options.build ?? buildTables)(db);
    const record = db.prepare('INSERT INTO schema_migrations(version,name,applied_at,app_version) VALUES(?,?,?,?)');
    const at = new Date().toISOString();
    record.run(SCHEMA_BASELINE, SCHEMA_BASELINE_NAME, at, options.appVersion);
    for (const step of options.steps ?? upgradeSteps) record.run(step.version, step.name, at, options.appVersion);
    db.exec('COMMIT');
  } catch (error) {
    // 磁盘满、读写出错这类错误 SQLite 已经自己退回了事务，再 ROLLBACK 会报“no transaction is active”把真正的原因盖掉
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}
