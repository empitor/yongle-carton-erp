import { z } from 'zod';
import { type Store } from '../../core/index.js';
import { exists, many, one, parseStoredJson, rows } from '../../core/index.js';
import { quantityText, quantityUnits, flowKinds, type FlowKind } from '../../../shared/core/index.js';
import { flowDocNames, flowDocumentSchema, flowEntity, flowEntityPrefix, taskProgress, type FlowDocument, type FlowDocView, type FlowRow } from '../../../shared/business/index.js';
import { fail } from './base.js';

/*
 * 读单据：把 flow_documents 的一行组装成单据视图（生产任务带上完工进度），
 * 列表按主键或条件批量读，单张按主键读。只读，不写库。单据流转读库里的单据内容都走这里的 storedContent。
 */

type DocumentRow = z.output<typeof rows.flow_documents>;
type Production = { date: string; good: number };

/** 读内容要的列：编号、单号（对不上时说清是哪张）和内容；不知道种类的另带 kind */
type ContentRow = Pick<DocumentRow, 'id' | 'number' | 'document'>;
const storedRow = rows.flow_documents.pick({ id: true, number: true, kind: true, status: true, document: true });
/**
 * 完工单里算完工进度要的两项（挂的生产任务、合格数），在 SQL 里取出来，不解析整张单据：
 * 任务列表、今日页每次都要把全部完工单过一遍，只做合计。
 */
const goodRow = rows.flow_documents.pick({ date: true }).extend({ taskId: z.number().int().positive().nullable(), goodQuantity: quantityText });
const goodColumns = "date,json_extract(document,'$.taskId') AS taskId,json_extract(document,'$.goodQuantity') AS goodQuantity";
/** 只看挂在这几张生产任务上的完工单（flow_refs.task_id 索引） */
const onTasks = ' AND id IN (SELECT document_id FROM flow_refs WHERE task_id IN (SELECT value FROM json_each(?)))';

/**
 * 单据流转读库里单据内容只走这里：按种类核对（shared/business 的 flowDocumentSchema）。写入时核对过，正常不会对不上；
 * 对不上是库里的数据坏了，parseStoredJson 报服务端错误（500、记日志），说明里写明是哪张单据。
 */
export function storedContent<K extends FlowKind>(kind: K, row: ContentRow): FlowDocument<K> {
  const where = 'flow_documents.document（单据 ' + row.id + '，单号 ' + row.number + '，' + flowDocNames[kind] + '）';
  return parseStoredJson(flowDocumentSchema(kind), row.document, where);
}
const kindSchema = z.enum(flowKinds);
/** 这一行的单据内容（带种类）：种类按行上的 kind 列 */
export const documentOf = (r: ContentRow & Pick<DocumentRow, 'kind'>): FlowDocument => storedContent(kindSchema.parse(r.kind), r);

/**
 * 按编号读几张单据库里那份内容（不是视图），带上行上的状态；查不到的不在结果里，按编号排。
 * 单据流转按编号读单据内容都走这一句（单张的 storedDocument、删除后重算订单、完工核对、到货关联的采购单）。
 */
export function storedDocuments(store: Store, ids: readonly number[]) {
  return many(
    store.db,
    storedRow,
    'SELECT id,number,kind,status,document FROM flow_documents WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id',
    JSON.stringify(ids),
  ).map((r) => ({ id: r.id, status: r.status, document: documentOf(r) }));
}

/**
 * 库里存的那份单据内容（不是视图）：在它上面改了再整份写回（document-store.ts）。
 * 给了 kind 就只认这一种（种类不对按不存在报）。
 */
export function storedDocument<K extends FlowKind>(store: Store, id: number, kind: K): FlowDocument<K>;
export function storedDocument(store: Store, id: number): FlowDocument;
export function storedDocument(store: Store, id: number, kind?: FlowKind): FlowDocument {
  const found = storedDocuments(store, [id])[0];
  if (!found || (kind !== undefined && found.document.kind !== kind)) return fail('业务单据不存在。', 404);
  return found.document;
}

/** 生产任务视图的派生字段：开工、完工日期和完工进度 */
function taskView(doc: FlowDocument<'task'>, row: FlowRow, production: Production[], started: boolean, waiting: number): FlowDocView<'task'> {
  const completed = production.reduce((n, p) => n + p.good, 0),
    dates = production.map((p) => p.date).sort();
  return {
    ...doc,
    ...row,
    actualDate: null,
    hasProduction: started,
    actualStartDate: dates[0] || null,
    actualCompletionDate: completed >= quantityUnits(doc.quantity) ? dates.at(-1) || null : null,
    ...taskProgress(doc.quantity, completed, waiting),
  };
}

/**
 * started：生产任务已经有完工登记（含待入库的），这时不能再改任务。
 * waiting：已登记、还在等核对入库的完工单（没归档的）良品合计，千分整数；登记完工窗口的“还差”和默认合格数扣掉它。
 */
function view(r: DocumentRow, production: Production[], archived: boolean, started = false, waiting = 0): FlowDocView {
  const doc = documentOf(r);
  const row: FlowRow = {
    id: r.id,
    number: r.number,
    date: r.date,
    status: r.status,
    version: r.version,
    actorName: r.actor_name,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    archived,
  };
  switch (doc.kind) {
    case 'task':
      return taskView(doc, row, production, started, waiting);
    case 'delivery':
      return { ...doc, ...row, actualDate: row.status === 'confirmed' ? row.date : null };
    case 'arrival':
    case 'production':
      return { ...doc, ...row };
  }
}
/**
 * 已确认完工按任务汇总（完工日期、合格数，千分整数）。
 * 传 taskIds 时只读挂在这些任务上的完工（按 flow_refs.task_id 找），结果与全量汇总里这些任务的部分相同。
 */
function confirmedProduction(store: Store, taskIds?: readonly number[]) {
  const groups = new Map<number, Production[]>();
  if (taskIds && !taskIds.length) return groups;
  for (const row of many(
    store.db,
    goodRow,
    'SELECT ' + goodColumns + " FROM flow_documents WHERE kind='production' AND status='confirmed'" + (taskIds ? onTasks : ''),
    ...(taskIds ? [JSON.stringify(taskIds)] : []),
  )) {
    if (row.taskId == null) continue;
    const group = groups.get(row.taskId) || [];
    group.push({ date: row.date, good: quantityUnits(row.goodQuantity) });
    groups.set(row.taskId, group);
  }
  return groups;
}
/**
 * 生产任务已登记、还在等核对入库的完工单（待入库、没归档的）良品合计，按任务编号，千分整数。
 * 传 taskIds 时只读挂在这些任务上的（flow_refs.task_id 索引），不传读全部待入库完工单。
 * 登记完工的剩余量（batch-completion）、任务视图的 pendingCompleted、单张完工的超计划提示都用它，同一口径。
 * excludeId：不算这一张（单张完工保存、核对入库时，这张自己还是待入库，不能重复算）。
 */
export function waitingGood(store: Store, taskIds?: readonly number[], excludeId?: number) {
  const sums = new Map<number, number>();
  if (taskIds && !taskIds.length) return sums;
  for (const row of many(
    store.db,
    goodRow,
    'SELECT ' + goodColumns + " FROM flow_documents WHERE kind='production' AND status='draft'" +
      (taskIds ? onTasks : '') +
      (excludeId === undefined ? '' : ' AND id<>?') +
      ' AND id NOT IN (SELECT value FROM json_each(?))',
    ...(taskIds ? [JSON.stringify(taskIds)] : []),
    ...(excludeId === undefined ? [] : [excludeId]),
    JSON.stringify([...store.archivedIds(flowEntity('production'))]),
  )) {
    if (row.taskId == null) continue;
    sums.set(row.taskId, (sums.get(row.taskId) || 0) + quantityUnits(row.goodQuantity));
  }
  return sums;
}
/** 这一天所在月的 1 号（YYYY-MM-DD） */
const monthStart = (date: string) => date.replace(/\d\d$/, '01');
/** 列表里只留这一种单据（kind 不给就是全部），视图跟着收窄 */
const ofKind =
  <K extends FlowKind>(kind: K | undefined) =>
  (v: FlowDocView): v is FlowDocView<K> =>
    kind === undefined || v.kind === kind;
/** 生产任务的完工情况：已入库的完工、待入库的合格数、有完工登记（待入库或已入库）的任务；ids 给了只读这几张任务的 */
function taskFacts(store: Store, taskIds: number[] | undefined) {
  return {
    production: confirmedProduction(store, taskIds),
    waiting: waitingGood(store, taskIds),
    started: new Set(
      many(
        store.db,
        z.object({ task_id: z.number() }),
        "SELECT DISTINCT r.task_id FROM flow_refs r JOIN flow_documents d ON d.id=r.document_id WHERE r.task_id IS NOT NULL AND d.kind='production' AND d.status IN ('draft','confirmed')",
      ).map((r) => r.task_id),
    ),
  };
}
/** ids：只按主键读这几张单据，排序和视图与全量列表一致（列表批量组装，不全量加载后再筛）。 */
export function list<K extends FlowKind = FlowKind>(
  store: Store,
  kind?: K,
  includeArchived = false,
  workbenchDate?: string,
  ids?: readonly number[],
): FlowDocView<K>[] {
  if (ids && !ids.length) return [];
  const where: string[] = [],
    params: string[] = [];
  if (kind === 'delivery' && workbenchDate) {
    // 今日页的送货：待送货的、本月已出库的、计划在这天的。拆成三段各走各的索引（状态、状态加日期、计划日），
    // 合并出编号再按主键取。写成一句 OR，或者外层再写一遍 kind=?，新库没有统计信息时都会变成扫全部送货单。
    where.push(
      "id IN (SELECT id FROM flow_documents WHERE kind='delivery' AND status='draft'" +
        " UNION SELECT id FROM flow_documents WHERE kind='delivery' AND status='confirmed' AND date>=?" +
        " UNION SELECT id FROM flow_documents WHERE kind='delivery' AND planned_date=?)",
    );
    params.push(monthStart(workbenchDate), workbenchDate);
  } else if (kind) {
    where.push('kind=?');
    params.push(kind);
  }
  if (ids) {
    where.push('id IN (SELECT value FROM json_each(?))');
    params.push(JSON.stringify(ids));
  }
  const found = many(
    store.db,
    rows.flow_documents,
    'SELECT * FROM flow_documents' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY date DESC,id DESC',
    ...params,
  );
  // 归档标记按种类、只读读到的这些单据的
  const archived = new Map<string, Set<number>>(
    flowKinds.map((k) => [k, store.archivedAmong(flowEntity(k), found.filter((r) => r.kind === k).map((r) => r.id))]),
  );
  const tasks = !kind || kind === 'task'
    ? taskFacts(store, ids && found.filter((r) => r.kind === 'task').map((r) => r.id))
    : { production: new Map<number, Production[]>(), waiting: new Map<number, number>(), started: new Set<number>() };
  return found
    .map((r) => ({ r, isArchived: !!archived.get(r.kind)?.has(r.id) }))
    .filter(({ isArchived }) => includeArchived || !isArchived)
    .map(({ r, isArchived }) =>
      view(r, tasks.production.get(r.id) || [], isArchived, tasks.started.has(r.id), tasks.waiting.get(r.id) || 0),
    )
    .filter(ofKind(kind));
}
/** 还没核对的单据编号（kind 不给就是全部种类） */
export function draftIds(store: Store, kind?: FlowKind) {
  return many(store.db, rows.flow_documents.pick({ id: true }), "SELECT id FROM flow_documents WHERE status='draft' AND (? IS NULL OR kind=?)", kind ?? null, kind ?? null).map(
    (row) => row.id,
  );
}
/** 视图按种类收窄：种类对不上按这张单据不存在报（kind 不给就不收窄） */
export function viewOfKind<K extends FlowKind>(v: FlowDocView, kind: K | undefined): FlowDocView<K> {
  if (!ofKind(kind)(v)) return fail('业务单据不存在。', 404);
  return v;
}
/** 读一张单据；给了 kind 就只认这一种 */
export function get<K extends FlowKind = FlowKind>(store: Store, id: number, kind?: K): FlowDocView<K> {
  const row = one(store.db, rows.flow_documents, 'SELECT * FROM flow_documents WHERE id=?', id);
  if (!row) return fail('业务单据不存在。', 404);
  const task = row.kind === 'task';
  return viewOfKind(view(
    row,
    task ? confirmedProduction(store, [id]).get(id) || [] : [],
    store.archived(flowEntityPrefix + row.kind, id),
    task && !taskUntouched(store, id),
    task ? waitingGood(store, [id]).get(id) || 0 : 0,
  ), kind);
}
/** 生产任务还没开工：没有任何完工登记（待入库的也算开工了）。 */
export function taskUntouched(store: Store, taskId: number) {
  return !exists(
    store.db,
    "SELECT 1 FROM flow_refs r JOIN flow_documents d ON d.id=r.document_id WHERE r.task_id=? AND d.kind='production' AND d.status IN ('draft','confirmed') LIMIT 1",
    taskId,
  );
}
