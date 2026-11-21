import { z } from 'zod';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import type { Store } from '../core/index.js';
import { AppError, many, one, parseStoredJson, previewDigest } from '../core/index.js';
import { deletionColumns, deletionMirror, deletionPlanners, requireDeletionTables, requireRecordDeletionHook } from '../core/index.js';
import type { DeletionGraph, DeletionRow as Row } from '../core/index.js';
import { deletionSelection, flowDocumentContent, flowDocumentSchema, flowKinds } from '../../shared/business/index.js';
import { impactList, inventoryFigures } from './deletion-impact.js';

/*
 * 删除范围（删除引擎的规划部分，只读）：选了哪些记录，按数据库外键和各模块登记的删除规则（server/core/deletion-rules.ts）
 * 算出连带删哪些行、解除哪些引用，带影响清单和范围摘要。真删在 database-maintenance.ts。
 */

export const quote = (s: string) => '"' + s.replaceAll('"', '""') + '"';
/** 选了哪些记录（结构在 shared/business/deletion-request.ts，删除接口和助手共用） */
type Selection = z.output<typeof deletionSelection>;

/** 业务记录的表：删它们记审计、记“删掉的记录”（database-maintenance.ts）；算“有没有独立影响”也看它们 */
export const businessTables = new Set([
  'customers',
  'products',
  'orders',
  'suppliers',
  'purchases',
  'stock_items',
  'flow_documents',
]);

/** 删除时改一行要写的值（列 → 新值） */
type DeletionValues = Parameters<DeletionGraph['patch']>[2];
type Mirror = NonNullable<ReturnType<typeof deletionMirror>>;
/** 数据库外键：子表 table 的 from 列引用父表 parent 的 to 列 */
type ForeignKey = { table: string; parent: string; from: string; to: string };

/** 库里读出来的一个值（node:sqlite 交出来的几种） */
const sqlValue = z.custom<SQLOutputValue>(
  (v) => v === null || ['number', 'bigint', 'string'].includes(typeof v) || v instanceof Uint8Array,
);
/** 规划时读的一行：rowid 加上规划要用的列，值是库里的原样 */
const deletionRow = z.object({ __rowid: z.number() }).catchall(sqlValue);
const tableName = z.object({ name: z.string() });
/** PRAGMA foreign_key_list：to 为空表示引用父表的主键 */
const foreignKeyRow = z.object({ table: z.string(), from: z.string(), to: z.string().nullable() });
const columnInfo = z.object({ name: z.string(), notnull: z.number(), pk: z.number() });
/** 每张表都读的列（判断关联、影响清单起名、版本核对要用） */
const ALWAYS_READ = ['id', 'number', 'name', 'kind', 'status', 'version'];
/** 通用的外键规划夹在各模块登记的规划中间的位置：order 小于它的先跑，其余后跑 */
const FOREIGN_KEY_ORDER = 60;

/** 取 map 里 key 的值，没有就建一个放进去 */
function entry<K, V>(map: Map<K, V>, key: K, create: () => V): V {
  const found = map.get(key);
  if (found !== undefined) return found;
  const made = create();
  map.set(key, made);
  return made;
}
/** 按表名算一次、记住结果 */
function perTable<V>(compute: (table: string) => V) {
  const cache = new Map<string, V>();
  return (table: string) => entry(cache, table, () => compute(table));
}

/** 库的结构：全部外键、某列能不能为空，和规划时每张表要读哪些列 */
function schemaFacts(db: DatabaseSync) {
  const tables = many(db, tableName, "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'");
  const refs: ForeignKey[] = tables.flatMap(({ name: t }) =>
    many(db, foreignKeyRow, 'PRAGMA foreign_key_list(' + quote(t) + ')').map((r) => ({
      table: t,
      parent: r.table,
      from: r.from,
      to: r.to || 'id',
    })),
  );
  const info = perTable((t) => many(db, columnInfo, 'PRAGMA table_info(' + quote(t) + ')'));
  const nullable = (t: string, column: string) => !info(t).find((r) => r.name === column)?.notnull;
  const referenced = (t: string, column: string) =>
    refs.some((r) => (r.table === t && r.from === column) || (r.parent === t && r.to === column));
  // 每张表只读判断关联要用的列：主键、外键、被引用的列，单号/名称/版本，加上表的主人登记要读的列（单据 JSON 等）。
  // 唛头文件、助手附件这类大文件内容不读进内存；真删的时候按 rowid 删，审计要的整行到时再按 rowid 取。
  const columns = perTable((t) => {
    const extra = deletionColumns(t);
    const keep = info(t)
      .filter(
        (c) =>
          extra === 'all' ||
          c.pk > 0 ||
          ALWAYS_READ.includes(c.name) ||
          extra?.includes(c.name) ||
          referenced(t, c.name),
      )
      .map((c) => quote(c.name));
    return ['rowid AS __rowid', ...keep].join(',');
  });
  return { refs, nullable, columns };
}
type SchemaFacts = ReturnType<typeof schemaFacts>;

/** 规划的过程：读过的整表、标成要删的行、要改的值、单据 JSON 里解除的是哪种关联；只标记，不写库 */
function planState(db: DatabaseSync, columns: (table: string) => string, policy: Selection['inventoryPolicy']) {
  const rows = perTable((t) => many(db, deletionRow, 'SELECT ' + columns(t) + ' FROM ' + quote(t)));
  const removed = new Map<string, Set<number>>(),
    patches = new Map<string, Map<number, DeletionValues>>(),
    // 单据 JSON 里解除的是哪种关联：影响清单按这个名字显示，不笼统写“单据内关联”
    documentFields = new Map<string, Map<number, Set<string>>>();
  const gone = (t: string, row: Row) => removed.get(t)?.has(row.__rowid) ?? false;
  const remove = (t: string, row: Row) => {
    const set = entry(removed, t, () => new Set<number>());
    if (set.has(row.__rowid)) return false;
    set.add(row.__rowid);
    return true;
  };
  const patch = (t: string, row: Row, value: DeletionValues) => {
    const map = entry(patches, t, () => new Map<number, DeletionValues>());
    map.set(row.__rowid, { ...map.get(row.__rowid), ...value });
  };
  const noteDocumentField = (t: string, row: Row, field: string) =>
    entry(entry(documentFields, t, () => new Map<number, Set<string>>()), row.__rowid, () => new Set<string>()).add(field);
  const patchDocument = (t: string, row: Row, doc: unknown, field: string) => {
    patch(t, row, { document: JSON.stringify(doc) });
    noteDocumentField(t, row, field);
  };
  // 标成要删的行里某一列的值；表里没有要删的行就不必读它（父表可能是存大文件的表）
  const removedValues = (t: string, column: string) =>
    removed.get(t)?.size
      ? new Set(rows(t).filter((r) => gone(t, r)).map((r) => r[column]))
      : new Set<SQLOutputValue>();
  let inventoryChoice = 0;
  const g: DeletionGraph = {
    policy,
    rows,
    gone,
    remove,
    // 规划规则直接改 document（没说是哪种关联）：影响清单里记成“单据内关联”，和说得出名字的并列
    patch: (t, row, value) => {
      patch(t, row, value);
      if (Object.hasOwn(value, 'document')) noteDocumentField(t, row, 'document');
    },
    patchDocument,
    changed: (t, row) => ({ ...row, ...patches.get(t)?.get(row.__rowid) }),
    ids: (t) => removedValues(t, 'id'),
    byId: perTable((t) => new Map<SQLOutputValue, Row>(rows(t).map((r) => [r.id, r]))),
    // 有几笔流水要看“库存处理方式”决定去留；0 笔时界面不显示这个选项
    countInventoryChoice: () => void inventoryChoice++,
  };
  const byRowid = perTable((t) => new Map<number, Row>(rows(t).map((r) => [r.__rowid, r])));
  const rowOf = (t: string, rowid: number) => {
    const row = byRowid(t).get(rowid);
    if (!row) throw new Error('删除规划要改的行不在 ' + t + ' 表里（rowid ' + rowid + '）');
    return row;
  };
  return {
    g,
    patch,
    removedValues,
    documentFields,
    inventoryChoice: () => inventoryChoice,
    deletions: () =>
      [...removed].flatMap(([t, set]) =>
        rows(t)
          .filter((r) => set.has(r.__rowid))
          .map((r) => ({ table: t, row: r })),
      ),
    updates: () =>
      [...patches].flatMap(([t, map]) =>
        [...map]
          .filter(([rowid]) => !removed.get(t)?.has(rowid))
          .map(([rowid, value]) => ({ table: t, row: rowOf(t, rowid), value })),
      ),
  };
}
type PlanState = ReturnType<typeof planState>;

/**
 * 镜像字段（外键列在 document 里的同名字段）只登记在单据表上（server/flow/deletion.ts）：
 * 按库里的单据结构读出这一行现在的内容，清掉这个字段，交回要写的内容
 */
function withoutMirror(row: Row, mirror: Mirror) {
  const kind = flowKinds.find((k) => k === row.kind),
    text = row.document;
  if (!kind || typeof text !== 'string')
    throw new Error('登记了镜像字段的只有单据表，这一行不是单据（rowid ' + row.__rowid + '）');
  const doc = parseStoredJson(flowDocumentSchema(kind), text, 'flow_documents.document（单据 ' + row.__rowid + '）');
  const content: Record<string, unknown> = { ...flowDocumentContent(doc) };
  return mirror.clear === 'remove'
    ? Object.fromEntries(Object.entries(content).filter(([key]) => key !== mirror.field))
    : { ...content, [mirror.field]: null };
}

/**
 * 数据库外键：拥有型子记录删除，可空引用解除，不把历史状态作为删除条件。
 * 这一步是通用的，夹在各模块登记的规划中间（FOREIGN_KEY_ORDER）。返回这一轮有没有标新的要删的行。
 */
function foreignKeyStep(state: PlanState, facts: SchemaFacts) {
  const { g } = state;
  // 可空的引用解除：列置空。这一列在 document 里还留着同名字段（镜像字段）的一起清掉：同一行的改动最后合成一句 UPDATE，
  // 列和 document 同时变，表上核对两边一致的 CHECK 才过得去；影响清单里按这一列的叫法显示，不另算一项
  const detach = (ref: ForeignKey, row: Row) => {
    state.patch(ref.table, row, { [ref.from]: null });
    const mirror = deletionMirror(ref.table, ref.from);
    if (mirror) g.patchDocument(ref.table, row, withoutMirror(g.changed(ref.table, row), mirror), ref.from);
  };
  return () => {
    let progress = false;
    for (const ref of facts.refs) {
      const values = state.removedValues(ref.parent, ref.to);
      if (!values.size) continue;
      for (const row of g.rows(ref.table)) {
        if (g.gone(ref.table, row) || !values.has(g.changed(ref.table, row)[ref.from])) continue;
        if (facts.nullable(ref.table, ref.from)) detach(ref, row);
        else progress = g.remove(ref.table, row) || progress;
      }
    }
    return progress;
  };
}

/** 连带范围：各模块登记的规划和外键规划反复跑到没有新的要删的行，再跑一次“范围定了以后”的规划 */
function runPlanners(g: DeletionGraph, foreignKeys: () => boolean) {
  const cascade = [
    ...deletionPlanners('cascade').filter((p) => p.order < FOREIGN_KEY_ORDER),
    { run: foreignKeys },
    ...deletionPlanners('cascade').filter((p) => p.order >= FOREIGN_KEY_ORDER),
  ];
  let progress = true;
  while (progress) {
    progress = false;
    for (const step of cascade) progress = !!step.run(g) || progress;
  }
  // 连带范围定了以后：被删单据的库存流水按库存处理方式处理、单据里失效的流水编号、没人用的唛头文件
  for (const step of deletionPlanners('after')) step.run(g);
}

/** 选中的记录：不存在、版本变了、单据种类不对都按“记录不存在或版本已改变”拦下 */
function selectedRows(db: DatabaseSync, columns: string, table: string, selection: Selection) {
  if (new Set(selection.items.map((r) => r.id)).size !== selection.items.length)
    throw new AppError('重复选择记录。');
  return selection.items.map((item) => {
    const r = one(db, deletionRow, 'SELECT ' + columns + ' FROM ' + quote(table) + ' WHERE id=?', item.id);
    if (!r || r.version !== item.version || (table === 'flow_documents' && r.kind !== selection.module))
      throw new AppError('记录不存在或版本已改变，请刷新。', 409);
    return r;
  });
}

type Deletion = { table: string; row: Row };
/** 除了选中的记录本身，还删别的业务记录、改别的行或删库存流水 */
function independentImpact(table: string, selection: Selection, deletions: Deletion[], updated: number) {
  return (
    deletions.some(
      ({ table: t, row: r }) =>
        businessTables.has(t) && (t !== table || !selection.items.some((i) => i.id === r.id)),
    ) ||
    updated > 0 ||
    deletions.some((r) => r.table === 'stock_movements')
  );
}

/** 算一次删除的范围（不写库）：预览和真删前各算一次，两次的摘要要一样 */
export function planDeletion(store: Store, raw: unknown) {
  // 各模块的删除规则由它们加载时登记；不按模块名点名，规划完按要删、要改的表查登记（下面 requireDeletionTables）
  const selection = deletionSelection.parse(raw),
    db = store.db;
  const table = flowKinds.some((k) => k === selection.module) ? 'flow_documents' : selection.module;
  const facts = schemaFacts(db),
    state = planState(db, facts.columns, selection.inventoryPolicy);
  for (const r of selectedRows(db, facts.columns(table), table, selection)) state.g.remove(table, r);
  runPlanners(state.g, foreignKeyStep(state, facts));
  const deletions = state.deletions(),
    updates = state.updates();
  // 预览时就查：要删、要改的每张表都有主人登记了写法；要删订单，要有模块登记删前配合（识别导入给导入记录打标记）
  requireDeletionTables(new Set([...deletions, ...updates].map((r) => r.table)));
  if (deletions.some((r) => r.table === 'orders')) requireRecordDeletionHook('orders');
  const impact = impactList(state.g, deletions, updates, state.documentFields);
  const digest = previewDigest({
    selection,
    deletions,
    updates,
    stock: state.g.rows('stock_movements').map((r) => [r.id, r.delta_units, r.before_units, r.after_units]),
  });
  return {
    selection,
    table,
    deletions,
    updates,
    digest,
    impact,
    hasIndependentImpact: independentImpact(table, selection, deletions, updates.length),
    inventoryChoice: state.inventoryChoice(),
    inventory: inventoryFigures(selection, table, deletions, updates, state.g),
  };
}
