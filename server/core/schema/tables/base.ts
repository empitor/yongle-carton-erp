/**
 * 基础：审计、版本记录，以及大家共用的归档标记、永久删除的墓碑、防重复提交记录。
 * 这里只有当前完整结构的建表、建索引语句，没有业务代码。改结构的规矩见 ../steps.ts。
 */

export const migrationTable = `
-- 业务库默认是 data/erp.sqlite（DB_PATH 可改），它所在的目录叫“数据目录”。当前结构以 server/core/schema/tables/ 为准，
-- 按表的主人分文件；版本是 server/core/schema/version.ts 的 SCHEMA_LATEST。第 20 版快照、升级步骤和生成的行结构相关的见技能 .claude/skills/schema-change/。
-- sqlite_sequence 是 SQLite 自己记自增表用过的最大编号的表，只有升级执行器（server/core/schema/upgrade.ts）补写。

-- 数据库版本记录：新库按当前结构直接建，第 20 版到当前版本各记一行；升级上来的每段升级加一行
CREATE TABLE schema_migrations(
  version INTEGER PRIMARY KEY CHECK(version>0),
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  app_version TEXT NOT NULL
) STRICT;
`;

export const baseTables = `
-- 业务审计（只追加不删）。source 是从哪个入口来（shared/core/audit-sources.ts）；action、entity 跟着功能增加，不列枚举，只要求不为空。
-- 只给人看，业务计算不读（读它的文件登记在 tests/checks/module-table-owners.test.ts 的 auditReaders）。
-- entity 写表名，单据写 flow_<种类>；财务修改记录按 entity 是财务对象筛
CREATE TABLE business_audit(
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('page','assistant','data-management','system')),
  action TEXT NOT NULL CHECK(length(action)>0),
  entity TEXT NOT NULL CHECK(length(entity)>0),
  record_id INTEGER CHECK(record_id IS NULL OR record_id>0),
  document TEXT NOT NULL CHECK(json_valid(document))
) STRICT;
CREATE INDEX business_audit_record ON business_audit(entity,record_id);

-- 归档标记（各模块共用，只经 Store.markArchived、unarchive 写）。entity 是记录种类（表名，单据是 flow_<种类>，同审计），
-- 不列枚举：能记哪些种类由各模块加载时登记（server/core/records/kinds/record-kinds.ts：客户、产品、订单、供应商、采购单、库存品、四种单据），写入前核对
CREATE TABLE record_lifecycle(
  entity TEXT NOT NULL CHECK(length(entity)>0),
  record_id INTEGER NOT NULL CHECK(record_id>0),
  archived_at TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  PRIMARY KEY(entity,record_id)
) STRICT;

-- 永久删除的墓碑（谁、什么时候删了什么，各模块共用）；编号不复用靠 AUTOINCREMENT，不靠这张表。entity 同归档标记，不列枚举。
-- 删除引擎每删一条写一行；初始化不写不清
CREATE TABLE permanent_record_deletions(
  entity TEXT NOT NULL CHECK(length(entity)>0),
  record_id INTEGER NOT NULL CHECK(record_id>0),
  deleted_at TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  label TEXT NOT NULL,
  PRIMARY KEY(entity,record_id)
) STRICT;

-- 防重复提交记录（各模块共用，财务也在这里）：同一请求号再交返回上次结果（result），带内容摘要（digest）；
-- 只做防重复，留 90 天，过期的每天清（写入、清理只走 server/core/storage/requests.ts）。
-- 请求号按账号分开：actor_id 是提交的账号编号（本机管理员就是它登录的超级管理员账号），别的账号同一个请求号是另一个请求
CREATE TABLE operation_requests(
  kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  result TEXT NOT NULL CHECK(json_valid(result)),
  PRIMARY KEY(kind,actor_id,request_id)
) STRICT;
CREATE INDEX operation_requests_created ON operation_requests(created_at);

-- 按天的流水号计数（现在只有订货批次号 DG-日期-序号 用）：scope 是号段名加日期，last 是已经发到几号。
-- 写入只走 server/core/storage/sequences.ts；初始化不清，单号不回头
CREATE TABLE number_sequences(
  scope TEXT PRIMARY KEY,
  last INTEGER NOT NULL CHECK(last>=1),
  updated_at TEXT NOT NULL
) STRICT;
`;
