/**
 * 客户产品订单：客户、产品、订单、明细、唛头和唛头原文件。
 * 这里只有当前完整结构的建表、建索引语句，没有业务代码。改结构的规矩见 ../steps.ts。
 */
import { FINISHED_UNIT } from '../../../../shared/core/index.js';
import { isDate, isDateOrNull, isJsonObject, isSha256 } from './checks.js';

/** 第 25 步建表原文。结构再变时保留这份给升级步骤。 */
export const customerSitesV25 = `
CREATE TABLE customer_sites(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  name TEXT NOT NULL CHECK(length(trim(name))>0),
  contact TEXT NOT NULL,
  phone TEXT NOT NULL,
  address TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0,1)),
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX customer_sites_customer ON customer_sites(customer_id);
CREATE UNIQUE INDEX customer_sites_default ON customer_sites(customer_id) WHERE is_default=1;
`;

export const salesTables = `
-- 客户档案。名称不能空；带 version
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

-- 客户的收货厂区，存名称、联系人、联系方式、地址、备注和默认标记。customer_id 外键指客户；
-- 同客户名称去空白、忽略大小写后不重名；有厂区时恰有一个默认，随客户档案一并保存和永久删除
${customerSitesV25}

-- 产品（长宽高可以不填；尺寸单位只有 mm、cm，认不出的单位原文记在 dimension_unit_raw）。
-- 参考单价只存一份：price_e4 是万分之一元的整数，没定价是 NULL（和 0 元分开）；“分”price_cents 由它四舍五入算出来，写不进去。
-- 这个算式靠 STRICT 保证列里一定是整数（整数相除才是取整）。parent_product_id 是“附属于哪个产品”，只管显示归组，不能附属自己。
-- customer_id 外键指 customers，可空：通用产品留空，填了的只给该客户下单；删客户时置空，下过单且已定客户的不能改客户。
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
  customer_id INTEGER REFERENCES customers(id),
  CHECK(dimension_unit IS NULL OR dimension_unit='mm' OR (COALESCE(length,0)<=1000 AND COALESCE(width,0)<=1000 AND COALESCE(height,0)<=1000)),
  CHECK(parent_product_id IS NULL OR parent_product_id<>id)
) STRICT;
CREATE INDEX products_parent ON products(parent_product_id) WHERE parent_product_id IS NOT NULL;
CREATE INDEX products_customer ON products(customer_id);

-- 订单。单号唯一；客户名是快照。total_cents 是按明细算出来存着的合计（分）；精确到万分之一元的合计不存，读的时候按明细现算。
-- 只收人民币（CNY）；规范税率存万分比整数，含税口径只收枚举值，原话另外留在 tax_text。
-- 客户采购单号等可选说明从没给过是 NULL，给了空白的存空串。
--
-- 订单头和明细各存 tax_rate_bp（0 到 10000 的整数万分比，13% 存 1300）、tax_mode（含税、未税、未明确）和 tax_text（原件或旧数据的原话）。
-- 前两列没填或认不出时为 NULL。订单接口的 taxRate 是百分数数字（13 表示 13%），taxText 是原件写法。
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
  tax_rate_bp INTEGER CHECK(tax_rate_bp IS NULL OR tax_rate_bp BETWEEN 0 AND 10000),
  tax_mode TEXT CHECK(tax_mode IS NULL OR tax_mode IN ('含税','未税','未明确')),
  tax_text TEXT,
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
-- 数量单位只有“只”。删订单要先删明细，不靠级联。产品名、规格是快照，换产品时取新档案的；税率三列同订单头。
CREATE TABLE order_lines(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL CHECK(quantity>0),
  unit TEXT NOT NULL DEFAULT '${FINISHED_UNIT}' CHECK(unit='${FINISHED_UNIT}'),
  unit_price_e4 INTEGER NOT NULL CHECK(unit_price_e4>=0),
  unit_price_cents INTEGER GENERATED ALWAYS AS ((unit_price_e4+50)/100) VIRTUAL,
  delivery_date TEXT CHECK(${isDateOrNull('delivery_date')}),
  tax_rate_bp INTEGER CHECK(tax_rate_bp IS NULL OR tax_rate_bp BETWEEN 0 AND 10000),
  tax_mode TEXT CHECK(tax_mode IS NULL OR tax_mode IN ('含税','未税','未明确')),
  tax_text TEXT,
  customer_product_code TEXT,
  product_name TEXT NOT NULL,
  specification TEXT NOT NULL,
  notes TEXT
) STRICT;
CREATE INDEX order_lines_order ON order_lines(order_id);
CREATE INDEX order_lines_product ON order_lines(product_id);
`;

export const marksTables = `
-- 唛头原文件，按 SHA-256 存一份；sha256 是 content 的摘要，size 是 content 的字节数
CREATE TABLE mark_files(
  sha256 TEXT PRIMARY KEY CHECK(${isSha256('sha256')}),
  size INTEGER NOT NULL CHECK(size>0),
  mime TEXT NOT NULL,
  file_name TEXT NOT NULL,
  content BLOB NOT NULL,
  CHECK(length(content)=size)
) STRICT;

-- 产品挂的唛头。同一产品、文件、页只一行；source_kind 只有 manual、assistant
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
CREATE INDEX product_marks_file ON product_marks(file_sha256);
`;
