/**
 * 基础：客户、产品、订单和明细、审计、版本记录，以及大家共用的归档标记、永久删除的墓碑、防重复提交记录。
 * 这里只有当前完整结构的建表、建索引语句，没有业务代码。改结构的规矩见 ../steps.ts。
 */
import { FINISHED_UNIT } from '../../../../shared/core/index.js';
import { isDate, isDateOrNull, isJsonObject } from './checks.js';

export const baseTables = `
-- 数据库版本记录：新库只有第 20 版一行，以后每段升级加一行
CREATE TABLE schema_migrations(
  version INTEGER PRIMARY KEY CHECK(version>0),
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  app_version TEXT NOT NULL
) STRICT;

-- 客户
CREATE TABLE customers(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL CHECK(length(trim(name))>0),
  contact TEXT NOT NULL,
  phone TEXT NOT NULL,
  address TEXT NOT NULL,
  notes TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

-- 产品（长宽高可以不填；尺寸单位只有 mm、cm，认不出的单位原文记在 dimension_unit_raw）。
-- 参考单价只存一份：price_e4 是万分之一元的整数，没定价是 NULL（和 0 元分开）；“分”price_cents 由它四舍五入算出来，写不进去。
-- 这个算式靠 STRICT 保证列里一定是整数（整数相除才是取整）。parent_product_id 是“附属于哪个产品”，只管显示归组。
CREATE TABLE products(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  length REAL CHECK(length IS NULL OR (length>0 AND length<=10000)),
  width REAL CHECK(width IS NULL OR (width>0 AND width<=10000)),
  height REAL CHECK(height IS NULL OR (height>0 AND height<=10000)),
  dimension_unit TEXT CHECK(dimension_unit IS NULL OR dimension_unit IN ('mm','cm')),
  dimension_unit_raw TEXT,
  material TEXT NOT NULL DEFAULT '',
  flute TEXT NOT NULL DEFAULT '',
  customer_product_code TEXT,
  parent_product_id INTEGER REFERENCES products(id),
  price_e4 INTEGER CHECK(price_e4>=0),
  price_cents INTEGER GENERATED ALWAYS AS ((price_e4+50)/100) VIRTUAL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  requirements TEXT NOT NULL DEFAULT '',
  CHECK(dimension_unit IS NULL OR dimension_unit='mm' OR (COALESCE(length,0)<=1000 AND COALESCE(width,0)<=1000 AND COALESCE(height,0)<=1000)),
  CHECK(parent_product_id IS NULL OR parent_product_id<>id)
) STRICT;
CREATE INDEX products_parent ON products(parent_product_id) WHERE parent_product_id IS NOT NULL;

-- 订单。total_cents 是按明细算出来存着的合计（分）；精确到万分之一元的合计不存，读的时候按明细现算。
-- 只收人民币；附加信息（客户采购单号、原件上的供应方、税率、含税口径、合同条件、尾数规则）从没给过的是 NULL，
-- 给了空白的存空串（编辑窗留空发的就是空串）：按“没填”查要两种都算。明细和产品上可以不填的文字列同理。
CREATE TABLE orders(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  customer_name TEXT NOT NULL,
  order_date TEXT NOT NULL CHECK(${isDate('order_date')}),
  delivery_date TEXT NOT NULL CHECK(${isDate('delivery_date')}),
  status TEXT NOT NULL CHECK(status IN ('待确认','已确认','生产中','待发货','已发货','已取消')),
  total_cents INTEGER NOT NULL CHECK(total_cents>=0),
  currency TEXT NOT NULL DEFAULT 'CNY' CHECK(currency='CNY'),
  rounding_policy TEXT CHECK(rounding_policy IS NULL OR rounding_policy IN ('exact-cents','half-up-cent')),
  tax_rate TEXT,
  tax_mode TEXT,
  external_purchase_order TEXT,
  supplier_name TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  notes TEXT NOT NULL,
  cost_estimate TEXT CHECK(cost_estimate IS NULL OR (${isJsonObject('cost_estimate')})),
  terms TEXT
) STRICT;
CREATE INDEX orders_filter ON orders(customer_id,order_date,status);

-- 订单明细。单价只存一份：unit_price_e4 是万分之一元的整数，“分”unit_price_cents 由它四舍五入算出来，写不进去（靠 STRICT，同产品）。
-- 数量单位只有“只”。删订单要先删明细，不靠级联。
CREATE TABLE order_lines(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL CHECK(quantity>0),
  unit TEXT NOT NULL DEFAULT '${FINISHED_UNIT}' CHECK(unit='${FINISHED_UNIT}'),
  unit_price_e4 INTEGER NOT NULL CHECK(unit_price_e4>=0),
  unit_price_cents INTEGER GENERATED ALWAYS AS ((unit_price_e4+50)/100) VIRTUAL,
  delivery_date TEXT CHECK(${isDateOrNull('delivery_date')}),
  tax_rate TEXT,
  tax_mode TEXT,
  customer_product_code TEXT,
  product_name TEXT NOT NULL,
  specification TEXT NOT NULL,
  notes TEXT
) STRICT;
CREATE INDEX order_lines_order ON order_lines(order_id);
CREATE INDEX order_lines_product ON order_lines(product_id);

-- 业务审计（只追加不删）。source 是从哪个入口来（shared/core/audit-sources.ts）；action、entity 跟着功能增加，不列枚举，只要求不为空
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

-- 归档标记（各模块共用，写入走 Store.markArchived、unarchive）
CREATE TABLE record_lifecycle(
  entity TEXT NOT NULL CHECK(entity IN ('customers','products','orders','suppliers','purchases','stock_items','flow_arrival','flow_task','flow_production','flow_delivery')),
  record_id INTEGER NOT NULL CHECK(record_id>0),
  archived_at TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  PRIMARY KEY(entity,record_id)
) STRICT;

-- 永久删除的墓碑（谁、什么时候删了什么，各模块共用）；编号不复用靠 AUTOINCREMENT，不靠这张表
CREATE TABLE permanent_record_deletions(
  entity TEXT NOT NULL CHECK(entity IN ('customers','products','orders','suppliers','purchases','stock_items','flow_arrival','flow_task','flow_production','flow_delivery')),
  record_id INTEGER NOT NULL CHECK(record_id>0),
  deleted_at TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  label TEXT NOT NULL,
  PRIMARY KEY(entity,record_id)
) STRICT;

-- 防重复提交记录（各模块共用，财务也在这里）：只做防重复，过期的每天清（写入、清理只走 server/core/requests.ts）。
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
-- 写入只走 server/core/sequences.ts；初始化不清，单号不回头
CREATE TABLE number_sequences(
  scope TEXT PRIMARY KEY,
  last INTEGER NOT NULL CHECK(last>=1),
  updated_at TEXT NOT NULL
) STRICT;
`;
