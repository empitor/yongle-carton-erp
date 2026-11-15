import type { Actor, Store } from '../core/index.js';
import { AppError, assertPreviewCurrent, audit, onceByRequest, operationRequest, previewDigest as digestOf, rehearse, requirePermission } from '../core/index.js';
import { correctionResultSchema, pendingLabels, type FlowDocument, type FlowDocView } from '../../shared/business/index.js';
import { today } from '../../shared/core/index.js';
import { fail, type FlowCommands } from './base.js';
import { insertFlowDocument, writeFlowDocument } from './document-store.js';
import {
  netStockImpact,
  sameTotals,
  sourceTotals,
  writeCorrectionMovements,
  type CorrectableKind,
  type CorrectionCommit,
  type CorrectionHead,
  type CorrectionKind,
  type KindPlan,
} from './correction-movements.js';
import { storedDocument } from './read.js';
import { rewriteRefs } from './refs.js';
import { FlowService } from './service.js';
import { arrivalCorrection } from './arrival-correction.js';
import { deliveryCorrection } from './delivery-correction-plan.js';
import { productionCorrection } from './production-correction-plan.js';

/*
 * 更正已生效的单据：到货、送货、完工改数量这类动库存或金额的，只有这一条路（界面、助手、数据管理都走它）。
 * 更正 = 同一个事务里撤销原单 + 另出一张替代单：原单标已撤销并指向替代单（界面叫“已更正”），替代单写明更正自哪张；
 * 库存流水只追加（原单按库存品合计冲回、替代单照记），按净变化查库存，不改写原来的流水。
 * 三种单据共用这里的步骤（校验、摘要、防重复、写流水、标原单、核验、审计），各自的方案和收尾在
 * arrival-correction.ts、delivery-correction-plan.ts、production-correction-plan.ts。
 * 生产任务不进更正（不动库存、不进财务）；整张没发生的用撤销（undo.ts），只改备注这类用说明编辑（document-info.ts）。
 * 入口按单据种类分到同一套泛型步骤上（previewAs、correctAs），预览和结果的类型跟着种类走。
 */

/**
 * 一种单据的更正绑在这张原单上：original 是原单视图；head 是同一张原单按单据联合类型看的（泛型 K 下读不到视图的公共字段，
 * 读单号、状态、版本这些用它）；stored 是库里存的那份原单内容（不是视图）：原单标已撤销时在它上面加字段。
 */
type Bound<K extends CorrectableKind, I extends CorrectionHead, V extends object, D, R extends object> = {
  kind: CorrectionKind<K, I, V, D, R>;
  original: FlowDocView<K>;
  head: FlowDocView;
  stored: FlowDocument<K>;
};
function bind<K extends CorrectableKind, I extends CorrectionHead, V extends object, D, R extends object>(
  flow: FlowCommands,
  kind: CorrectionKind<K, I, V, D, R>,
  original: FlowDocView<K>,
): Bound<K, I, V, D, R> {
  const head: FlowDocView = original;
  return { kind, original, head, stored: storedDocument(flow.store, head.id, kind.kind) };
}

const notCorrectable = () => fail('生产任务不能更正：改计划用“编辑”，要少做请取消剩余任务，整张没做请撤销。', 409);

/** 同一份方案：预览直接返回 view，提交先按它核对摘要再执行 */
function planOf<K extends CorrectableKind, I extends CorrectionHead, V extends object, D, R extends object>(
  flow: FlowCommands,
  { kind, original, head, stored }: Bound<K, I, V, D, R>,
  input: I,
  actor: Actor,
) {
  if (head.status !== 'confirmed' || head.replacedBy)
    fail(
      '只能更正有效的' + kind.effective + '；' + pendingLabels[head.kind] + '的请直接编辑；已撤销、已取消的不能更正，已更正的请打开最新那张' +
        kind.name + '。',
      409,
    );
  if (head.archived) fail('这张' + kind.name + '已归档，请先恢复再更正。', 409);
  if (head.version !== input.expectedVersion) fail(kind.name + '版本已改变，请刷新后重新核对。', 409);
  const totals = sourceTotals(flow, head.kind, head.id);
  // 原单名下的流水要和它的内容对得上；对不上说明流水被改动过，不在上面再更正
  if (!sameTotals(totals, kind.stocked(stored)))
    fail('原' + kind.name + '和它的库存流水数量不一致，需先核对历史记录，未执行更正。', 409);
  const plan = kind.plan(flow, original, stored, input, actor),
    stockImpact = netStockImpact(flow, totals, plan.changes);
  const previewDigest = digestOf({ original, input, stockImpact, kind: plan.digest ?? null });
  const view = {
    id: head.id,
    kind: kind.kind,
    number: head.number,
    ...plan.view,
    stockImpact,
    warnings: plan.warnings,
    previewDigest,
  };
  return { plan, totals, stockImpact, view };
}

/** 一种单据的预览：先查谁能更正，再按预览输入出方案（预演里做，做完撤回） */
function previewAs<K extends CorrectableKind, I extends CorrectionHead, V extends object, D, R extends object>(
  flow: FlowCommands,
  kind: CorrectionKind<K, I, V, D, R>,
  original: FlowDocView<K>,
  raw: unknown,
  actor: Actor,
) {
  const bound = bind(flow, kind, original);
  kind.allow(actor);
  const input = kind.schema.parse(raw);
  return rehearse(flow.store.db, () => planOf(flow, bound, input, actor).view);
}

/**
 * 更正前的预览：更正后库存、订单或采购、任务各会变成多少。返回的 previewDigest 提交时带回来。
 * 只读：方案里要建的东西（换产品时的成品库存）在预演里建、预演完撤回。
 */
export function planCorrection(store: Store, id: number, raw: unknown, who: Actor | null | undefined) {
  const actor = requirePermission(who, 'business:edit'),
    flow = new FlowService(store),
    doc = flow.get(id);
  switch (doc.kind) {
    case 'task':
      return notCorrectable();
    case 'arrival':
      return previewAs(flow, arrivalCorrection, doc, raw, actor);
    case 'delivery':
      return previewAs(flow, deliveryCorrection, doc, raw, actor);
    case 'production':
      return previewAs(flow, productionCorrection, doc, raw, actor);
  }
}

/** 替代单内容：方案的单据加上沿用原单的系统字段和更正关系 */
function replacementOf<K extends CorrectableKind, I extends CorrectionHead, V extends object, D, R extends object>(
  flow: FlowCommands,
  { kind, head, stored }: Bound<K, I, V, D, R>,
  plan: KindPlan<K, V, D>,
  c: { actor: Actor; at: string; reason: string },
): FlowDocument {
  return {
    ...plan.document,
    ...kind.inherit(flow, stored, plan, c.actor, c.at),
    correctionOf: head.id,
    correctionReason: c.reason,
    correctedAt: c.at,
  };
}

/** 一个事务里撤销原单、出替代单、写流水、收尾、读回核验、记修改历史 */
function commit<K extends CorrectableKind, I extends CorrectionHead, V extends object, D, R extends object>(
  flow: FlowCommands,
  bound: Bound<K, I, V, D, R>,
  c: CorrectionCommit<I>,
  actor: Actor,
) {
  const store = flow.store,
    { kind, original, head, stored } = bound,
    id = head.id,
    { requestId, input } = c,
    reason = input.reason,
    { plan, totals, stockImpact, view } = planOf(flow, bound, input, actor);
  // 类别 preview-changed：更正窗按它自动重新核对
  assertPreviewCurrent(c.previewDigest, view.previewDigest);
  const at = new Date().toISOString();
  kind.prepare?.(flow, plan, actor, head.number);
  const next = replacementOf(flow, bound, plan, { actor, at, reason });
  // 替代单的单号按更正当天，单据日期按方案（一般沿用原单）；这时原单还在，correction_of 的外键成立
  const replacementId = insertFlowDocument(store, { date: plan.date, numberDate: today(), status: 'confirmed', document: next, actor, at });
  rewriteRefs(store, replacementId, next);
  const replacementNumber = flow.get(replacementId).number;
  const movements = writeCorrectionMovements(flow, {
    original: { id, kind: kind.kind, number: head.number },
    replacement: { id: replacementId, number: replacementNumber, date: plan.date },
    totals,
    changes: plan.changes,
    reason,
    actor,
  });
  // 刚建的替代单补上流水编号（不换版本号）；原单标成已撤销并指向替代单
  writeFlowDocument(store, replacementId, { ...next, movements: movements.replacement }, { bumpVersion: false });
  writeFlowDocument(
    store,
    id,
    { ...stored, replacedBy: replacementId, reversal: { reason, by: actor.name, at, requestId, movements: movements.reversal } },
    { status: 'reversed', at },
  );
  const done = kind.finish({ flow, actor, at, requestId, reason, original, replacementId, replacementNumber, plan: { ...plan, stockImpact }, movements });
  // 读回核验：库存结余要和预览说的一样，不一样整笔撤回
  const stockIds = stockImpact.flatMap((s) => (s.stockId ? [s.stockId] : [])),
    stock = flow.ops.repo.items(true, stockIds);
  if (stockImpact.some((s) => s.stockId && stock.find((it) => it.id === s.stockId)?.quantity !== s.after))
    throw new AppError('更正后库存核验不一致，事务已回滚。', 409);
  const result = {
    kind: kind.kind,
    originalId: id,
    originalNumber: head.number,
    replacementId,
    replacementNumber,
    requestId,
    stockImpact,
    movements,
    verified: true,
    summary: kind.name + ' ' + head.number + ' 已更正为 ' + replacementNumber + '：' + done.summary,
    ...done.result,
  };
  // 修改历史：原单、替代单各记一条（替代单的修改历史从这条开始）
  const before = done.audit?.before ?? original,
    after = done.audit?.after ?? flow.get(replacementId);
  audit(store, actor, {
    action: 'correct',
    entity: 'flow_' + kind.kind,
    id,
    document: { requestId, reason, before, after, replacementId, result },
  });
  audit(store, actor, {
    action: 'correct',
    entity: 'flow_' + kind.kind,
    id: replacementId,
    document: { requestId, reason, correctionOf: id, before, after },
  });
  return result;
}

/**
 * 一种单据的提交：同一个请求号重发返回上次的结果（按 shared/business 的 correctionResultSchema 读回，和第一次交回的一样）；
 * 事务里按当前的原单重新出方案
 */
function correctAs<K extends CorrectableKind, I extends CorrectionHead, V extends object, D, R extends object>(
  flow: FlowCommands,
  kind: CorrectionKind<K, I, V, D, R>,
  id: number,
  raw: unknown,
  actor: Actor,
) {
  kind.allow(actor);
  const c = kind.commit(raw);
  return onceByRequest(
    flow.store,
    operationRequest('flow-correction', c.requestId, actor, { id, ...c.full }),
    () => commit(flow, bind(flow, kind, flow.get(id, kind.kind)), c, actor),
    correctionResultSchema(kind.kind, kind.result),
  );
}

/** 提交更正：同一个请求号重发返回上次的结果 */
export function correctDocument(store: Store, id: number, raw: unknown, who: Actor | null | undefined) {
  const actor = requirePermission(who, 'business:edit'),
    flow = new FlowService(store);
  switch (flow.get(id).kind) {
    case 'task':
      return notCorrectable();
    case 'arrival':
      return correctAs(flow, arrivalCorrection, id, raw, actor);
    case 'delivery':
      return correctAs(flow, deliveryCorrection, id, raw, actor);
    case 'production':
      return correctAs(flow, productionCorrection, id, raw, actor);
  }
}
