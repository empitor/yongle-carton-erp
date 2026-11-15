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
 * 第 20 版（0.9.0 基线）之后的升级步骤，版本号从 21 起连续。0.9.0 还没有步骤。
 *
 * 0.9.0 发布之前改结构，直接改 tables/ 里的建表语句，不写步骤（库还没发布过）。
 * 发布以后每次改结构：在这里加一步，同时把 tables/ 改成改完以后的完整结构，再把 version.ts 的 SCHEMA_LATEST 加一。
 * tests/schema-evolution.test.ts 会核对“空库新建”和“从第 20 版一路升级上来”的结构完全一样。
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
 * - SQLite 的 CHECK 不能单独改：给枚举加一个值、放宽或收紧一条约束，都要重建那张表（见上面“重建表”）。
 */
export const upgradeSteps: readonly UpgradeStep[] = [];
