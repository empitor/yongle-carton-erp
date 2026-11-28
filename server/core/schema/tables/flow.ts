/**
 * 单据流转：到货单、生产任务、完工单、送货单（flow_ 开头），到货在采购单上的投影，采购退货单。
 * 这里只有当前完整结构的建表、建索引语句，没有业务代码。改结构的规矩见 ../steps.ts。
 */
import { FINISHED_UNIT } from '../../../../shared/core/index.js';
import { isDate, isDateOrNull, isJsonObject, isSha256 } from './checks.js';

export const flowTables = `
-- 单据：到货单 arrival、生产任务 task、完工单 production、送货单 delivery。status：draft、confirmed、cancelled、reversed，
-- 生产任务没有 draft；生产任务单位只有“只”；只由 server/flow/documents/document-store.ts 写。
--
-- 单据内容（document）的结构以 shared/business/flow/flow-document.ts 的 flowDocumentSchema(种类) 为准：录入字段加服务端补的字段，
-- 写和读都按它核对（多键、类型错、缺必填才报错，带默认值的缺了补上）。只存单据内容；行上的列（编号、种类、单号、状态、版本、
-- 操作人、时间）和派生的（完工进度、实际日期）不存，种类在列上，读的时候带上。服务端补的字段分两类：生命周期记录
-- （确认、取消撤销、出库送达、更正关系，lifecycleFields）和抄下来的快照（名称、单价税率、材质楞型、尺寸、面积金额：
-- 严格结构减去录入字段和生命周期字段）。
--
-- | 种类 | 服务端补的字段 | 谁写 |
-- |---|---|---|
-- | 四种都有 | confirmedBy、confirmedAt | 核对确认（生产任务是下达）；更正、改订单拆单沿用原单 |
-- | 四种都有 | movements | 核对确认、更正的替代单、改订单拆单、调整送货单；删流水时滤掉 |
-- | 四种都有 | cancellation、reversal（原因、人、时间；撤销另带流水，更正另带请求号） | 取消、撤销；更正时标在原单上 |
-- | 四种都有 | correctionOf、correctionReason、correctedAt；原单 replacedBy | 更正。删除引擎删原单时 correctionOf 写 null，删替代单时去掉 replacedBy |
-- | 到货 | supplierName、correctionOfReceiptId | 核对确认；更正沿用 |
-- | 到货明细 | area、amount、purchaseId、purchaseNumber、supplierName、验收三个数、新建的 stockId | 核对补全；改库存品时重算面积金额，解除采购明细或删采购单时清采购单 |
-- | 生产任务 | productName；plannedDate 必填，没写按单据日期补 | 下达 |
-- | 完工 | productName、finishedStockId；taskId 可为 null | 核对确认；删任务时置空 |
-- | 送货 | customerName、shippedAt、shippedBy、deliveredAt、deliveredBy；plannedDate 必填。出库后 date 是出库日，plannedDate 留原安排日 | 核对出库、确认送达；更正和拆单沿用 |
-- | 送货收货信息 | siteId 可空，siteName、address、contact、phone 是快照 | 保存待送货单取选中的厂区，空时取客户默认厂区；更正沿用快照；改单换客户时待送货单取新客户默认厂区，已出库、已取消、已撤销的只清 siteId、留着收货信息；删除历史单据引用的厂区只清 siteId |
-- | 送货明细 | productName、specification、unit、orderNumber、externalPurchaseOrder、customerProductCode、unitPriceExact、amountExact、taxRate、taxMode、material、flute、productId、length、width、height、dimensionUnit | 核对补全 |
--
-- 快照怎么留：每一项跟着哪个引用登记在 shared/business/flow/flow-snapshot.ts（缺一项编译不过）。重新保存单据（更正、改已下达的
-- 生产任务、管理员改订单和库存品、解除采购明细）都过 keepSnapshot(原单, 新单)：
--
-- 1. 新单每一行按顺序对上原单一行：送货认同一条订单明细，到货认同一条采购明细和库存品；对过的不再用。
-- 2. 对上了、引用没变的，留原单那行的快照；换了引用或改了数量、纸板资料的取新的；对不上的用新单的。
-- 3. 送货换了引用，按留下的单价乘新数量重算金额。
--
-- 所以档案改名后再更正，替代单上仍是原来的名字。待送货单保存时刷新收货信息。已出库送货单的地址、联系人和联系方式可以改，走和页面“编辑”同一个说明编辑（权限、版本、修改历史都一样）；数据管理界面上没有这几格。
-- 待送货单占用的厂区不能删除。历史送货单解除厂区引用后保留收货信息，财务来源指纹不变。
--
-- 镜像列：下面几列是 document 里同名字段的镜像，查询和外键只看列。值由 flowColumns 从 document 算，表上有 CHECK 核对一致、限定哪种单据才有。
--
-- - planned_date：生产任务、送货单必有；到货单、完工单为空
-- - delivered_at：送货单的送达日
-- - order_batch_id：按订货单登记的到货单，外键指 order_batches
-- - correction_of：替代单指向原单，只由更正写（单据保存不收这个字段）
-- - replaced_by：原单指向替代单；有值时 status 必须是 reversed
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

-- 单据和客户、供应商、产品、订单及明细、采购单及明细、库存品、生产任务的关联。写单据时同时维护；各列都是外键、有索引；
-- 完工单找生产任务走 task_id
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

-- 供应商送货单号查重：主键（供应商、单号）；到货撤销时删掉，可以重新登记
CREATE TABLE flow_receipt_keys(
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  reference TEXT NOT NULL CHECK(length(reference)>0),
  document_id INTEGER NOT NULL REFERENCES flow_documents(id),
  PRIMARY KEY(supplier_id,reference)
) STRICT;
CREATE INDEX flow_receipt_keys_document ON flow_receipt_keys(document_id);

-- 送货单原件查重（按文件哈希）；到货撤销时删掉
CREATE TABLE flow_file_uses(
  hash TEXT PRIMARY KEY CHECK(${isSha256('hash')}),
  document_id INTEGER NOT NULL REFERENCES flow_documents(id)
) STRICT;
CREATE INDEX flow_file_uses_document ON flow_file_uses(document_id);

-- AI 识别的到货单原件；kind 只有 arrival，建了就不变，只存在列里，document 里不再带；只由 server/flow/documents/sources.ts 写
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

-- 采购退货单：挂在到货单下（arrival_id）；status 只有 confirmed、reversed；不记金额
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
