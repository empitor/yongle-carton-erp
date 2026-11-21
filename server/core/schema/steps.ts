import type { DatabaseSync } from 'node:sqlite';

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
 * tests/schema-evolution.test.ts 会核对“空库新建”和“从第 20 版一路升级上来”的结构完全一样。
 * 每一步还要带一份升级前后的小数据样例：tests/fixtures/upgrade-samples/v<版本号>.json，
 * 写 before（升级前写进库的行）和 after（这一步跑完应有的行，只写要核对的列），写法见 tests/upgrade-step-samples.test.ts 开头；
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
 *   （UPDATE sqlite_sequence，新名还没有这一行就 INSERT），并在 tests/schema-evolution.test.ts 的 autoIncrementTableChanges 登记，
 *   删掉自增表也在那里登记。那边的“从第 20 版快照升级”测试会核对每张自增表的计数都没有回头。
 * - 步骤里不能 VACUUM，不能改 page_size、auto_vacuum（事务里做不了）；回填数据不能依赖当前时间。
 * - 新表照常登记表的主人、删除和初始化规则。
 * - 表一律建成 STRICT（列类型只能是 INTEGER、REAL、TEXT、BLOB）。状态、种类这类固定取值的列加枚举 CHECK，
 *   业务日期、会计期间、JSON 列用 tables/checks.ts 里的片段；会随功能增加的列（审计的来源和动作、防重复提交的种类这些）不列枚举。
 *   枚举在建表里写死，所属模块里要有同一份常量，并登记到 tests/schema-constraints.test.ts（那边逐个比对）。
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
];
