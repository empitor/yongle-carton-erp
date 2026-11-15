/**
 * 采购库存：供应商、库存品、采购单和明细、库存流水和修订记录、订货批次。
 * 这里只有当前完整结构的建表、建索引语句，没有业务代码。改结构的规矩见 ../steps.ts。
 */
import { FINISHED_UNIT, RAW_UNIT } from '../../../../shared/core/index.js';
import { isDate, isDateOrNull, isJsonArray, isJsonObject } from './checks.js';

export const operationsTables = `
-- 供应商
CREATE TABLE suppliers(
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

-- 库存品（原材料、成品）。同一种货只有一个库存品，归档的也算：
-- 单位只有两种：原材料“张”、成品“只”（shared/core/units.ts）；
-- 成品一定关联产品、一个产品只有一个成品库存（product_id 上的唯一索引）；原材料不关联产品；
-- raw_key 是原材料的查重键（shared/business/stock-identity.ts 的 rawStockKey 算出来存这里，服务端查重用同一个函数），
-- 名称、规格说明、尺寸、材质、楞型规范化后相同的原材料只能有一个（唯一索引）；成品不存（按产品唯一）
CREATE TABLE stock_items(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL CHECK(length(trim(name))>0),
  kind TEXT NOT NULL CHECK(kind IN ('raw','finished')),
  unit TEXT NOT NULL,
  product_id INTEGER REFERENCES products(id),
  raw_key TEXT CHECK(raw_key IS NULL OR length(raw_key)>0),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  document TEXT NOT NULL CHECK(${isJsonObject('document')}),
  CHECK((kind='raw' AND unit='${RAW_UNIT}') OR (kind='finished' AND unit='${FINISHED_UNIT}')),
  CHECK((kind='raw' AND product_id IS NULL) OR (kind='finished' AND product_id IS NOT NULL)),
  CHECK((kind='raw' AND raw_key IS NOT NULL) OR (kind='finished' AND raw_key IS NULL))
) STRICT;
CREATE UNIQUE INDEX stock_items_product ON stock_items(product_id) WHERE product_id IS NOT NULL;
CREATE UNIQUE INDEX stock_items_raw_key ON stock_items(raw_key) WHERE raw_key IS NOT NULL;

-- 采购单
CREATE TABLE purchases(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  supplier_name TEXT NOT NULL,
  customer_order_id INTEGER REFERENCES orders(id),
  order_date TEXT NOT NULL CHECK(${isDate('order_date')}),
  expected_date TEXT CHECK(${isDateOrNull('expected_date')}),
  status TEXT NOT NULL CHECK(status IN ('待订货','已订货','已取消')),
  notes TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(expected_date IS NULL OR expected_date>=order_date)
) STRICT;
CREATE INDEX purchases_order ON purchases(customer_order_id);
CREATE INDEX purchases_supplier ON purchases(supplier_id);

-- 采购明细；received_units 是按有效到货重算的缓存。
-- customer_order_id：这一行给哪张订单订的料，空着跟采购单头走；只存在这一列，document 里不许再有 customerOrderId
CREATE TABLE purchase_lines(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id INTEGER NOT NULL REFERENCES purchases(id),
  stock_item_id INTEGER REFERENCES stock_items(id),
  customer_order_id INTEGER REFERENCES orders(id),
  quantity_units INTEGER NOT NULL CHECK(quantity_units>0),
  received_units INTEGER NOT NULL DEFAULT 0 CHECK(received_units>=0),
  document TEXT NOT NULL CHECK(json_valid(document) AND json_type(document)='object'),
  CHECK(json_type(document,'$.customerOrderId') IS NULL)
) STRICT;
CREATE INDEX purchase_lines_order ON purchase_lines(purchase_id);
CREATE INDEX purchase_lines_stock_item ON purchase_lines(stock_item_id);
CREATE INDEX purchase_lines_customer_order ON purchase_lines(customer_order_id) WHERE customer_order_id IS NOT NULL;

-- 库存流水：余额只由它派生；seq 是登记顺序，永不变、删掉的也不复用。
-- 数量是 0 的流水只有盘点（adjust）能记，表示盘过了、数量没变；别的出入库一律不记 0（表末尾的 CHECK）。
-- 写流水的地方（确认、冲销、管理员编辑、拆送货单、到货更正、采购退货及冲销、批量完工、手工出入库、删除时库存不动）
-- 都只记非 0，server/operations/ledger.ts 的 insertMovement 另有一道中文提示的拦截。
-- 故意不加的约束：after_units=before_units+delta_units（管理员重写流水时先按 0/0 插入，同一事务里再重算）、
-- 出库必为负入库必为正（数据维护核对差额时会反着记）
CREATE TABLE stock_movements(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  item_id INTEGER NOT NULL REFERENCES stock_items(id),
  action TEXT NOT NULL CHECK(action IN ('in','out','adjust','purchase')),
  delta_units INTEGER NOT NULL CHECK(delta_units BETWEEN -999999999999 AND 999999999999),
  before_units INTEGER NOT NULL CHECK(before_units>=0),
  after_units INTEGER NOT NULL CHECK(after_units>=0),
  source_kind TEXT NOT NULL CHECK(source_kind IN ('manual','flow_arrival','flow_production','flow_delivery','flow_reversal','purchase_return','database-maintenance')),
  source_id TEXT,
  purchase_line_id INTEGER REFERENCES purchase_lines(id),
  customer_order_id INTEGER REFERENCES orders(id),
  date TEXT NOT NULL CHECK(${isDate('date')}),
  notes TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK(delta_units<>0 OR action='adjust')
) STRICT;
CREATE INDEX stock_movements_date ON stock_movements(date);
CREATE INDEX stock_movements_item ON stock_movements(item_id,date,created_at,delta_units);
CREATE INDEX stock_movements_source ON stock_movements(source_kind,source_id);
CREATE INDEX stock_movements_purchase_line ON stock_movements(purchase_line_id);
CREATE INDEX stock_movements_order ON stock_movements(customer_order_id);

-- 管理员改写、删除流水留下的修订记录（流水、库存品删了记录还留着，所以两个编号都不加外键）
CREATE TABLE stock_movement_revisions(
  id INTEGER PRIMARY KEY,
  movement_id TEXT NOT NULL,
  item_id INTEGER NOT NULL CHECK(item_id>0),
  at TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  reason TEXT NOT NULL,
  before_document TEXT NOT NULL CHECK(json_valid(before_document)),
  after_document TEXT CHECK(after_document IS NULL OR json_valid(after_document))
) STRICT;
CREATE INDEX stock_movement_revisions_item ON stock_movement_revisions(item_id);
CREATE INDEX stock_movement_revisions_movement ON stock_movement_revisions(movement_id);

-- 订货批次：发给供应商的一份订货单，到货安排存在 schedule（JSON）里。
-- export_id 指向生成这份订货单的导出记录（单据导出的表）：采购库存只存这个编号，不读那张表
CREATE TABLE order_batches(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  order_date TEXT NOT NULL CHECK(${isDate('order_date')}),
  schedule TEXT NOT NULL DEFAULT '[]' CHECK(${isJsonArray('schedule')}),
  notes TEXT NOT NULL DEFAULT '',
  export_id TEXT REFERENCES document_exports(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX order_batches_supplier ON order_batches(supplier_id);
CREATE INDEX order_batches_export ON order_batches(export_id) WHERE export_id IS NOT NULL;

-- 订货批次里的采购单，一张采购单只属于一个批次
CREATE TABLE order_batch_purchases(
  batch_id INTEGER NOT NULL REFERENCES order_batches(id),
  purchase_id INTEGER NOT NULL UNIQUE REFERENCES purchases(id),
  PRIMARY KEY(batch_id,purchase_id)
) STRICT;
`;
