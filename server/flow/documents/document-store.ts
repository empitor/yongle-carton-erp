import { z } from 'zod';
import type { Actor, Store } from '../../core/index.js';
import { AppError, nextAutoId, one, rows } from '../../core/index.js';
import { flowDocNames, flowDocumentContent, flowDocumentOfView, type FlowDocument, type FlowDocView, type FlowKind } from '../../../shared/business/index.js';

/*
 * 单据表（flow_documents）的写入都在这个文件。别处只剩 deletion.ts 里登记给删除引擎和初始化的语句，
 * tests/module-table-owners.test.ts 会拦别的文件直接写这张表。
 *
 * 表里有 5 列是 document 里字段的镜像：计划日、送达日、订货批次、更正关系（更正的原单、替代它的单据）。
 * 查询和外键只看列，document 里的同名字段照旧保留（视图、财务快照、关联摘要都直接读这份 JSON）。
 * 列的值一律由 flowColumns 从要写的那份 document 里算，调用方不传列；库里另有 CHECK 核对两边一致
 * （server/core/schema/tables/flow.ts），漏写一边当场报错，不会悄悄两边不一样。
 * 给 document 加新的镜像外键列时：这里的 flowColumns、建表的 CHECK、deletion.ts 的镜像登记三处一起加。
 *
 * 写之前按库里的单据结构（shared/business/flow-document.ts）核对一遍：多出、缺了必填的、类型不对的字段当场报错，
 * 读的时候（read.ts 的 storedContent）按同一份结构再核对。
 */

/**
 * 写之前的核对（库里的单据结构）：用户输入先过录入规则，带不进多余的键，核对不过是服务端自己拼错了内容。
 * 按服务端错误报（出错处理回 500、写进日志），不当成“输入不对”回 400。which 说明是哪张单据。
 */
function checkedForWrite<T>(which: string, check: () => T): T {
  try {
    return check();
  } catch (e) {
    if (e instanceof z.ZodError) throw new Error('单据内容不合库里的单据结构，没有写入（' + which + '）：' + z.prettifyError(e), { cause: e });
    throw e;
  }
}

/** 按视图改好的单据取回要写的单据内容（去掉视图的列和派生字段、按结构核对）；核对不过同样按服务端错误报 */
export const viewContent = (view: FlowDocView) =>
  checkedForWrite('单据 ' + view.id + '，单号 ' + view.number, () => flowDocumentOfView(view));

/** 镜像列要看的几项：单据的种类和内容里的同名字段 */
type Mirrored = {
  kind: FlowKind;
  plannedDate?: string | null;
  deliveredAt?: string;
  orderBatchId?: number;
  correctionOf?: number | null;
  replacedBy?: number;
};
/** 镜像列的值，从这份单据内容里取。取法和建表语句里的 CHECK 是同一个定义，改一边要改另一边 */
export function flowColumns(doc: Mirrored) {
  return {
    // 生产任务、送货单就是 plannedDate；到货单、完工单没有（到货的安排在订货单上）
    planned_date: doc.kind === 'task' || doc.kind === 'delivery' ? (doc.plannedDate ?? null) : null,
    delivered_at: doc.kind === 'delivery' ? (doc.deliveredAt ?? null) : null,
    order_batch_id: doc.kind === 'arrival' ? (doc.orderBatchId ?? null) : null,
    correction_of: doc.correctionOf ?? null,
    replaced_by: doc.replacedBy ?? null,
  };
}

const prefixes: Record<FlowKind, string> = { arrival: 'DH', task: 'SC', production: 'DJ', delivery: 'SH' };
/** 单号末尾的序号（就是编号）至少几位，不够前面补 0 */
const SERIAL_DIGITS = 5;

/**
 * 新建一张单据，返回编号。单号里的序号就是编号：编号用过就不再用（删掉的也算），删掉最后一张单据后新单据不会接上它的单号。
 * numberDate 是单号里的日期，不给就用单据日期（更正的替代单沿用原单日期，单号按更正当天）。
 */
export function insertFlowDocument(
  store: Store,
  input: {
    date: string;
    numberDate?: string;
    status: 'draft' | 'confirmed';
    document: FlowDocument;
    actor: Pick<Actor, 'id' | 'name'>;
    at: string;
  },
) {
  const kind = input.document.kind,
    json = JSON.stringify(checkedForWrite('新建' + flowDocNames[kind] + '，单据日期 ' + input.date, () => flowDocumentContent(input.document))),
    id = nextAutoId(store.db, 'flow_documents'),
    c = flowColumns(input.document);
  store.db
    .prepare(
      'INSERT INTO flow_documents(id,kind,number,date,status,planned_date,delivered_at,order_batch_id,correction_of,replaced_by,actor_id,actor_name,created_at,updated_at,document) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      id,
      kind,
      prefixes[kind] + '-' + (input.numberDate ?? input.date).replaceAll('-', '') + '-' + String(id).padStart(SERIAL_DIGITS, '0'),
      input.date,
      input.status,
      c.planned_date,
      c.delivered_at,
      c.order_batch_id,
      c.correction_of,
      c.replaced_by,
      input.actor.id,
      input.actor.name,
      input.at,
      input.at,
      json,
    );
  return id;
}

/**
 * 整份写单据内容，镜像列跟着这份内容一起写。date、status、at（更新时间）给了才改；
 * 版本号默认加一（别处打开的单据会提示已变化），刚建的单据补内容时传 bumpVersion: false。
 * 内容的种类要和这张单据一样（是程序写错了才会不一样，当场报错）。
 */
export function writeFlowDocument(
  store: Store,
  id: number,
  document: FlowDocument,
  options: { date?: string; status?: string; at?: string; bumpVersion?: boolean } = {},
) {
  const row = one(store.db, rows.flow_documents.pick({ kind: true, number: true }), 'SELECT kind,number FROM flow_documents WHERE id=?', id);
  if (!row) throw new AppError('业务单据不存在。', 404);
  const which = '单据 ' + id + '，单号 ' + row.number;
  if (row.kind !== document.kind) throw new Error('单据内容和单据种类对不上，没有写入（' + which + '，库里是 ' + row.kind + '，要写的是 ' + document.kind + '）');
  const json = JSON.stringify(checkedForWrite(which, () => flowDocumentContent(document))),
    c = flowColumns(document);
  store.db
    .prepare(
      'UPDATE flow_documents SET document=?,planned_date=?,delivered_at=?,order_batch_id=?,correction_of=?,replaced_by=?,date=coalesce(?,date),status=coalesce(?,status),updated_at=coalesce(?,updated_at),version=version+? WHERE id=?',
    )
    .run(
      json,
      c.planned_date,
      c.delivered_at,
      c.order_batch_id,
      c.correction_of,
      c.replaced_by,
      options.date ?? null,
      options.status ?? null,
      options.at ?? null,
      options.bumpVersion === false ? 0 : 1,
      id,
    );
}

/** 内容没变，只换版本号（给了 at 就同时改更新时间）：完工确认、冲销后提示打开着的生产任务刷新，归档和恢复 */
export function touchFlowDocument(store: Store, id: number, at?: string) {
  store.db
    .prepare('UPDATE flow_documents SET version=version+1,updated_at=coalesce(?,updated_at) WHERE id=?')
    .run(at ?? null, id);
}

