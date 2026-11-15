-- 业务库第 20 版（0.9.0 基线）的结构快照：程序新建的空业务库是什么样，这份 SQL 就建出什么样。
-- 在一个全新的空库上整份执行，得到的库和程序新建的第 20 版库完全一样：
-- 建表、索引、触发器、视图、预置数据、版本记录、application_id、auto_vacuum。
-- 用途：测试拿它当“从第 20 版升级上来”的起点，核对一步步升级上来的库和程序新建的库结构完全一样。
--
-- 怎么生成：npm run schema:dump（scripts/schema-dump.ts，在内存里走 createSchema 建空库再导出）。
-- 输出是确定的，不带当前时间和程序版本：版本记录的 applied_at 固定写 '2000-01-01T00:00:00.000Z'、
-- app_version 固定写 'schema-v20'（结构比较不看这两列）。换行一律 LF。
-- 顺序：建表、索引、触发器、视图按 sqlite_schema 里的先后（建库时的先后）；数据的表也按这个先后，行按 rowid。
-- WAL 这类和文件、连接有关的设置不属于结构，不写在这里。
--
-- 0.9.0 发布前改了结构（server/core/schema/tables/）：运行 npm run schema:dump 重新导出，
-- 并把 tests/schema-evolution.test.ts 里这份文件的 sha256 换成新的。
-- 0.9.0 发布后这份文件不许再改；要改结构请在 server/core/schema/steps.ts 加升级步骤。

-- auto_vacuum 只能在建第一张表之前设；application_id 是本系统业务库的标识（0x5A584552）

PRAGMA auto_vacuum=INCREMENTAL;
PRAGMA application_id=1515734354;

BEGIN;
-- 外键在提交时统一检查，数据的先后不受外键限制
PRAGMA defer_foreign_keys=ON;

-- table schema_migrations
CREATE TABLE schema_migrations(
  version INTEGER PRIMARY KEY CHECK(version>0),
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  app_version TEXT NOT NULL
) STRICT;

-- table customers
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

-- table products
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

-- index products_parent
CREATE INDEX products_parent ON products(parent_product_id) WHERE parent_product_id IS NOT NULL;

-- table orders
CREATE TABLE orders(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  customer_name TEXT NOT NULL,
  order_date TEXT NOT NULL CHECK(order_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(order_date) IS order_date),
  delivery_date TEXT NOT NULL CHECK(delivery_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(delivery_date) IS delivery_date),
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
  cost_estimate TEXT CHECK(cost_estimate IS NULL OR (json_valid(cost_estimate) AND json_type(cost_estimate)='object')),
  terms TEXT
) STRICT;

-- index orders_filter
CREATE INDEX orders_filter ON orders(customer_id,order_date,status);

-- table order_lines
CREATE TABLE order_lines(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL CHECK(quantity>0),
  unit TEXT NOT NULL DEFAULT '只' CHECK(unit='只'),
  unit_price_e4 INTEGER NOT NULL CHECK(unit_price_e4>=0),
  unit_price_cents INTEGER GENERATED ALWAYS AS ((unit_price_e4+50)/100) VIRTUAL,
  delivery_date TEXT CHECK(delivery_date IS NULL OR (delivery_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(delivery_date) IS delivery_date)),
  tax_rate TEXT,
  tax_mode TEXT,
  customer_product_code TEXT,
  product_name TEXT NOT NULL,
  specification TEXT NOT NULL,
  notes TEXT
) STRICT;

-- index order_lines_order
CREATE INDEX order_lines_order ON order_lines(order_id);

-- index order_lines_product
CREATE INDEX order_lines_product ON order_lines(product_id);

-- table business_audit
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

-- index business_audit_record
CREATE INDEX business_audit_record ON business_audit(entity,record_id);

-- table record_lifecycle
CREATE TABLE record_lifecycle(
  entity TEXT NOT NULL CHECK(entity IN ('customers','products','orders','suppliers','purchases','stock_items','flow_arrival','flow_task','flow_production','flow_delivery')),
  record_id INTEGER NOT NULL CHECK(record_id>0),
  archived_at TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  PRIMARY KEY(entity,record_id)
) STRICT;

-- table permanent_record_deletions
CREATE TABLE permanent_record_deletions(
  entity TEXT NOT NULL CHECK(entity IN ('customers','products','orders','suppliers','purchases','stock_items','flow_arrival','flow_task','flow_production','flow_delivery')),
  record_id INTEGER NOT NULL CHECK(record_id>0),
  deleted_at TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  label TEXT NOT NULL,
  PRIMARY KEY(entity,record_id)
) STRICT;

-- table operation_requests
CREATE TABLE operation_requests(
  kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  result TEXT NOT NULL CHECK(json_valid(result)),
  PRIMARY KEY(kind,actor_id,request_id)
) STRICT;

-- index operation_requests_created
CREATE INDEX operation_requests_created ON operation_requests(created_at);

-- table number_sequences
CREATE TABLE number_sequences(
  scope TEXT PRIMARY KEY,
  last INTEGER NOT NULL CHECK(last>=1),
  updated_at TEXT NOT NULL
) STRICT;

-- table suppliers
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

-- table stock_items
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
  document TEXT NOT NULL CHECK(json_valid(document) AND json_type(document)='object'),
  CHECK((kind='raw' AND unit='张') OR (kind='finished' AND unit='只')),
  CHECK((kind='raw' AND product_id IS NULL) OR (kind='finished' AND product_id IS NOT NULL)),
  CHECK((kind='raw' AND raw_key IS NOT NULL) OR (kind='finished' AND raw_key IS NULL))
) STRICT;

-- index stock_items_product
CREATE UNIQUE INDEX stock_items_product ON stock_items(product_id) WHERE product_id IS NOT NULL;

-- index stock_items_raw_key
CREATE UNIQUE INDEX stock_items_raw_key ON stock_items(raw_key) WHERE raw_key IS NOT NULL;

-- table purchases
CREATE TABLE purchases(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  supplier_name TEXT NOT NULL,
  customer_order_id INTEGER REFERENCES orders(id),
  order_date TEXT NOT NULL CHECK(order_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(order_date) IS order_date),
  expected_date TEXT CHECK(expected_date IS NULL OR (expected_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(expected_date) IS expected_date)),
  status TEXT NOT NULL CHECK(status IN ('待订货','已订货','已取消')),
  notes TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(expected_date IS NULL OR expected_date>=order_date)
) STRICT;

-- index purchases_order
CREATE INDEX purchases_order ON purchases(customer_order_id);

-- index purchases_supplier
CREATE INDEX purchases_supplier ON purchases(supplier_id);

-- table purchase_lines
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

-- index purchase_lines_order
CREATE INDEX purchase_lines_order ON purchase_lines(purchase_id);

-- index purchase_lines_stock_item
CREATE INDEX purchase_lines_stock_item ON purchase_lines(stock_item_id);

-- index purchase_lines_customer_order
CREATE INDEX purchase_lines_customer_order ON purchase_lines(customer_order_id) WHERE customer_order_id IS NOT NULL;

-- table stock_movements
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
  date TEXT NOT NULL CHECK(date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(date) IS date),
  notes TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK(delta_units<>0 OR action='adjust')
) STRICT;

-- index stock_movements_date
CREATE INDEX stock_movements_date ON stock_movements(date);

-- index stock_movements_item
CREATE INDEX stock_movements_item ON stock_movements(item_id,date,created_at,delta_units);

-- index stock_movements_source
CREATE INDEX stock_movements_source ON stock_movements(source_kind,source_id);

-- index stock_movements_purchase_line
CREATE INDEX stock_movements_purchase_line ON stock_movements(purchase_line_id);

-- index stock_movements_order
CREATE INDEX stock_movements_order ON stock_movements(customer_order_id);

-- table stock_movement_revisions
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

-- index stock_movement_revisions_item
CREATE INDEX stock_movement_revisions_item ON stock_movement_revisions(item_id);

-- index stock_movement_revisions_movement
CREATE INDEX stock_movement_revisions_movement ON stock_movement_revisions(movement_id);

-- table order_batches
CREATE TABLE order_batches(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  order_date TEXT NOT NULL CHECK(order_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(order_date) IS order_date),
  schedule TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(schedule) AND json_type(schedule)='array'),
  notes TEXT NOT NULL DEFAULT '',
  export_id TEXT REFERENCES document_exports(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

-- index order_batches_supplier
CREATE INDEX order_batches_supplier ON order_batches(supplier_id);

-- index order_batches_export
CREATE INDEX order_batches_export ON order_batches(export_id) WHERE export_id IS NOT NULL;

-- table order_batch_purchases
CREATE TABLE order_batch_purchases(
  batch_id INTEGER NOT NULL REFERENCES order_batches(id),
  purchase_id INTEGER NOT NULL UNIQUE REFERENCES purchases(id),
  PRIMARY KEY(batch_id,purchase_id)
) STRICT;

-- table flow_documents
CREATE TABLE flow_documents(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN ('arrival','task','production','delivery')),
  number TEXT NOT NULL UNIQUE,
  date TEXT NOT NULL CHECK(date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(date) IS date),
  status TEXT NOT NULL CHECK(status IN ('draft','confirmed','cancelled','reversed')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  -- 下面 5 列是 document 里字段的镜像，查询和外键只看列；只由 server/flow/document-store.ts 写（值从要写的那份 document 里算）
  -- planned_date：生产任务、送货单的计划日；到货单（到货安排在订货单上）和完工单为空
  planned_date TEXT CHECK(planned_date IS NULL OR (planned_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(planned_date) IS planned_date)),
  delivered_at TEXT CHECK(delivered_at IS NULL OR (delivered_at GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(delivered_at) IS delivered_at)),
  order_batch_id INTEGER REFERENCES order_batches(id),
  correction_of INTEGER REFERENCES flow_documents(id),
  replaced_by INTEGER REFERENCES flow_documents(id),
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  document TEXT NOT NULL CHECK(json_valid(document) AND json_type(document)='object'),
  -- 哪种单据才有
  CHECK(order_batch_id IS NULL OR kind='arrival'),
  CHECK(delivered_at IS NULL OR kind='delivery'),
  CHECK(replaced_by IS NULL OR status='reversed'),
  -- 生产任务没有“待核对”这一步：安排即下达（server/flow/service.ts 的 save）
  CHECK(kind<>'task' OR status<>'draft'),
  -- 生产任务按成品算，单位只有“只”（shared/core/units.ts）
  CHECK(kind<>'task' OR json_extract(document,'$.unit') IS '只'),
  -- 生产任务、送货单一定有计划日：保存时没写就按单据日期补上（server/flow/validate.ts）
  CHECK((kind<>'task' AND kind<>'delivery') OR planned_date IS NOT NULL),
  -- 镜像列和 document 里的字段必须一致：漏写一边当场报错，不会悄悄两边不一样
  CHECK(planned_date IS CASE WHEN kind='arrival' THEN NULL ELSE json_extract(document,'$.plannedDate') END),
  CHECK(delivered_at IS json_extract(document,'$.deliveredAt')),
  CHECK(order_batch_id IS json_extract(document,'$.orderBatchId')),
  CHECK(correction_of IS json_extract(document,'$.correctionOf')),
  CHECK(replaced_by IS json_extract(document,'$.replacedBy'))
) STRICT;

-- index flow_documents_kind
CREATE INDEX flow_documents_kind ON flow_documents(kind,status,date);

-- index flow_documents_plan
CREATE INDEX flow_documents_plan ON flow_documents(kind,planned_date) WHERE planned_date IS NOT NULL;

-- index flow_documents_batch
CREATE INDEX flow_documents_batch ON flow_documents(order_batch_id) WHERE order_batch_id IS NOT NULL;

-- index flow_documents_correction
CREATE INDEX flow_documents_correction ON flow_documents(correction_of) WHERE correction_of IS NOT NULL;

-- index flow_documents_replaced
CREATE INDEX flow_documents_replaced ON flow_documents(replaced_by) WHERE replaced_by IS NOT NULL;

-- table flow_refs
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

-- index flow_refs_document
CREATE INDEX flow_refs_document ON flow_refs(document_id);

-- index flow_refs_order
CREATE INDEX flow_refs_order ON flow_refs(order_id);

-- index flow_refs_order_line
CREATE INDEX flow_refs_order_line ON flow_refs(order_line_id);

-- index flow_refs_purchase
CREATE INDEX flow_refs_purchase ON flow_refs(purchase_id);

-- index flow_refs_task
CREATE INDEX flow_refs_task ON flow_refs(task_id);

-- index flow_refs_purchase_line
CREATE INDEX flow_refs_purchase_line ON flow_refs(purchase_line_id);

-- index flow_refs_stock
CREATE INDEX flow_refs_stock ON flow_refs(stock_id);

-- index flow_refs_product
CREATE INDEX flow_refs_product ON flow_refs(product_id);

-- index flow_refs_customer
CREATE INDEX flow_refs_customer ON flow_refs(customer_id);

-- index flow_refs_supplier
CREATE INDEX flow_refs_supplier ON flow_refs(supplier_id);

-- table flow_receipt_keys
CREATE TABLE flow_receipt_keys(
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  reference TEXT NOT NULL CHECK(length(reference)>0),
  document_id INTEGER NOT NULL REFERENCES flow_documents(id),
  PRIMARY KEY(supplier_id,reference)
) STRICT;

-- index flow_receipt_keys_document
CREATE INDEX flow_receipt_keys_document ON flow_receipt_keys(document_id);

-- table flow_file_uses
CREATE TABLE flow_file_uses(
  hash TEXT PRIMARY KEY CHECK(length(hash)=64 AND hash NOT GLOB '*[^0-9a-f]*'),
  document_id INTEGER NOT NULL REFERENCES flow_documents(id)
) STRICT;

-- index flow_file_uses_document
CREATE INDEX flow_file_uses_document ON flow_file_uses(document_id);

-- table flow_sources
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

-- index flow_sources_hash
CREATE INDEX flow_sources_hash ON flow_sources(hash);

-- index flow_sources_kind
CREATE INDEX flow_sources_kind ON flow_sources(kind,created_at);

-- table purchase_returns
CREATE TABLE purchase_returns(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  arrival_id INTEGER NOT NULL REFERENCES flow_documents(id),
  date TEXT NOT NULL CHECK(date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(date) IS date),
  status TEXT NOT NULL CHECK(status IN ('confirmed','reversed')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  document TEXT NOT NULL CHECK(json_valid(document) AND json_type(document)='object')
) STRICT;

-- index purchase_returns_arrival
CREATE INDEX purchase_returns_arrival ON purchase_returns(arrival_id);

-- table document_exports
CREATE TABLE document_exports(
  id TEXT PRIMARY KEY,
  digest TEXT NOT NULL,
  record_kind TEXT NOT NULL CHECK(record_kind IN ('purchase','delivery')),
  record_id INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  format TEXT NOT NULL CHECK(format IN ('docx','xlsx')),
  filename TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK(length(sha256)=64),
  size INTEGER NOT NULL CHECK(size>=0),
  template_id TEXT NOT NULL,
  template_revision INTEGER NOT NULL,
  batch_number TEXT,
  ship_date TEXT CHECK(ship_date IS NULL OR (ship_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(ship_date) IS ship_date)),
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  completed_at TEXT,
  options TEXT NOT NULL CHECK(json_valid(options)),
  template_snapshot TEXT NOT NULL CHECK(json_valid(template_snapshot)),
  bytes BLOB,
  CHECK(completed_at IS NULL OR delivered_at IS NOT NULL),
  CHECK(bytes IS NULL OR length(bytes)=size)
) STRICT;

-- index document_exports_record
CREATE INDEX document_exports_record ON document_exports(record_kind,record_id);

-- index document_exports_batch_number
CREATE UNIQUE INDEX document_exports_batch_number ON document_exports(batch_number) WHERE batch_number IS NOT NULL;

-- index document_exports_created
CREATE INDEX document_exports_created ON document_exports(created_at);

-- table document_template_settings
CREATE TABLE document_template_settings(
  id INTEGER PRIMARY KEY CHECK(id=1),
  revision INTEGER NOT NULL CHECK(revision>=1),
  updated_at TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  document TEXT NOT NULL CHECK(json_valid(document))
) STRICT;

-- table mark_files
CREATE TABLE mark_files(
  sha256 TEXT PRIMARY KEY CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  size INTEGER NOT NULL CHECK(size>0),
  mime TEXT NOT NULL,
  file_name TEXT NOT NULL,
  content BLOB NOT NULL,
  CHECK(length(content)=size)
) STRICT;

-- table product_marks
CREATE TABLE product_marks(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  file_sha256 TEXT NOT NULL REFERENCES mark_files(sha256),
  page INTEGER NOT NULL DEFAULT 0 CHECK(page>=0),
  title TEXT NOT NULL DEFAULT '',
  source_kind TEXT NOT NULL CHECK(source_kind IN ('manual','assistant')),
  source_ref TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  UNIQUE(product_id,file_sha256,page)
) STRICT;

-- index product_marks_file
CREATE INDEX product_marks_file ON product_marks(file_sha256);

-- table import_executions
CREATE TABLE import_executions(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  source_id TEXT NOT NULL UNIQUE,
  file_hash TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  document TEXT NOT NULL CHECK(json_valid(document))
) STRICT;

-- index import_fingerprint_lookup
CREATE INDEX import_fingerprint_lookup ON import_executions(fingerprint);

-- index import_hash_lookup
CREATE INDEX import_hash_lookup ON import_executions(file_hash);

-- index import_live_file_unique
CREATE UNIQUE INDEX import_live_file_unique ON import_executions(file_hash) WHERE order_id IS NOT NULL;

-- index import_order_lookup
CREATE INDEX import_order_lookup ON import_executions(order_id);

-- table inbox_items
CREATE TABLE inbox_items(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL CHECK(channel IN ('manual','wecom_bot','feishu_bot','dingtalk_bot')),
  external_id TEXT NOT NULL,
  sender_id TEXT NOT NULL DEFAULT '',
  sender_name TEXT NOT NULL DEFAULT '',
  conversation TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK(kind IN ('text','image','file','voice','video','other')),
  text TEXT NOT NULL DEFAULT '',
  file_name TEXT,
  file_mime TEXT,
  file_size INTEGER CHECK(file_size IS NULL OR file_size>=0),
  file_sha256 TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','converted','ignored')),
  converted_kind TEXT CHECK(converted_kind IS NULL OR converted_kind IN ('order','arrival')),
  converted_ref TEXT,
  handled_by TEXT,
  handled_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  received_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(channel,external_id),
  CHECK((file_sha256 IS NULL)=(file_name IS NULL) AND (file_sha256 IS NULL)=(file_mime IS NULL) AND (file_sha256 IS NULL)=(file_size IS NULL)),
  CHECK((handled_by IS NULL)=(handled_at IS NULL))
) STRICT;

-- index inbox_status_received
CREATE INDEX inbox_status_received ON inbox_items(status,received_at);

-- table inbox_files
CREATE TABLE inbox_files(
  sha256 TEXT PRIMARY KEY CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  size INTEGER NOT NULL CHECK(size>=0),
  content BLOB NOT NULL,
  CHECK(length(content)=size)
) STRICT;

-- table fin_settings
CREATE TABLE fin_settings(
  id INTEGER PRIMARY KEY CHECK(id=1),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  start_period TEXT CHECK(start_period IS NULL OR (start_period GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]' AND substr(start_period,6,2) BETWEEN '01' AND '12')),
  taxpayer TEXT CHECK(taxpayer IS NULL OR taxpayer IN ('general','small')),
  require_separate_approver INTEGER NOT NULL DEFAULT 1 CHECK(require_separate_approver IN (0,1)),
  revenue_recognition TEXT NOT NULL DEFAULT 'delivery' CHECK(revenue_recognition IN ('delivery','invoice')),
  cost_allocation TEXT NOT NULL DEFAULT 'output' CHECK(cost_allocation IN ('output','material')),
  aging_days TEXT NOT NULL DEFAULT '[30,60,90,180,365]' CHECK(json_valid(aging_days) AND json_type(aging_days)='array'),
  tax_rates TEXT NOT NULL DEFAULT '{"smallVat":null,"urban":null,"education":null,"localEducation":null,"income":null}' CHECK(json_valid(tax_rates) AND json_type(tax_rates)='object')
) STRICT;

-- table fin_settings_history
CREATE TABLE fin_settings_history(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  changed_at TEXT NOT NULL,
  settings_version INTEGER NOT NULL,
  taxpayer TEXT CHECK(taxpayer IS NULL OR taxpayer IN ('general','small')),
  require_separate_approver INTEGER NOT NULL CHECK(require_separate_approver IN (0,1)),
  revenue_recognition TEXT NOT NULL CHECK(revenue_recognition IN ('delivery','invoice')),
  cost_allocation TEXT NOT NULL CHECK(cost_allocation IN ('output','material')),
  aging_days TEXT NOT NULL CHECK(json_valid(aging_days) AND json_type(aging_days)='array'),
  tax_rates TEXT NOT NULL CHECK(json_valid(tax_rates) AND json_type(tax_rates)='object'),
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL
) STRICT;

-- index fin_settings_history_at
CREATE INDEX fin_settings_history_at ON fin_settings_history(changed_at,id);

-- table fin_accounts
CREATE TABLE fin_accounts(
  code TEXT PRIMARY KEY CHECK(length(code) IN (4,6,8,10) AND code NOT GLOB '*[^0-9]*'),
  parent_code TEXT REFERENCES fin_accounts(code),
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('asset','liability','equity','cost','profit')),
  direction TEXT NOT NULL CHECK(direction IN ('debit','credit')),
  cash_kind TEXT CHECK(cash_kind IS NULL OR cash_kind IN ('cash','bank')),
  auxiliary TEXT CHECK(auxiliary IS NULL OR auxiliary IN ('customer','supplier','department','employee','project')),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  used INTEGER NOT NULL DEFAULT 0 CHECK(used IN (0,1))
) STRICT;

-- index fin_accounts_parent
CREATE INDEX fin_accounts_parent ON fin_accounts(parent_code);

-- table fin_periods
CREATE TABLE fin_periods(
  period TEXT PRIMARY KEY CHECK(period GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]' AND substr(period,6,2) BETWEEN '01' AND '12'),
  status TEXT NOT NULL CHECK(status IN ('open','closed')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1)
) STRICT;

-- table fin_opening
CREATE TABLE fin_opening(
  id INTEGER PRIMARY KEY,
  account_code TEXT NOT NULL REFERENCES fin_accounts(code),
  auxiliary_kind TEXT CHECK(auxiliary_kind IS NULL OR auxiliary_kind IN ('customer','supplier','department','employee','project')),
  auxiliary_id TEXT,
  auxiliary_name TEXT,
  debit INTEGER NOT NULL CHECK(debit>=0),
  credit INTEGER NOT NULL CHECK(credit>=0),
  year_debit INTEGER NOT NULL CHECK(year_debit>=0),
  year_credit INTEGER NOT NULL CHECK(year_credit>=0),
  CHECK((auxiliary_kind IS NULL)=(auxiliary_id IS NULL) AND (auxiliary_kind IS NULL)=(auxiliary_name IS NULL))
) STRICT;

-- index fin_opening_key
CREATE UNIQUE INDEX fin_opening_key ON fin_opening(account_code,coalesce(auxiliary_id,''));

-- table fin_vouchers
CREATE TABLE fin_vouchers(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number INTEGER NOT NULL,
  date TEXT NOT NULL CHECK(date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(date) IS date),
  period TEXT NOT NULL REFERENCES fin_periods(period),
  description TEXT NOT NULL,
  attachment_count INTEGER NOT NULL CHECK(attachment_count BETWEEN 0 AND 10000),
  event_id INTEGER REFERENCES fin_events(id),
  reversal_of INTEGER REFERENCES fin_vouchers(id),
  status TEXT NOT NULL CHECK(status IN ('draft','pending','approved','posted','void')),
  maker_id TEXT NOT NULL,
  maker_name TEXT NOT NULL,
  approver_id TEXT,
  approver_name TEXT,
  approved_at TEXT,
  poster_id TEXT,
  poster_name TEXT,
  posted_at TEXT,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  module_source TEXT CHECK(module_source IS NULL OR module_source IN ('asset','asset_disposal','depreciation','tax','profit_close','annual_close','costing','expense','employee_advance','invoice','note','bad_debt','obligation','payroll','cash','deposit','interest','event_reversal','purchase_return')),
  module_id INTEGER,
  UNIQUE(period,number),
  CHECK(substr(date,1,7)=period),
  CHECK((module_source IS NULL)=(module_id IS NULL))
) STRICT;

-- index fin_voucher_module
CREATE INDEX fin_voucher_module ON fin_vouchers(module_source,module_id);

-- index fin_vouchers_reversal_of
CREATE INDEX fin_vouchers_reversal_of ON fin_vouchers(reversal_of);

-- index fin_vouchers_event
CREATE UNIQUE INDEX fin_vouchers_event ON fin_vouchers(event_id) WHERE event_id IS NOT NULL AND status<>'void';

-- index fin_vouchers_reversal
CREATE UNIQUE INDEX fin_vouchers_reversal ON fin_vouchers(reversal_of) WHERE reversal_of IS NOT NULL AND status<>'void';

-- table fin_entries
CREATE TABLE fin_entries(
  voucher_id INTEGER NOT NULL REFERENCES fin_vouchers(id),
  position INTEGER NOT NULL,
  account_code TEXT NOT NULL REFERENCES fin_accounts(code),
  description TEXT NOT NULL,
  debit INTEGER NOT NULL,
  credit INTEGER NOT NULL,
  auxiliary_kind TEXT CHECK(auxiliary_kind IS NULL OR auxiliary_kind IN ('customer','supplier','department','employee','project')),
  auxiliary_id TEXT,
  auxiliary_name TEXT,
  cash_flow TEXT,
  CHECK((debit>0 AND credit=0) OR (credit>0 AND debit=0)),
  CHECK((auxiliary_kind IS NULL)=(auxiliary_id IS NULL) AND (auxiliary_kind IS NULL)=(auxiliary_name IS NULL)),
  PRIMARY KEY(voucher_id,position)
) STRICT;

-- index fin_entries_account
CREATE INDEX fin_entries_account ON fin_entries(account_code,voucher_id);

-- table fin_events
CREATE TABLE fin_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('delivery','arrival','production','stock')),
  source_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('delivery.confirmed','delivery.reversed','production.completed','stock.adjusted','arrival.confirmed','arrival.corrected')),
  source_version INTEGER NOT NULL,
  source_hash TEXT NOT NULL,
  date TEXT NOT NULL CHECK(date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(date) IS date),
  amount_cents INTEGER CHECK(amount_cents IS NULL OR amount_cents>=0),
  status TEXT NOT NULL CHECK(status IN ('ready','info_pending','waiting_invoice','generated','difference','source_deleted','awaiting_allocation_reversal','cost_pending','costed','no_amount','corrected','superseded','before_opening')),
  voucher_id INTEGER REFERENCES fin_vouchers(id),
  problem TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  revenue_recognition TEXT CHECK(revenue_recognition IS NULL OR revenue_recognition IN ('delivery','invoice')),
  snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),
  UNIQUE(source_kind,source_id,event_type,source_version)
) STRICT;

-- index fin_events_status
CREATE INDEX fin_events_status ON fin_events(status,date,id);

-- index fin_events_voucher
CREATE INDEX fin_events_voucher ON fin_events(voucher_id);

-- table fin_source_observations
CREATE TABLE fin_source_observations(
  source_kind TEXT NOT NULL CHECK(source_kind IN ('delivery','arrival','production','stock')),
  source_id TEXT NOT NULL,
  source_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('confirmed','reversed','deleted')),
  event_id INTEGER NOT NULL REFERENCES fin_events(id),
  PRIMARY KEY(source_kind,source_id)
) STRICT;

-- index fin_source_observations_event
CREATE INDEX fin_source_observations_event ON fin_source_observations(event_id);

-- table fin_templates
CREATE TABLE fin_templates(
  name TEXT PRIMARY KEY CHECK(name IN ('delivery.confirmed','arrival.confirmed','settlement.discount','deposit','interest','notes','bad_debt','expense','asset','payroll','inventory')),
  mapping TEXT NOT NULL CHECK(json_valid(mapping) AND json_type(mapping)='object'),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1)
) STRICT;

-- table fin_party_terms
CREATE TABLE fin_party_terms(
  kind TEXT NOT NULL CHECK(kind IN ('customer','supplier')),
  party_id TEXT NOT NULL,
  party_name TEXT NOT NULL,
  term_days INTEGER NOT NULL CHECK(term_days BETWEEN 0 AND 3650),
  credit_limit INTEGER CHECK(credit_limit IS NULL OR credit_limit>=0),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  tax_rate TEXT CHECK(tax_rate IS NULL OR (rtrim(tax_rate,'%') GLOB '[0-9]*' AND rtrim(tax_rate,'%') NOT GLOB '*[^0-9.]*' AND CAST(rtrim(tax_rate,'%') AS REAL) BETWEEN 0 AND 100)),
  tax_mode TEXT CHECK(tax_mode IS NULL OR tax_mode IN ('含税','未税','不含税')),
  term_type TEXT NOT NULL DEFAULT 'days' CHECK(term_type IN ('none','days','monthly')),
  term_months INTEGER CHECK(term_months IS NULL OR term_months BETWEEN 0 AND 120),
  payment_day INTEGER CHECK(payment_day IS NULL OR payment_day BETWEEN 1 AND 31),
  cutoff_day INTEGER CHECK(cutoff_day IS NULL OR cutoff_day BETWEEN 1 AND 31),
  options TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(options)),
  PRIMARY KEY(kind,party_id)
) STRICT;

-- table fin_obligations
CREATE TABLE fin_obligations(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN ('receivable','payable')),
  party_id TEXT NOT NULL,
  party_name TEXT NOT NULL,
  date TEXT NOT NULL CHECK(date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(date) IS date),
  due_date TEXT CHECK(due_date IS NULL OR (due_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(due_date) IS due_date)),
  amount_cents INTEGER NOT NULL,
  description TEXT NOT NULL,
  event_id INTEGER REFERENCES fin_events(id),
  voucher_id INTEGER REFERENCES fin_vouchers(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  tax_status TEXT NOT NULL DEFAULT 'known' CHECK(tax_status IN ('known','pending','superseded')),
  reversal_of INTEGER REFERENCES fin_obligations(id),
  opening_id INTEGER REFERENCES fin_opening(id),
  terms_snapshot TEXT CHECK(terms_snapshot IS NULL OR json_valid(terms_snapshot)),
  estimate_voucher_id INTEGER REFERENCES fin_vouchers(id),
  estimate_remaining INTEGER CHECK(estimate_remaining IS NULL OR estimate_remaining>=0)
) STRICT;

-- index fin_obligation_opening
CREATE UNIQUE INDEX fin_obligation_opening ON fin_obligations(opening_id) WHERE opening_id IS NOT NULL;

-- index fin_obligations_event
CREATE INDEX fin_obligations_event ON fin_obligations(event_id);

-- index fin_obligations_party
CREATE INDEX fin_obligations_party ON fin_obligations(kind,party_id,date);

-- index fin_obligations_reversal
CREATE INDEX fin_obligations_reversal ON fin_obligations(reversal_of);

-- table fin_cash_accounts
CREATE TABLE fin_cash_accounts(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('cash','bank','wechat','alipay','other')),
  account_code TEXT NOT NULL UNIQUE REFERENCES fin_accounts(code),
  last_four TEXT CHECK(last_four IS NULL OR (length(last_four)=4 AND last_four NOT GLOB '*[^0-9]*')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1)
) STRICT;

-- table fin_cash_documents
CREATE TABLE fin_cash_documents(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN ('receipt','payment','transfer','income','outlay')),
  account_id INTEGER NOT NULL REFERENCES fin_cash_accounts(id),
  target_account_id INTEGER REFERENCES fin_cash_accounts(id),
  party_id TEXT,
  party_name TEXT,
  date TEXT NOT NULL CHECK(date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(date) IS date),
  amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
  method TEXT NOT NULL CHECK(method IN ('现金','银行','承兑汇票','微信','支付宝','其他')),
  description TEXT NOT NULL,
  counter_account TEXT,
  cash_flow TEXT,
  voucher_id INTEGER REFERENCES fin_vouchers(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','confirmed','cancelled')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1)
) STRICT;

-- index fin_cash_account_date
CREATE INDEX fin_cash_account_date ON fin_cash_documents(account_id,date);

-- table fin_allocations
CREATE TABLE fin_allocations(
  id INTEGER PRIMARY KEY,
  cash_id INTEGER NOT NULL REFERENCES fin_cash_documents(id),
  obligation_id INTEGER NOT NULL REFERENCES fin_obligations(id),
  date TEXT NOT NULL CHECK(date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(date) IS date),
  amount_cents INTEGER NOT NULL CHECK(amount_cents<>0),
  voucher_id INTEGER NOT NULL REFERENCES fin_vouchers(id),
  initial INTEGER NOT NULL DEFAULT 0 CHECK(initial IN (0,1)),
  reversal_of INTEGER REFERENCES fin_allocations(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','reversing','revoked')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  discount_cents INTEGER NOT NULL DEFAULT 0,
  discount_reason TEXT
) STRICT;

-- index fin_alloc_cash
CREATE INDEX fin_alloc_cash ON fin_allocations(cash_id,date);

-- index fin_alloc_obligation
CREATE INDEX fin_alloc_obligation ON fin_allocations(obligation_id,date);

-- index fin_alloc_reversal
CREATE UNIQUE INDEX fin_alloc_reversal ON fin_allocations(reversal_of) WHERE reversal_of IS NOT NULL;

-- table fin_installments
CREATE TABLE fin_installments(
  id INTEGER PRIMARY KEY,
  obligation_id INTEGER NOT NULL REFERENCES fin_obligations(id),
  position INTEGER NOT NULL CHECK(position>=1),
  due_date TEXT CHECK(due_date IS NULL OR (due_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(due_date) IS due_date)),
  amount_cents INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  UNIQUE(obligation_id,position)
) STRICT;

-- table fin_deposits
CREATE TABLE fin_deposits(
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('paid','received')),
  party_kind TEXT NOT NULL CHECK(party_kind IN ('customer','supplier')),
  party_id TEXT NOT NULL,
  party_name TEXT NOT NULL,
  date TEXT NOT NULL CHECK(date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(date) IS date),
  amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
  description TEXT NOT NULL,
  voucher_id INTEGER REFERENCES fin_vouchers(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1)
) STRICT;

-- table fin_deposit_actions
CREATE TABLE fin_deposit_actions(
  id INTEGER PRIMARY KEY,
  deposit_id INTEGER NOT NULL REFERENCES fin_deposits(id),
  kind TEXT NOT NULL CHECK(kind IN ('refund','apply')),
  date TEXT NOT NULL CHECK(date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(date) IS date),
  amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
  obligation_id INTEGER REFERENCES fin_obligations(id),
  voucher_id INTEGER REFERENCES fin_vouchers(id),
  CHECK(kind<>'apply' OR obligation_id IS NOT NULL)
) STRICT;

-- index fin_deposit_actions_deposit
CREATE INDEX fin_deposit_actions_deposit ON fin_deposit_actions(deposit_id);

-- index fin_deposit_actions_obligation
CREATE INDEX fin_deposit_actions_obligation ON fin_deposit_actions(obligation_id);

-- table fin_interest
CREATE TABLE fin_interest(
  id INTEGER PRIMARY KEY,
  obligation_id INTEGER NOT NULL REFERENCES fin_obligations(id),
  period TEXT NOT NULL CHECK(period GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]' AND substr(period,6,2) BETWEEN '01' AND '12'),
  date TEXT NOT NULL CHECK(date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(date) IS date),
  amount_cents INTEGER NOT NULL CHECK(amount_cents>=0),
  reason TEXT NOT NULL,
  voucher_id INTEGER REFERENCES fin_vouchers(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  CHECK(substr(date,1,7)=period)
) STRICT;

-- index fin_interest_obligation
CREATE INDEX fin_interest_obligation ON fin_interest(obligation_id,date);

-- table fin_bad_debts
CREATE TABLE fin_bad_debts(
  id INTEGER PRIMARY KEY,
  obligation_id INTEGER NOT NULL REFERENCES fin_obligations(id),
  kind TEXT NOT NULL CHECK(kind IN ('writeoff','provision','note')),
  date TEXT NOT NULL CHECK(date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(date) IS date),
  amount_cents INTEGER NOT NULL,
  reason TEXT NOT NULL,
  voucher_id INTEGER NOT NULL REFERENCES fin_vouchers(id),
  CHECK(kind='note' OR amount_cents>0)
) STRICT;

-- index fin_bad_debts_obligation
CREATE INDEX fin_bad_debts_obligation ON fin_bad_debts(obligation_id);

-- table fin_statements
CREATE TABLE fin_statements(
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('receivable','payable')),
  party_id TEXT NOT NULL,
  from_date TEXT NOT NULL CHECK(from_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(from_date) IS from_date),
  to_date TEXT NOT NULL CHECK(to_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(to_date) IS to_date),
  status TEXT NOT NULL CHECK(status IN ('sent','confirmed','difference')),
  discrepancy TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  UNIQUE(kind,party_id,from_date,to_date),
  CHECK(from_date<=to_date)
) STRICT;

-- table fin_bank_rows
CREATE TABLE fin_bank_rows(
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES fin_cash_accounts(id),
  date TEXT NOT NULL CHECK(date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(date) IS date),
  amount_cents INTEGER NOT NULL CHECK(amount_cents<>0),
  reference TEXT,
  party_name TEXT NOT NULL,
  description TEXT NOT NULL,
  fingerprint TEXT NOT NULL UNIQUE,
  voucher_id INTEGER REFERENCES fin_vouchers(id),
  entry_position INTEGER,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  UNIQUE(voucher_id,entry_position)
) STRICT;

-- index fin_bank_date
CREATE INDEX fin_bank_date ON fin_bank_rows(account_id,date);

-- table fin_bank_matches
CREATE TABLE fin_bank_matches(
  bank_id INTEGER NOT NULL REFERENCES fin_bank_rows(id),
  voucher_id INTEGER NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY(bank_id,voucher_id,position),
  UNIQUE(voucher_id,position),
  FOREIGN KEY(voucher_id,position) REFERENCES fin_entries(voucher_id,position)
) STRICT;

-- table fin_notes
CREATE TABLE fin_notes(
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('receivable','payable')),
  bank TEXT NOT NULL,
  party_id TEXT NOT NULL,
  party_name TEXT NOT NULL,
  date TEXT NOT NULL CHECK(date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(date) IS date),
  due_date TEXT NOT NULL CHECK(due_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(due_date) IS due_date),
  amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
  status TEXT NOT NULL CHECK(status IN ('held','endorsed','discounted','matured','returned','cancelled')),
  voucher_id INTEGER REFERENCES fin_vouchers(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  UNIQUE(kind,number),
  CHECK(due_date>=date)
) STRICT;

-- table fin_attachments
CREATE TABLE fin_attachments(
  id INTEGER PRIMARY KEY,
  sha256 TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  media_type TEXT NOT NULL CHECK(media_type IN ('image/png','image/jpeg','application/pdf','application/octet-stream')),
  created_at TEXT NOT NULL,
  bytes BLOB NOT NULL
) STRICT;

-- table fin_invoices
CREATE TABLE fin_invoices(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  direction TEXT NOT NULL CHECK(direction IN ('sale','purchase')),
  type TEXT NOT NULL,
  number TEXT NOT NULL,
  date TEXT NOT NULL CHECK(date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(date) IS date),
  party_id TEXT NOT NULL,
  party_name TEXT NOT NULL,
  tax_id TEXT NOT NULL,
  net INTEGER NOT NULL,
  rate TEXT NOT NULL CHECK(rate GLOB '[0-9]*' AND rate NOT GLOB '*[^0-9.]*' AND CAST(rate AS REAL) BETWEEN 0 AND 100),
  tax INTEGER NOT NULL,
  gross INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft','normal','red','pending_certification','certified','nondeductible','void')),
  original_id INTEGER REFERENCES fin_invoices(id),
  voucher_id INTEGER REFERENCES fin_vouchers(id),
  transfer_voucher_id INTEGER REFERENCES fin_vouchers(id),
  attachment_id INTEGER REFERENCES fin_attachments(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  UNIQUE(type,number),
  CHECK(net+tax=gross)
) STRICT;

-- index fin_invoice_date
CREATE INDEX fin_invoice_date ON fin_invoices(direction,date);

-- index fin_invoices_original
CREATE INDEX fin_invoices_original ON fin_invoices(original_id);

-- table fin_invoice_links
CREATE TABLE fin_invoice_links(
  invoice_id INTEGER NOT NULL REFERENCES fin_invoices(id),
  obligation_id INTEGER NOT NULL REFERENCES fin_obligations(id),
  amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
  estimate_cents INTEGER CHECK(estimate_cents IS NULL OR estimate_cents>=0),
  net_cents INTEGER CHECK(net_cents IS NULL OR net_cents>=0),
  quantity_units INTEGER CHECK(quantity_units IS NULL OR quantity_units>0),
  unit TEXT,
  PRIMARY KEY(invoice_id,obligation_id)
) STRICT;

-- index fin_invoice_links_obligation
CREATE INDEX fin_invoice_links_obligation ON fin_invoice_links(obligation_id);

-- table fin_expenses
CREATE TABLE fin_expenses(
  id INTEGER PRIMARY KEY,
  employee_id TEXT NOT NULL,
  employee_name TEXT NOT NULL,
  department TEXT NOT NULL,
  date TEXT NOT NULL CHECK(date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(date) IS date),
  account_code TEXT NOT NULL REFERENCES fin_accounts(code),
  amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft','pending','approved','rejected','paid')),
  invoice_id INTEGER REFERENCES fin_invoices(id),
  attachment_id INTEGER REFERENCES fin_attachments(id),
  voucher_id INTEGER REFERENCES fin_vouchers(id),
  cash_id INTEGER REFERENCES fin_cash_documents(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1)
) STRICT;

-- index fin_expenses_cash
CREATE INDEX fin_expenses_cash ON fin_expenses(cash_id);

-- table fin_assets
CREATE TABLE fin_assets(
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  original_cents INTEGER NOT NULL CHECK(original_cents>0),
  date TEXT NOT NULL CHECK(date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(date) IS date),
  months INTEGER NOT NULL CHECK(months BETWEEN 1 AND 1200),
  residual_bp INTEGER NOT NULL CHECK(residual_bp BETWEEN 0 AND 10000),
  department TEXT NOT NULL,
  expense_account TEXT NOT NULL REFERENCES fin_accounts(code),
  status TEXT NOT NULL CHECK(status IN ('active','disposed')),
  voucher_id INTEGER REFERENCES fin_vouchers(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1)
) STRICT;

-- table fin_depreciation
CREATE TABLE fin_depreciation(
  asset_id INTEGER NOT NULL REFERENCES fin_assets(id),
  period TEXT NOT NULL CHECK(period GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]' AND substr(period,6,2) BETWEEN '01' AND '12'),
  amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
  voucher_id INTEGER NOT NULL REFERENCES fin_vouchers(id),
  PRIMARY KEY(asset_id,period)
) STRICT;

-- table fin_payroll
CREATE TABLE fin_payroll(
  id INTEGER PRIMARY KEY,
  period TEXT NOT NULL CHECK(period GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]' AND substr(period,6,2) BETWEEN '01' AND '12'),
  employee_id TEXT NOT NULL,
  employee_name TEXT NOT NULL,
  department TEXT NOT NULL,
  account_code TEXT NOT NULL REFERENCES fin_accounts(code),
  gross INTEGER NOT NULL CHECK(gross>=0),
  social INTEGER NOT NULL CHECK(social>=0),
  housing INTEGER NOT NULL CHECK(housing>=0),
  tax INTEGER NOT NULL CHECK(tax>=0),
  net INTEGER NOT NULL CHECK(net>=0),
  employer_social INTEGER NOT NULL CHECK(employer_social>=0),
  employer_housing INTEGER NOT NULL CHECK(employer_housing>=0),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  UNIQUE(period,employee_id),
  CHECK(gross=social+housing+tax+net)
) STRICT;

-- table fin_inventory_costs
CREATE TABLE fin_inventory_costs(
  stock_id INTEGER NOT NULL,
  period TEXT NOT NULL CHECK(period GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]' AND substr(period,6,2) BETWEEN '01' AND '12'),
  stock_name TEXT NOT NULL,
  unit TEXT NOT NULL CHECK(unit IN ('张','只')),
  opening_qty INTEGER NOT NULL,
  opening_cents INTEGER NOT NULL,
  in_qty INTEGER NOT NULL,
  in_cents INTEGER NOT NULL,
  out_qty INTEGER NOT NULL,
  out_cents INTEGER NOT NULL,
  end_qty INTEGER NOT NULL,
  end_cents INTEGER NOT NULL,
  PRIMARY KEY(stock_id,period)
) STRICT;

-- table fin_cost_sales
CREATE TABLE fin_cost_sales(
  period TEXT NOT NULL CHECK(period GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]' AND substr(period,6,2) BETWEEN '01' AND '12'),
  movement_id TEXT NOT NULL,
  order_id INTEGER,
  customer_id INTEGER,
  product_id INTEGER,
  cost_cents INTEGER NOT NULL,
  PRIMARY KEY(period,movement_id)
) STRICT;

-- table fin_period_jobs
CREATE TABLE fin_period_jobs(
  period TEXT NOT NULL CHECK(period GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]' AND substr(period,6,2) BETWEEN '01' AND '12'),
  kind TEXT NOT NULL CHECK(
    CASE WHEN instr(kind,'#')=0
      THEN kind IN ('depreciation','payroll','payroll_pay','costing','tax','profit_close','annual_close')
      ELSE substr(kind,1,instr(kind,'#')-1) IN ('depreciation','payroll','payroll_pay','costing','tax','profit_close','annual_close')
        AND substr(kind,instr(kind,'#')+1) GLOB '[1-9]*'
        AND substr(kind,instr(kind,'#')+1) NOT GLOB '*[^0-9]*'
    END),
  voucher_id INTEGER REFERENCES fin_vouchers(id),
  details TEXT NOT NULL CHECK(json_valid(details)),
  PRIMARY KEY(period,kind)
) STRICT;

-- table fin_report_snapshots
CREATE TABLE fin_report_snapshots(
  period TEXT NOT NULL REFERENCES fin_periods(period),
  version INTEGER NOT NULL CHECK(version>=1),
  created_at TEXT NOT NULL,
  document TEXT NOT NULL CHECK(json_valid(document)),
  PRIMARY KEY(period,version)
) STRICT;

-- table fin_budgets
CREATE TABLE fin_budgets(
  period TEXT NOT NULL CHECK(period GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]' AND substr(period,6,2) BETWEEN '01' AND '12'),
  account_code TEXT NOT NULL REFERENCES fin_accounts(code),
  amount_cents INTEGER NOT NULL CHECK(amount_cents>=0),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  PRIMARY KEY(period,account_code)
) STRICT;

-- table assistant_threads
CREATE TABLE assistant_threads(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  document TEXT NOT NULL CHECK(json_valid(document) AND json_type(document)='object')
) STRICT;

-- table assistant_messages
CREATE TABLE assistant_messages(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  thread_id TEXT NOT NULL REFERENCES assistant_threads(id),
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  created_at TEXT NOT NULL,
  text TEXT NOT NULL,
  document TEXT NOT NULL CHECK(json_valid(document))
) STRICT;

-- index assistant_messages_thread
CREATE INDEX assistant_messages_thread ON assistant_messages(thread_id);

-- table assistant_runs
CREATE TABLE assistant_runs(
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES assistant_threads(id),
  user_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('running','completed','failed')),
  created_at TEXT NOT NULL,
  document TEXT NOT NULL CHECK(json_valid(document))
) STRICT;

-- index assistant_runs_thread
CREATE INDEX assistant_runs_thread ON assistant_runs(thread_id);

-- table assistant_previews
CREATE TABLE assistant_previews(
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES assistant_threads(id),
  user_id TEXT NOT NULL,
  session_binding TEXT NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at>=0),
  digest TEXT NOT NULL,
  document TEXT NOT NULL CHECK(json_valid(document)),
  result TEXT CHECK(result IS NULL OR json_valid(result))
) STRICT;

-- index assistant_previews_thread
CREATE INDEX assistant_previews_thread ON assistant_previews(thread_id);

-- table assistant_audit
CREATE TABLE assistant_audit(
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL,
  thread_id TEXT,
  tool TEXT NOT NULL CHECK(length(tool)>0),
  state TEXT NOT NULL CHECK(length(state)>0),
  created_at TEXT NOT NULL,
  document TEXT NOT NULL CHECK(json_valid(document))
) STRICT;

-- index assistant_audit_tool
CREATE INDEX assistant_audit_tool ON assistant_audit(user_id,tool);

-- table assistant_attachments
CREATE TABLE assistant_attachments(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  thread_id TEXT NOT NULL REFERENCES assistant_threads(id),
  user_id TEXT NOT NULL,
  upload_id TEXT NOT NULL,
  name TEXT NOT NULL,
  size INTEGER NOT NULL CHECK(size>0),
  mime TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('image','pdf','office','text')),
  sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  metadata TEXT NOT NULL CHECK(json_valid(metadata)),
  bytes BLOB,
  UNIQUE(user_id,upload_id)
) STRICT;

-- index assistant_attachments_owner
CREATE INDEX assistant_attachments_owner ON assistant_attachments(user_id,thread_id);

-- index assistant_attachments_thread
CREATE INDEX assistant_attachments_thread ON assistant_attachments(thread_id);

-- table assistant_message_attachments
CREATE TABLE assistant_message_attachments(
  message_id TEXT NOT NULL REFERENCES assistant_messages(id) ON DELETE CASCADE,
  attachment_id TEXT NOT NULL REFERENCES assistant_attachments(id),
  PRIMARY KEY(message_id,attachment_id)
) STRICT;

-- index assistant_message_attachments_attachment
CREATE INDEX assistant_message_attachments_attachment ON assistant_message_attachments(attachment_id);

-- 预置数据和版本记录
INSERT INTO schema_migrations(version,name,applied_at,app_version) VALUES(20,'0.9.0 基线','2000-01-01T00:00:00.000Z','schema-v20');
INSERT INTO fin_settings(id,version,start_period,taxpayer,require_separate_approver,revenue_recognition,cost_allocation,aging_days,tax_rates) VALUES(1,1,NULL,NULL,1,'delivery','output','[30,60,90,180,365]','{"smallVat":null,"urban":null,"education":null,"localEducation":null,"income":null}');
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('1001',NULL,'库存现金','asset','debit','cash',NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('1002',NULL,'银行存款','asset','debit','bank',NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('1012',NULL,'其他货币资金','asset','debit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('1101',NULL,'短期投资','asset','debit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('1121',NULL,'应收票据','asset','debit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('1122',NULL,'应收账款','asset','debit',NULL,'customer',1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('1123',NULL,'预付账款','asset','debit',NULL,'supplier',1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('1131',NULL,'应收股利','asset','debit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('1132',NULL,'应收利息','asset','debit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('1221',NULL,'其他应收款','asset','debit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('1401',NULL,'材料采购','asset','debit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('1402',NULL,'在途物资','asset','debit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('1403',NULL,'原材料','asset','debit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('1404',NULL,'材料成本差异','asset','debit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('1405',NULL,'库存商品','asset','debit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('1407',NULL,'商品进销差价','asset','credit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('1408',NULL,'委托加工物资','asset','debit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('1411',NULL,'周转材料','asset','debit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('1421',NULL,'消耗性生物资产','asset','debit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('1501',NULL,'长期债券投资','asset','debit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('1511',NULL,'长期股权投资','asset','debit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('1601',NULL,'固定资产','asset','debit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('1602',NULL,'累计折旧','asset','credit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('1604',NULL,'在建工程','asset','debit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('1605',NULL,'工程物资','asset','debit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('1606',NULL,'固定资产清理','asset','debit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('1621',NULL,'生产性生物资产','asset','debit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('1622',NULL,'生产性生物资产累计折旧','asset','credit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('1701',NULL,'无形资产','asset','debit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('1702',NULL,'累计摊销','asset','credit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('1801',NULL,'长期待摊费用','asset','debit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('1901',NULL,'待处理财产损溢','asset','debit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('2001',NULL,'短期借款','liability','credit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('2201',NULL,'应付票据','liability','credit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('2202',NULL,'应付账款','liability','credit',NULL,'supplier',1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('2203',NULL,'预收账款','liability','credit',NULL,'customer',1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('2211',NULL,'应付职工薪酬','liability','credit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('2221',NULL,'应交税费','liability','credit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('2231',NULL,'应付利息','liability','credit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('2232',NULL,'应付利润','liability','credit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('2241',NULL,'其他应付款','liability','credit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('2401',NULL,'递延收益','liability','credit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('2501',NULL,'长期借款','liability','credit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('2701',NULL,'长期应付款','liability','credit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('222101','2221','应交增值税','liability','credit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('22210101','222101','进项税额','liability','debit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('22210102','222101','销项税额','liability','credit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('22210103','222101','进项税额转出','liability','credit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('22210104','222101','已交税金','liability','debit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('22210105','222101','未交增值税','liability','credit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('222102','2221','应交城市维护建设税','liability','credit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('222103','2221','应交教育费附加','liability','credit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('222104','2221','应交地方教育附加','liability','credit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('222105','2221','应交企业所得税','liability','credit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('3001',NULL,'实收资本','equity','credit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('3002',NULL,'资本公积','equity','credit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('3101',NULL,'盈余公积','equity','credit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('3103',NULL,'本年利润','equity','credit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('3104',NULL,'利润分配','equity','credit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('4001',NULL,'生产成本','cost','debit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('4101',NULL,'制造费用','cost','debit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('4301',NULL,'研发支出','cost','debit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('4401',NULL,'工程施工','cost','debit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('4403',NULL,'机械作业','cost','debit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('400101','4001','直接材料','cost','debit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('400102','4001','直接人工','cost','debit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('400103','4001','制造费用','cost','debit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('5001',NULL,'主营业务收入','profit','credit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('5051',NULL,'其他业务收入','profit','credit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('5111',NULL,'投资收益','profit','credit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('5301',NULL,'营业外收入','profit','credit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('5401',NULL,'主营业务成本','profit','debit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('5402',NULL,'其他业务成本','profit','debit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('5403',NULL,'税金及附加','profit','debit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('5601',NULL,'销售费用','profit','debit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('5602',NULL,'管理费用','profit','debit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('5603',NULL,'财务费用','profit','debit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('5711',NULL,'营业外支出','profit','debit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('5801',NULL,'所得税费用','profit','debit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('560101','5601','运输费','profit','debit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('560102','5601','业务招待费','profit','debit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('560103','5601','广告费','profit','debit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('560104','5601','职工薪酬','profit','debit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('560105','5601','折旧费','profit','debit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('560199','5601','其他','profit','debit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('560201','5602','办公费','profit','debit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('560202','5602','差旅费','profit','debit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('560203','5602','业务招待费','profit','debit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('560204','5602','职工薪酬','profit','debit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('560205','5602','折旧费','profit','debit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('560206','5602','水电费','profit','debit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('560207','5602','修理费','profit','debit',NULL,NULL,1,1,0);
INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled,version,used) VALUES('560299','5602','其他','profit','debit',NULL,NULL,1,1,0);
INSERT INTO fin_templates(name,mapping,version) VALUES('delivery.confirmed','{"party":"1122","net":"5001","tax":"22210102"}',1);
INSERT INTO fin_templates(name,mapping,version) VALUES('arrival.confirmed','{"party":"2202","net":"1403"}',1);
INSERT INTO fin_templates(name,mapping,version) VALUES('settlement.discount','{"fee":"5603"}',1);
INSERT INTO fin_templates(name,mapping,version) VALUES('deposit','{"paid":"1221","received":"2241"}',1);
INSERT INTO fin_templates(name,mapping,version) VALUES('interest','{"fee":"5603"}',1);
INSERT INTO fin_templates(name,mapping,version) VALUES('notes','{"receivable":"1121","payable":"2201"}',1);
INSERT INTO fin_templates(name,mapping,version) VALUES('bad_debt','{"expense":"5711"}',1);
INSERT INTO fin_templates(name,mapping,version) VALUES('expense','{"liability":"2241"}',1);
INSERT INTO fin_templates(name,mapping,version) VALUES('asset','{"asset":"1601","depreciation":"1602","disposal":"1606","gain":"5301","loss":"5711"}',1);
INSERT INTO fin_templates(name,mapping,version) VALUES('payroll','{"wages":"2211","social":"2211","housing":"2211","tax":"2211"}',1);
INSERT INTO fin_templates(name,mapping,version) VALUES('inventory','{"raw":"1403","finished":"1405","material":"400101","sales":"5401","adjustment":"1901"}',1);

COMMIT;
