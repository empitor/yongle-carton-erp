import type { DatabaseSync } from 'node:sqlite';
import { customerSitesV25 } from './tables/sales.js';

/** 一段升级：把结构从第 version-1 版带到第 version 版 */
export type UpgradeStep = {
  version: number;
  /** 写进版本记录的名字，说清这一步做了什么 */
  name: string;
  /** 在升级的总事务里执行，外键检查已经关掉；只用 SQL 改结构、搬数据 */
  up(db: DatabaseSync): void;
};

/**
 * 第 20 版（0.9.0 基线）之后的升级步骤，版本号从 21 起连续。
 *
 * 0.9.0 发布之前改结构，直接改 tables/ 里的建表语句，不写步骤（库还没发布过）。
 * 发布以后每次改结构：在这里加一步，同时把 tables/ 改成改完以后的完整结构，再把 version.ts 的 SCHEMA_LATEST 加一。
 * tests/core/schema-evolution.test.ts 会核对“空库新建”和“从第 20 版一路升级上来”的结构完全一样。
 * 每一步还要带一份升级前后的小数据样例：tests/fixtures/upgrade-samples/v<版本号>.json，
 * 写 before（升级前写进库的行）和 after（这一步跑完应有的行，只写要核对的列），写法见 tests/core/upgrade-step-samples.test.ts 开头；
 * 那条测试会真跑这一步并比对，没有样例会失败。
 *
 * 写步骤的规矩：
 * - 一步只做一件事，只用 SQL，不引用业务模块；确实要用业务算法修数据的，由表的主人模块登记实现，步骤里只调登记的函数。
 * - 已发布的步骤不许改，编号不许复用。
 * - 加列用 ALTER TABLE … ADD COLUMN，并在 tables/ 的建表语句里把这一列加在“最后一个列定义之后、表约束之前”
 *   （SQLite 就是把新列拼在这个位置，两边一样结构比较才能通过）。新增 NOT NULL 列必须带 DEFAULT。
 * - 重建表按 SQLite 官方的做法：建新表、复制数据、删旧表、改名、重建索引。外键检查由执行器关掉，提交前统一查一遍。
 *   DROP TABLE 会删掉旧表在 sqlite_sequence 里“用过的最大编号”，表名不变的，执行器提交前按升级前的计数补回去（只升不降）；
 *   自增表改了名（不管是不是顺带重建），执行器认不出新表就是旧表，步骤必须自己把旧名的计数写到新名上
 *   （UPDATE sqlite_sequence，新名还没有这一行就 INSERT），并在 tests/core/schema-evolution.test.ts 的 autoIncrementTableChanges 登记，
 *   删掉自增表也在那里登记。那边的“从第 20 版快照升级”测试会核对每张自增表的计数都没有回头。
 * - 步骤里不能 VACUUM，不能改 page_size、auto_vacuum（事务里做不了）；回填数据不能依赖当前时间。
 * - 新表照常登记表的主人、删除和初始化规则。
 * - 表一律建成 STRICT（列类型只能是 INTEGER、REAL、TEXT、BLOB）。状态、种类这类固定取值的列加枚举 CHECK，
 *   业务日期、会计期间、JSON 列用 tables/checks.ts 里的片段；会随功能增加的列（审计的来源和动作、防重复提交的种类这些）不列枚举。
 *   枚举在建表里写死，所属模块里要有同一份常量，并登记到 tests/checks/schema-constraints.test.ts（那边逐个比对）。
 * - SQLite 的 CHECK 不能单独改：给枚举加一个值、放宽或收紧一条约束，都要重建那张表（见上面“重建表”，可以用下面的 rebuildTable）。
 */

/**
 * 按官方做法重建一张表（不改表名）：建新表、整行连 rowid 原样复制、删旧表、新表改回原名（主键、UNIQUE 的自动索引跟着改名）。
 * definition 是改完以后的列定义和表约束，要和 tables/ 里的建表一字不差（空白、引号除外）；columns 是两边都有、要原样复制的列。
 * 表上另建的索引、触发器删旧表时会一起没掉，由步骤自己重建；自增表的计数由执行器补回（表名不变）。
 * 已发布的步骤在用它，不改它的做法；要别的做法另写一个。
 */
function rebuildTable(db: DatabaseSync, table: string, definition: string, columns: string) {
  const rebuilt = table + '_rebuilt';
  db.exec(`CREATE TABLE ${rebuilt}(${definition}) STRICT;
    INSERT INTO ${rebuilt}(rowid,${columns}) SELECT rowid,${columns} FROM ${table};
    DROP TABLE ${table};
    ALTER TABLE ${rebuilt} RENAME TO ${table};`);
}

/**
 * v24 的历史写法转换固定在这一步：税率照 readTaxRate 认，含税口径照录入的认法先去掉首尾空白再认（taxModeSchema 先 trim）；
 * 和程序认法一致由升级样例测试核对（tests/core/upgrade-step-samples.test.ts）。
 */
const taxWhitespace = [...'\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff']
  .map((ch) => ch.charCodeAt(0));
const withoutTaxSpaces = taxWhitespace.reduce((sql, cp) => `replace(${sql},char(${cp}),'')`, 'tax_rate');
const normalizedTax = [...'０１２３４５６７８９％．'].reduce(
  (sql, ch, i) => `replace(${sql},'${ch}','${'0123456789%.'[i]}')`, withoutTaxSpaces,
);
const v24Rate = `(
        WITH raw(value) AS (SELECT ${normalizedTax} WHERE instr(tax_rate,char(0))=0),
        split(digits,percent) AS (
          SELECT CASE WHEN substr(value,-1)='%' THEN substr(value,1,length(value)-1) ELSE value END,
            substr(value,-1)='%' FROM raw
        ),
        decimal_parts AS (SELECT digits,percent,instr(digits,'.') AS point FROM split),
        parsed AS (
          SELECT CAST(digits AS INTEGER) AS whole, percent,
            CASE WHEN point=0 THEN 0 ELSE CAST(substr(substr(digits,point+1)||'00',1,2) AS INTEGER) END AS fraction
          FROM decimal_parts
          WHERE digits GLOB '[0-9]*' AND digits NOT GLOB '*[^0-9.]*'
            AND (point=0 OR (length(digits)-point BETWEEN 1 AND 2 AND instr(substr(digits,point+1),'.')=0))
        )
        SELECT whole*100+fraction FROM parsed
        WHERE whole<=100 AND whole*100+fraction<=10000 AND (whole>0 OR fraction=0 OR percent)
      )`;
const v24ModeText = `trim(tax_mode,char(${taxWhitespace.join(',')}))`;
const v24Mode = `CASE WHEN ${v24ModeText}='不含税' THEN '未税'
  WHEN ${v24ModeText} IN ('含税','未税','未明确') THEN ${v24ModeText} END`;
// 认不出的口径逐字接在税率原话后面，另起一行加“口径：”（shared/core/tax-rate.ts 从这一行读到末尾，送货快照照抄它）
const v24Text = `NULLIF(concat_ws(char(10),NULLIF(tax_rate,''),CASE
  WHEN ${v24ModeText}<>'' AND (${v24Mode}) IS NULL
  THEN '口径：'||tax_mode END),'')`;

function stageOrderTax(db: DatabaseSync, table: 'orders' | 'order_lines') {
  db.exec(`ALTER TABLE ${table} ADD COLUMN tax_rate_bp INTEGER;
    ALTER TABLE ${table} ADD COLUMN tax_text TEXT;
    UPDATE ${table} SET tax_rate_bp=${v24Rate}, tax_mode=${v24Mode}, tax_text=${v24Text};`);
}

/** 状态操作重试仍要返回当时的订单结果，所以原结果只换税费字段的形状，保留请求摘要和其余快照。 */
function migrateOrderStatusResults(db: DatabaseSync) {
  const patch = (source: string) => `(SELECT json_patch(${source},json_object(
    'taxRate',${v24Rate}/100.0,'taxMode',${v24Mode},'taxText',${v24Text}))
    FROM (SELECT json_extract(${source},'$.taxRate') AS tax_rate, json_extract(${source},'$.taxMode') AS tax_mode))`;
  db.exec(`UPDATE operation_requests
    SET result=json_set(${patch('result')},'$.lines',(
      SELECT json_group_array(json(${patch('item.value')}) ORDER BY item.key)
      FROM json_each(result,'$.lines') AS item
    ))
    WHERE kind='order-status';`);
}

function rebuildOrderTax(db: DatabaseSync) {
  stageOrderTax(db, 'orders');
  rebuildTable(
    db, 'orders',
    `id INTEGER PRIMARY KEY AUTOINCREMENT,
      number TEXT NOT NULL UNIQUE,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      customer_name TEXT NOT NULL,
      order_date TEXT NOT NULL CHECK(order_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(order_date) IS order_date),
      delivery_date TEXT NOT NULL CHECK(delivery_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(delivery_date) IS delivery_date),
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
      cost_estimate TEXT CHECK(cost_estimate IS NULL OR (json_valid(cost_estimate) AND json_type(cost_estimate)='object')),
      terms TEXT`,
    'id,number,customer_id,customer_name,order_date,delivery_date,status,total_cents,currency,rounding_policy,' +
      'tax_rate_bp,tax_mode,tax_text,external_purchase_order,supplier_name,version,created_at,updated_at,notes,cost_estimate,terms',
  );
  stageOrderTax(db, 'order_lines');
  rebuildTable(
    db, 'order_lines',
    `id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id),
      product_id INTEGER NOT NULL REFERENCES products(id),
      quantity INTEGER NOT NULL CHECK(quantity>0),
      unit TEXT NOT NULL DEFAULT '只' CHECK(unit='只'),
      unit_price_e4 INTEGER NOT NULL CHECK(unit_price_e4>=0),
      unit_price_cents INTEGER GENERATED ALWAYS AS ((unit_price_e4+50)/100) VIRTUAL,
      delivery_date TEXT CHECK(delivery_date IS NULL OR (delivery_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(delivery_date) IS delivery_date)),
      tax_rate_bp INTEGER CHECK(tax_rate_bp IS NULL OR tax_rate_bp BETWEEN 0 AND 10000),
      tax_mode TEXT CHECK(tax_mode IS NULL OR tax_mode IN ('含税','未税','未明确')),
      tax_text TEXT,
      customer_product_code TEXT,
      product_name TEXT NOT NULL,
      specification TEXT NOT NULL,
      notes TEXT`,
    'id,order_id,product_id,quantity,unit,unit_price_e4,delivery_date,tax_rate_bp,tax_mode,tax_text,customer_product_code,product_name,specification,notes',
  );
  db.exec(`CREATE INDEX orders_filter ON orders(customer_id,order_date,status);
    CREATE INDEX order_lines_order ON order_lines(order_id);
    CREATE INDEX order_lines_product ON order_lines(product_id);`);
  migrateOrderStatusResults(db);
}

/*
 * v25 的片段。名字、上限都写成字面量：升级结果固定在这一步，不随程序以后改常量、改上限而变。
 * 空白清单就是 JS trim() 认的那一套（半角、全角、制表、换行和别的 Unicode 空白），SQLite 默认的 trim 只去半角空格。
 */
const v25Blank = 'char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)';
const v25Trim = (sql: string) => `trim(${sql},${v25Blank})`;
const v25Field = (key: string) => v25Trim(`coalesce(json_extract(d.document,'$.${key}'),'')`);
/** 厂区录入每一项最多几个字（customerSiteInputSchema 的联系人、联系方式、地址） */
const v25SiteMax = { contact: 60, phone: 50, address: 300 } as const;
/**
 * 这一项在不在厂区录入的上限以内，超了的不建厂区：升级不造程序不收的数据。按 JS 字符串长度比，四字节的字（表情等）
 * 算 2，SQLite 的 length 按字算，所以另数编号大于 65535 的字；现在的 zod 按码位数（四字节的字算 1），这里只会更严。
 * 最多数到最长的上限就够（upto），再长的 length 已经超了。length 只数到 NUL，带 NUL 的一律算超长。
 */
const v25Fits = (column: keyof typeof v25SiteMax) => `(instr(${column},char(0))=0 AND length(${column})+(
  SELECT count(*) FROM upto WHERE i<=length(${column}) AND unicode(substr(${column},i,1))>65535)<=${v25SiteMax[column]})`;
/** 要挂厂区的待送货单：没挂厂区（归档的也算）、客户还在，三项去首尾空白后不全空、都在厂区录入的上限以内 */
const v25Pending = `upto(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM upto WHERE i<${Math.max(...Object.values(v25SiteMax))}),
  drafts AS (
    SELECT d.id, c.id AS customer_id, ${v25Field('address')} AS address, ${v25Field('contact')} AS contact,
      ${v25Field('phone')} AS phone
    FROM flow_documents d JOIN customers c ON c.id=json_extract(d.document,'$.customerId')
    WHERE d.kind='delivery' AND d.status='draft' AND json_extract(d.document,'$.siteId') IS NULL
  ),
  pending AS (
    SELECT * FROM drafts WHERE address||contact||phone<>''
      AND ${v25Fits('address')} AND ${v25Fits('contact')} AND ${v25Fits('phone')}
  )`;
/** 这家客户名下三项逐字相同的厂区（同一客户这样的厂区至多一个） */
const v25SameSite = 's.customer_id=p.customer_id AND s.address=p.address AND s.contact=p.contact AND s.phone=p.phone';

/**
 * v25：建厂区表，按客户档案回填默认厂区，再给 0.9.5 留下的待送货单挂上厂区（以后照常保存，收货信息不变）。
 * - 档案三项去首尾空白后不全空的，回填“默认厂区”，时间取档案的。
 * - 待送货单三项和档案一样的，挂默认厂区；不一样的，同一客户三项相同的几张补建一个厂区：客户一个厂区都没有时，
 *   编号最小那组叫“默认厂区”并当默认，别的叫“送货单 <组里编号最小那张的单号> 的地址”；时间取那张单的建单时间。
 *   单号唯一、不带空白，补建的名字互相不重，也不和“默认厂区”重（照 looseKey 比也一样）。
 * - 三项全空的、超出厂区录入上限的、客户已不在的待送货单，和已出库、已取消、已撤销的单据一字不动。
 * - 只往单据内容末尾加 siteId、siteName，版本号、更新时间和别的内容不变，不写审计。
 * 每张单的结果只看它自己的三项和厂区表，求值顺序不影响结果。
 */
function addCustomerSites(db: DatabaseSync) {
  db.exec(customerSitesV25);
  db.exec(`INSERT INTO customer_sites(customer_id,name,contact,phone,address,is_default,created_at,updated_at)
    SELECT id,'默认厂区',${v25Trim('contact')},${v25Trim('phone')},${v25Trim('address')},1,created_at,updated_at
    FROM customers WHERE ${v25Trim('address||contact||phone')}<>'' ORDER BY id;`);
  db.exec(`WITH RECURSIVE ${v25Pending},
    groups AS (
      SELECT customer_id, address, contact, phone, MIN(id) AS first_id FROM pending p
      WHERE NOT EXISTS(SELECT 1 FROM customer_sites s WHERE ${v25SameSite})
      GROUP BY customer_id, address, contact, phone
    ),
    placed AS (
      SELECT g.*, d.number, d.created_at,
        NOT EXISTS(SELECT 1 FROM customer_sites s WHERE s.customer_id=g.customer_id)
          AND g.first_id=MIN(g.first_id) OVER (PARTITION BY g.customer_id) AS is_default
      FROM groups g JOIN flow_documents d ON d.id=g.first_id
    )
    INSERT INTO customer_sites(customer_id,name,contact,phone,address,is_default,created_at,updated_at)
    SELECT customer_id, CASE WHEN is_default THEN '默认厂区' ELSE '送货单 '||number||' 的地址' END,
      contact, phone, address, is_default, created_at, created_at
    FROM placed ORDER BY customer_id, first_id;`);
  db.exec(`WITH RECURSIVE ${v25Pending}
    UPDATE flow_documents SET document=json_set(document,'$.siteId',s.id,'$.siteName',s.name)
    FROM pending p JOIN customer_sites s ON ${v25SameSite}
    WHERE flow_documents.id=p.id;`);
}

export const upgradeSteps: readonly UpgradeStep[] = [
  {
    version: 21,
    name: '财务事件加上一条、往来单位、单号、金额、缺税率几列',
    // 加列、建索引，再从快照回填：往来单位按快照里有客户还是供应商定种类（送货只有客户、到货只有供应商），
    // 编号存文字；单号取单据号，没有取对方单号；缺税率看 missing 里有没有 tax。启用前的事件快照是 {}，回填出来全是空和 0。
    // 上一条和单据金额以后只存在列里，回填完从快照里去掉。和 server/finance/event-columns.ts 的 eventColumns 同一个取法。
    // 以前资料待补的事件重新评估时会把快照里的上一条写成它自己（真正的上一条已经丢了），这种回填成空
    up: (db) =>
      db.exec(`ALTER TABLE fin_events ADD COLUMN previous_event_id INTEGER REFERENCES fin_events(id);
        ALTER TABLE fin_events ADD COLUMN previous_status TEXT CHECK(previous_status IS NULL OR previous_status IN ('ready','info_pending','waiting_invoice','generated','difference','source_deleted','awaiting_allocation_reversal','cost_pending','costed','no_amount','corrected','superseded','before_opening'));
        ALTER TABLE fin_events ADD COLUMN party_kind TEXT CHECK(party_kind IS NULL OR party_kind IN ('customer','supplier'));
        ALTER TABLE fin_events ADD COLUMN party_id TEXT CHECK((party_kind IS NULL)=(party_id IS NULL));
        ALTER TABLE fin_events ADD COLUMN party_name TEXT;
        ALTER TABLE fin_events ADD COLUMN source_number TEXT;
        ALTER TABLE fin_events ADD COLUMN document_cents INTEGER;
        ALTER TABLE fin_events ADD COLUMN theoretical_cents INTEGER;
        ALTER TABLE fin_events ADD COLUMN missing_tax INTEGER NOT NULL DEFAULT 0 CHECK(missing_tax IN (0,1));
        CREATE INDEX fin_events_previous ON fin_events(previous_event_id);
        CREATE INDEX fin_events_party ON fin_events(party_kind,party_id);
        UPDATE fin_events SET
          previous_event_id=NULLIF(json_extract(snapshot,'$.previous.eventId'),id),
          previous_status=CASE WHEN json_extract(snapshot,'$.previous.eventId')=id THEN NULL
            ELSE json_extract(snapshot,'$.previous.status') END,
          party_kind=CASE WHEN json_extract(snapshot,'$.doc.customerId') IS NOT NULL THEN 'customer'
            WHEN json_extract(snapshot,'$.doc.supplierId') IS NOT NULL THEN 'supplier' END,
          party_id=CAST(coalesce(json_extract(snapshot,'$.doc.customerId'),json_extract(snapshot,'$.doc.supplierId')) AS TEXT),
          party_name=coalesce(json_extract(snapshot,'$.doc.customerName'),json_extract(snapshot,'$.doc.supplierName')),
          source_number=coalesce(json_extract(snapshot,'$.doc.number'),json_extract(snapshot,'$.doc.reference')),
          document_cents=json_extract(snapshot,'$.documentAmount'),
          theoretical_cents=json_extract(snapshot,'$.theoretical.gross'),
          missing_tax=EXISTS(SELECT 1 FROM json_each(snapshot,'$.missing') WHERE value='tax');
        UPDATE fin_events SET snapshot=json_remove(snapshot,'$.previous','$.documentAmount');`),
  },
  {
    version: 22,
    name: '归档标记、永久删除墓碑的记录种类不再写死',
    // 两张表的 entity 原来列死了 10 种记录（客户、产品……四种单据），以后加能归档的记录要重建表；
    // 改成只要求不为空，能记哪些种类由各模块登记、写入前核对（server/core/record-kinds.ts）。
    // CHECK 改不了，两张都按官方做法重建（rebuildTable），每一行连 rowid 原样搬过去；除了主键没有别的索引。
    // 两张表都不是自增表，没有别的表用外键引用它们，也没有触发器、视图用到它们
    up: (db) => {
      rebuildTable(
        db,
        'record_lifecycle',
        `entity TEXT NOT NULL CHECK(length(entity)>0),
          record_id INTEGER NOT NULL CHECK(record_id>0),
          archived_at TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          PRIMARY KEY(entity,record_id)`,
        'entity,record_id,archived_at,actor_id',
      );
      rebuildTable(
        db,
        'permanent_record_deletions',
        `entity TEXT NOT NULL CHECK(length(entity)>0),
          record_id INTEGER NOT NULL CHECK(record_id>0),
          deleted_at TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          label TEXT NOT NULL,
          PRIMARY KEY(entity,record_id)`,
        'entity,record_id,deleted_at,actor_id,label',
      );
    },
  },
  {
    version: 23,
    name: '产品加所属客户列，并按订单明细回填只给一家客户下过单的产品',
    // 产品可以不属任何客户（customer_id 可空）。历史上没记过归属，按订单明细反推：
    // 只给一家客户下过单的（含已归档产品）记到那家；没下过单或给两家以上下过单的留空，由人在界面确认。
    up: (db) =>
      db.exec(`ALTER TABLE products ADD COLUMN customer_id INTEGER REFERENCES customers(id);
        CREATE INDEX products_customer ON products(customer_id);
        UPDATE products SET customer_id=(
          SELECT MIN(o.customer_id)
          FROM order_lines l
          JOIN orders o ON o.id=l.order_id
          WHERE l.product_id=products.id
          HAVING COUNT(DISTINCT o.customer_id)=1
        );`),
  },
  {
    version: 24,
    name: '订单和明细的税率改存万分比、含税口径和原话',
    up: rebuildOrderTax,
  },
  {
    version: 25,
    name: '客户加收货厂区，按已有联系方式回填默认厂区，给没挂厂区的待送货单挂上',
    up: addCustomerSites,
  },
];
