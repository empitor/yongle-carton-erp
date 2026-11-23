// 快照字段的测试底子（flow-snapshot*.test.ts、snapshot-resave-*.test.ts），内存库、虚构数据：
// 从单据结构派生每种单据的快照字段（严格结构减录入结构，再减生命周期字段），不手抄；
// 把库里一张单据的快照字段全填成虚构的标记值，重新保存以后逐项核对。单据结构多了快照字段，这里自动跟上。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { Actor, Store } from '../server/core/index.js';
import { correctDocument, planCorrection } from '../server/flow/index.js';
import { storedDocument } from '../server/flow/documents/read.js';
import {
  lifecycleFields,
  type FlowDocument,
  arrivalSchema,
  deliverySchema,
  productionSchema,
  taskSchema,
} from '../shared/business/index.js';
import { flowContentSchema } from '../shared/business/flow/flow-document.js';
import { arrivalLineSchema } from '../shared/business/flow/physical-flow.js';
import { isRecord, type FlowKind } from '../shared/core/index.js';
import { businessChanges } from './business-changes-fixture.js';

type Shape = Record<string, z.ZodType>;
const lifecycle: readonly string[] = [...lifecycleFields.records, ...lifecycleFields.correction];
/** 严格结构有、录入结构没有、又不是生命周期字段的键（种类在行上，不算） */
const snapshotKeys = (strict: Shape, input: Shape) =>
  Object.keys(strict).filter((k) => k !== 'kind' && !Object.hasOwn(input, k) && !lifecycle.includes(k));

const content = { arrival: flowContentSchema('arrival').shape, task: flowContentSchema('task').shape, production: flowContentSchema('production').shape, delivery: flowContentSchema('delivery').shape };
/** 一层快照字段：名字和它在严格结构里的结构（挑标记值用） */
type Layer = { keys: string[]; shape: Shape };
const layer = (strict: Shape, input: Shape): Layer => ({ keys: snapshotKeys(strict, input), shape: strict });

/** 每种单据每一层的快照字段：表头（doc）、明细（lines），完工领料（materials）、到货明细的纸板资料（item） */
export const snapshotFields: Record<FlowKind, Partial<Record<'doc' | 'lines' | 'materials' | 'item', Layer>>> = {
  arrival: {
    doc: layer(content.arrival, arrivalSchema.shape),
    lines: layer(content.arrival.lines.element.shape, arrivalLineSchema.shape),
    item: layer(content.arrival.lines.element.shape.item.shape, arrivalLineSchema.shape.item.shape),
  },
  task: { doc: layer(content.task, taskSchema.shape) },
  production: {
    doc: layer(content.production, productionSchema.shape),
    materials: layer(content.production.materials.element.shape, productionSchema.shape.materials.element.shape),
  },
  delivery: {
    doc: layer(content.delivery, deliverySchema.shape),
    lines: layer(content.delivery.lines.element.shape, deliverySchema.shape.lines.element.shape),
  },
};

/** 一项的标记值：按这一项的结构挑合法的，每项各不相同。文字用数字样子的（金额、面积、单价也要算得动） */
function marker(l: Layer, key: string) {
  const n = l.keys.indexOf(key) + 1,
    schema = l.shape[key];
  const fitting = [String(9800 + n) + '.5', 4300 + n].find((v) => schema.safeParse(v).success);
  if (fitting === undefined) throw new Error('测试底子：' + key + ' 挑不出标记值，给它加一种');
  return fitting;
}
const marked = (l: Layer | undefined, value: Record<string, unknown>) =>
  l ? { ...value, ...Object.fromEntries(l.keys.map((k) => [k, marker(l, k)])) } : value;

/** 这张单据的内容（不带种类），表头和每一行的快照字段都填成标记值 */
export function markedContent(document: FlowDocument) {
  const { kind, ...doc } = document,
    fields = snapshotFields[kind],
    lines = 'lines' in doc ? doc.lines.map((l) => marked(fields.lines, { ...l })) : undefined;
  return { ...marked(fields.doc, { ...doc }), ...(lines ? { lines } : {}) };
}

/** 把库里这张单据表头和每一行的快照字段都填成标记值（经 document-store 写回） */
export function markSnapshots(store: Store, id: number) {
  businessChanges(store).rewrite(id, markedContent(storedDocument(store, id)));
}

/** 换了引用的字段：这几项按新引用取，不能还是标记值；明细的按行号给（没写的行一项都不换） */
type Changed = { doc?: string[]; lines?: Record<number, string[]> };
const rowsOf = (doc: Record<string, unknown>) => (Array.isArray(doc.lines) ? doc.lines.filter(isRecord) : []);

function checkLayer(l: Layer | undefined, value: Record<string, unknown>, changed: readonly string[], where: string) {
  if (!l) return;
  for (const key of l.keys) {
    const mark = marker(l, key);
    if (changed.includes(key)) assert.notEqual(value[key], mark, where + key + '：引用换了，应按新引用取');
    else assert.equal(value[key], mark, where + key + '：引用没变，应原样保留原单的');
  }
}

/**
 * 重新保存以后的单据：每个快照字段都还是标记值，只有 changed 里的按新引用取了。
 * 换了的字段名要是快照字段（写错了直接失败）。
 */
export function assertSnapshots(doc: FlowDocument, changed: Changed = {}) {
  const fields = snapshotFields[doc.kind],
    value: Record<string, unknown> = { ...doc };
  for (const key of [...(changed.doc ?? []), ...Object.values(changed.lines ?? {}).flat()])
    assert.ok([...(fields.doc?.keys ?? []), ...(fields.lines?.keys ?? [])].includes(key), key + ' 不是' + doc.kind + '的快照字段');
  checkLayer(fields.doc, value, changed.doc ?? [], '表头 ');
  rowsOf(value).forEach((line, i) => checkLayer(fields.lines, line, changed.lines?.[i] ?? [], '第 ' + (i + 1) + ' 行 '));
}

/** 更正一张单据：先预览、再按预览摘要提交，返回替代单编号 */
export function correct(store: Store, id: number, input: Record<string, unknown>, who: Actor) {
  const plan = planCorrection(store, id, input, who);
  return correctDocument(store, id, { ...input, previewDigest: plan.previewDigest, requestId: randomUUID() }, who).replacementId;
}
