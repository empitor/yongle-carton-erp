/**
 * 单据流转：到货单、生产任务、完工单、送货单（flow_ 开头），到货在采购单上的投影，采购退货单。
 * 这里只有当前完整结构的建表、建索引语句，没有业务代码。改结构的规矩见 ../steps.ts。
 */
import { FINISHED_UNIT } from '../../../../shared/core/index.js';
import { isDate, isDateOrNull, isJsonObject, isSha256 } from './checks.js';

export const flowTables = `
-- 单据：到货单 arrival、生产任务 task、完工单 production、送货单 delivery
CREATE TABLE flow_documents(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN ('arrival','task','production','delivery')),
  number TEXT NOT NULL UNIQUE,
  date TEXT NOT NULL CHECK(${isDate('date')}),
  status TEXT NOT NULL CHECK(status IN ('draft','confirmed','cancelled','reversed')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  -- 下面 5 列是 document 里字段的镜像，查询和外键只看列；只由 server/flow/document-store.ts 写（值从要写的那份 document 里算）
  -- planned_date：生产任务、送货单的计划日；到货单（到货安排在订货单上）和完工单为空
  planned_date TEXT CHECK(${isDateOrNull('planned_date')}),
  delivered_at TEXT CHECK(${isDateOrNull('delivered_at')}),
  order_batch_id INTEGER REFERENCES order_batches(id),
  correction_of INTEGER REFERENCES flow_documents(id),
  replaced_by INTEGER REFERENCES flow_documents(id),
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  document TEXT NOT NULL CHECK(${isJsonObject('document')}),
  -- 哪种单据才有
  CHECK(order_batch_id IS NULL OR kind='arrival'),
  CHECK(delivered_at IS NULL OR kind='delivery'),
  CHECK(replaced_by IS NULL OR status='reversed'),
  -- 生产任务没有“待核对”这一步：安排即下达（server/flow/service.ts 的 save）
  CHECK(kind<>'task' OR status<>'draft'),
  -- 生产任务按成品算，单位只有“只”（shared/core/units.ts）
  CHECK(kind<>'task' OR json_extract(document,'$.unit') IS '${FINISHED_UNIT}'),
  -- 生产任务、送货单一定有计划日：保存时没写就按单据日期补上（server/flow/validate.ts）
  CHECK((kind<>'task' AND kind<>'delivery') OR planned_date IS NOT NULL),
  -- 镜像列和 document 里的字段必须一致：漏写一边当场报错，不会悄悄两边不一样
  CHECK(planned_date IS CASE WHEN kind='arrival' THEN NULL ELSE json_extract(document,'$.plannedDate') END),
  CHECK(delivered_at IS json_extract(document,'$.deliveredAt')),
  CHECK(order_batch_id IS json_extract(document,'$.orderBatchId')),
  CHECK(correction_of IS json_extract(document,'$.correctionOf')),
  CHECK(replaced_by IS json_extract(document,'$.replacedBy'))
) STRICT;
CREATE INDEX flow_documents_kind ON flow_documents(kind,status,date);
-- 镜像列的索引只存有值的行（外键列绝大多数是空）；删单据、删批次时外键检查也靠它们
CREATE INDEX flow_documents_plan ON flow_documents(kind,planned_date) WHERE planned_date IS NOT NULL;
CREATE INDEX flow_documents_batch ON flow_documents(order_batch_id) WHERE order_batch_id IS NOT NULL;
CREATE INDEX flow_documents_correction ON flow_documents(correction_of) WHERE correction_of IS NOT NULL;
CREATE INDEX flow_documents_replaced ON flow_documents(replaced_by) WHERE replaced_by IS NOT NULL;

-- 单据和业务记录的关联
CREATE TABLE flow_refs(
  document_id INTEGER NOT NULL REFERENCES flow_documents(id),
  customer_id INTEGER REFERENCES customers(id),
  supplier_id INTEGER REFERENCES suppliers(id),
  product_id INTEGER REFERENCES products(id),
  order_id INTEGER REFERENCES orders(id),
  order_line_id INTEGER REFERENCES order_lines(id),
  purchase_id INTEGER REFERENCES purchases(id),
  purchase_line_id INTEGER REFERENCES purchase_lines(id),
  stock_id INTEGER REFERENCES stock_items(id),
  task_id INTEGER REFERENCES flow_documents(id)
) STRICT;
CREATE INDEX flow_refs_document ON flow_refs(document_id);
CREATE INDEX flow_refs_order ON flow_refs(order_id);
CREATE INDEX flow_refs_order_line ON flow_refs(order_line_id);
CREATE INDEX flow_refs_purchase ON flow_refs(purchase_id);
CREATE INDEX flow_refs_task ON flow_refs(task_id);
CREATE INDEX flow_refs_purchase_line ON flow_refs(purchase_line_id);
CREATE INDEX flow_refs_stock ON flow_refs(stock_id);
CREATE INDEX flow_refs_product ON flow_refs(product_id);
CREATE INDEX flow_refs_customer ON flow_refs(customer_id);
CREATE INDEX flow_refs_supplier ON flow_refs(supplier_id);

-- 供应商送货单号查重
CREATE TABLE flow_receipt_keys(
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  reference TEXT NOT NULL CHECK(length(reference)>0),
  document_id INTEGER NOT NULL REFERENCES flow_documents(id),
  PRIMARY KEY(supplier_id,reference)
) STRICT;
CREATE INDEX flow_receipt_keys_document ON flow_receipt_keys(document_id);

-- 原始送货文件查重
CREATE TABLE flow_file_uses(
  hash TEXT PRIMARY KEY CHECK(${isSha256('hash')}),
  document_id INTEGER NOT NULL REFERENCES flow_documents(id)
) STRICT;
CREATE INDEX flow_file_uses_document ON flow_file_uses(document_id);

-- AI 识别的原件（到货单、唛头）；kind 建了就不变，只存在列里，document 里不再带
CREATE TABLE flow_sources(
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('arrival')),
  file_name TEXT NOT NULL,
  hash TEXT NOT NULL,
  format TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  document TEXT NOT NULL CHECK(json_valid(document)),
  bytes BLOB NOT NULL,
  CHECK(json_type(document,'$.kind') IS NULL)
) STRICT;
CREATE INDEX flow_sources_hash ON flow_sources(hash);
CREATE INDEX flow_sources_kind ON flow_sources(kind,created_at);

-- 采购退货单
CREATE TABLE purchase_returns(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  arrival_id INTEGER NOT NULL REFERENCES flow_documents(id),
  date TEXT NOT NULL CHECK(${isDate('date')}),
  status TEXT NOT NULL CHECK(status IN ('confirmed','reversed')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  document TEXT NOT NULL CHECK(${isJsonObject('document')})
) STRICT;
CREATE INDEX purchase_returns_arrival ON purchase_returns(arrival_id);

`;
