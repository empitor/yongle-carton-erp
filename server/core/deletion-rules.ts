import type { SQLOutputValue } from 'node:sqlite';
import type { Store } from './db.js';
import type { Actor } from './actor.js';
import { AppError } from './errors.js';
import { count } from './sql.js';

/*
 * 删除记录、初始化时各模块登记的规则。删除路径（业务汇总的删除引擎 database-maintenance.ts、
 * 数据管理的初始化）只调这里登记的规则，不直接写别的模块的表：
 * - 规划：某条记录删了，哪些行要跟着删、哪些行要解除引用，由知道这层关系的模块判断（只读、只标记）。一般是表的主人；
 *   被删单据的库存流水删还是留由单据流转判断（只有它知道哪些流水来自这些单据），写仍由采购库存做；
 * - 写：删、改自己表里的行，连带的修订记录、版本号由表的主人做；
 * - 记录删掉前要配合的事（比如识别导入给导入记录打“已永久删除”标记）；
 * - 初始化时清空自己的表。
 * 各模块加载时登记（各自的 deletion.ts，由模块的 index.ts 引入）。要用到却没登记的报错，不会悄悄跳过。
 */

// ———————————————————— 删除时的行 ————————————————————

/** 删除时的一行：带 rowid，列只有规划时读过的那些（见 DeletionPlanner.columns），值是库里读出来的原样 */
export type DeletionRow = Record<string, SQLOutputValue> & { __rowid: number };
/** 删除时改一行要写的值（列 → 新值），和读出来的值是同一种 */
type DeletionValues = Record<string, SQLOutputValue>;
/** 一次删除的上下文：谁删的、什么时候、这次删除的请求编号 */
export type DeletionContext = {
  actor: Actor;
  at: string;
  mark: Record<string, unknown>;
  /** 这次删除里改过的行（改之前的样子），记录删掉前要配合的模块用它找“刚被解除引用的行” */
  updated(table: string): DeletionRow[];
};

/**
 * 规划时删除引擎提供的视图。rows 读的是整张表（只读规划要用的列），remove、patch 只做标记，
 * 规划完一起交给表的主人写。
 */
export type DeletionGraph = {
  /** 库存处理方式：recalculate 是被删单据的出入库流水一起删、库存重算；preserve 是流水留着、改成“系统维护”流水（来源 database-maintenance） */
  policy: 'preserve' | 'recalculate';
  rows(table: string): DeletionRow[];
  gone(table: string, row: DeletionRow): boolean;
  /** 标成要删；已经标过返回 false */
  remove(table: string, row: DeletionRow): boolean;
  patch(table: string, row: DeletionRow, value: DeletionValues): void;
  /** 改单据 JSON：影响清单按 field 显示解除的是哪种关联 */
  patchDocument(table: string, row: DeletionRow, doc: unknown, field: string): void;
  /** 这一行加上已经标记的改动 */
  changed(table: string, row: DeletionRow): DeletionRow;
  /** 这张表里标成要删的行的 id */
  ids(table: string): Set<SQLOutputValue>;
  /** 按 id 找行（影响清单起名字用） */
  byId(table: string): Map<SQLOutputValue, DeletionRow>;
  /** 记一笔要按库存处理方式决定去留的流水（0 笔时界面不显示这个选项） */
  countInventoryChoice(): void;
};
export type DeletionPlanner = {
  /** cascade：反复执行直到没有新的要删的行；after：连带范围定了以后执行一次 */
  phase: 'cascade' | 'after';
  /** 同一阶段里按 order 从小到大执行（影响清单和范围摘要的顺序跟着它） */
  order: number;
  /** 返回 true 表示这一轮标了新的要删的行 */
  run(g: DeletionGraph): boolean | void;
};

/** 表的主人登记：这几张表删除时怎么写、规划时要多读哪些列、影响清单里怎么称呼一行 */
export type TableDeletionRules = {
  module: string;
  /** 每张表的写法：写着表名的语句由主人提供（`UPDATE 表 SET`、`DELETE FROM 表 WHERE rowid=?`） */
  statements: Record<string, { update: string; remove: string }>;
  /** 规划时除了主键、外键、单号、名称、状态、版本以外还要读的列（'all' 是整行） */
  columns?: Record<string, string[] | 'all'>;
  /**
   * 镜像字段（表 → 外键列 → document 里的字段）：外键列的值在这一行的 document 里还留着同名字段的（两边同写，
   * 库里有 CHECK 核对一致）。删除引擎把这列置空时，把 document 里的字段一起清掉，和置空合成同一句 UPDATE；
   * remove 是去掉这个键，null 是写成 null。登记了镜像的表规划时自动多读 document 列。
   */
  mirrors?: Record<string, Record<string, { field: string; clear: 'remove' | 'null' }>>;
  /** 改一行之前、删一行之前主人要做的（修订记录等），和写在同一个事务里 */
  beforeUpdate?(store: Store, ctx: DeletionContext, table: string, row: DeletionRow, values: DeletionValues): void;
  beforeRemove?(store: Store, ctx: DeletionContext, table: string, row: DeletionRow): void;
  /** 改完一行之后（比如所属采购单、产品的版本号加一） */
  afterUpdate?(store: Store, ctx: DeletionContext, table: string, row: DeletionRow): void;
  /** 影响清单里这一行叫什么（没给就用单号、名称、编号） */
  label?(table: string, row: DeletionRow, g: Pick<DeletionGraph, 'byId'>): string | undefined;
  planners?: DeletionPlanner[];
};
const tableRules = new Map<string, TableDeletionRules>();
/** 全部登记（只登记规划规则、不登记表的也在这里，规划规则不会因此漏掉） */
const allRules: TableDeletionRules[] = [];
export function registerTableDeletion(r: TableDeletionRules) {
  for (const t of Object.keys(r.statements)) {
    const owner = tableRules.get(t);
    if (owner && owner.module !== r.module) throw new AppError(t + ' 表的删除规则已由' + owner.module + '登记。', 500);
    tableRules.set(t, r);
  }
  allRules.push(r);
}
/** 删除要哪些模块配合：调用方先确认它们都登记了，免得规划时少算一块 */
export function requireDeletionModules(modules: readonly string[]) {
  const missing = modules.filter((m) => !allRules.some((r) => r.module === m));
  if (missing.length) throw new AppError('删除记录要' + missing.join('、') + '模块配合，但它们没有加载。', 500);
}
const unregistered = (table: string) =>
  new AppError('删除要改“' + table + '”表，但它所属的模块没有登记删除规则。', 500);
function rulesOf(table: string) {
  const r = tableRules.get(table);
  if (!r) throw unregistered(table);
  return r;
}
/** 规划完就查：要删、要改的每张表都有主人登记了写法（预览时就报，不等用户点了确认） */
export function requireDeletionTables(tables: Iterable<string>) {
  for (const t of tables) if (!tableRules.has(t)) throw unregistered(t);
}
export function deletionPlanners(phase: DeletionPlanner['phase']) {
  return allRules
    .flatMap((r) => r.planners || [])
    .filter((p) => p.phase === phase)
    .sort((a, b) => a.order - b.order);
}
export function deletionColumns(table: string) {
  const r = tableRules.get(table),
    columns = r?.columns?.[table];
  // 登记了镜像字段的表：清 document 里的字段要先读到它
  if (!r?.mirrors?.[table] || columns === 'all' || columns?.includes('document')) return columns;
  return [...(columns || []), 'document'];
}
/** 这个外键列在 document 里有没有登记镜像字段 */
export function deletionMirror(table: string, column: string) {
  return tableRules.get(table)?.mirrors?.[table]?.[column];
}
export function deletionLabel(table: string, row: DeletionRow, g: Pick<DeletionGraph, 'byId'>) {
  return tableRules.get(table)?.label?.(table, row, g);
}

const quote = (s: string) => '"' + s.replaceAll('"', '""') + '"';
/** 改一行：交给表的主人（主人的语句、修订记录、版本号）。有 version 列的版本号加一，打开着的编辑窗保存时会提示刷新 */
export function deletionUpdate(store: Store, ctx: DeletionContext, table: string, row: DeletionRow, values: DeletionValues) {
  const r = rulesOf(table),
    fields = Object.keys(values);
  if (!fields.length) return;
  r.beforeUpdate?.(store, ctx, table, row, values);
  store.db
    .prepare(
      r.statements[table].update +
        ' ' +
        fields.map((k) => quote(k) + '=?').join(',') +
        (Object.hasOwn(row, 'version') ? ',version=version+1' : '') +
        ' WHERE rowid=?',
    )
    .run(...fields.map((k) => values[k]), row.__rowid);
  r.afterUpdate?.(store, ctx, table, row);
}
/** 删一行：交给表的主人 */
export function deletionRemove(store: Store, ctx: DeletionContext, table: string, row: DeletionRow) {
  const r = rulesOf(table);
  r.beforeRemove?.(store, ctx, table, row);
  store.db.prepare(r.statements[table].remove).run(row.__rowid);
}

// ———————————————————— 记录删掉前要配合的事 ————————————————————

/** 某种记录（orders、products……）删掉前，别的模块要做的事。删除引擎在删这条记录之前调 */
type RecordDeletedHook = (store: Store, ctx: DeletionContext, id: number) => void;
const recordHooks = new Map<string, { module: string; hook: RecordDeletedHook }[]>();
export function registerRecordDeletion(module: string, entity: string, hook: RecordDeletedHook) {
  recordHooks.set(entity, [...(recordHooks.get(entity) || []), { module, hook }]);
}
export function beforeRecordDeleted(store: Store, ctx: DeletionContext, entity: string, id: number) {
  for (const { hook } of recordHooks.get(entity) || []) hook(store, ctx, id);
}

// ———————————————————— 初始化 ————————————————————

/**
 * 初始化（清空业务数据）时各模块清自己的表。statements 是写着自己表名的清空语句（`DELETE FROM 表`，可带 WHERE），
 * 清空前给人看的条数也从同一句算出来（同一张表、同一个条件），两份不会对不上。
 * finance 标记的只在“连财务一起清”时清。
 */
export type ResetRules = {
  module: string;
  finance?: boolean;
  /** 清空顺序：小的先清（先清引用别人的表） */
  order: number;
  statements: string[];
  /** 清完之后要做的（财务：清掉启用月份、科目的“用过”标记） */
  after?(store: Store): void;
  /** 财务：已经结账的期间，初始化要用户在预览里明确勾选才清 */
  closedPeriods?(store: Store): { period: string; version: number }[];
};
const resetRules = new Map<string, ResetRules>();
export function registerReset(r: ResetRules) {
  for (const s of r.statements)
    if (!/^DELETE FROM \w+( WHERE .+)?$/.test(s)) throw new AppError(r.module + '登记的清空语句格式不对：' + s, 500);
  resetRules.set(r.module, r);
}
/**
 * 参加初始化的模块：modules 是必须登记了的（没登记报错，不会悄悄少清一块）；另外登记了的模块也一起清，
 * 新模块登记了就会参加。财务只在 includeFinance 时参加。
 */
export function resetParticipants(modules: readonly string[], includeFinance: boolean) {
  const need = includeFinance ? [...modules, '财务'] : modules;
  const missing = need.filter((m) => !resetRules.has(m));
  if (missing.length) throw new AppError('初始化要' + missing.join('、') + '模块配合，但它们没有加载。', 500);
  return [...resetRules.values()]
    .filter((r) => (r.finance ? includeFinance : true))
    .sort((a, b) => a.order - b.order);
}
/** 各张表现在有多少条（按清空语句的同一个条件数） */
export function resetCounts(store: Store, r: ResetRules): Record<string, number> {
  return Object.fromEntries(
    r.statements.map((s) => [
      s.split(' ')[2],
      count(store.db, s.replace(/^DELETE FROM /, 'SELECT COUNT(*) AS n FROM ')),
    ]),
  );
}
export function resetClear(store: Store, r: ResetRules) {
  for (const s of r.statements) store.db.exec(s);
  r.after?.(store);
}
