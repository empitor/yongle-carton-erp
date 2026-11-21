import type { z } from 'zod';
import { AppError, audit } from '../core/index.js';
import { arrivalCorrectionExtraSchema, arrivalCorrectionPreviewSchema, correctionCommit, flowDocNames, type PurchaseView } from '../../shared/business/index.js';
import { stockLedger } from '../operations/index.js';
import { StockViews } from './stock-views.js';
import { arrivalCorrectionPlan, arrivalStocked, type ArrivalPlan, type CorrectionInput } from './arrival-correction-plan.js';
import { commitInput, type CorrectionContext, type CorrectionKind } from './correction-movements.js';
import { newItemOf } from './base.js';
import { arrivalPurchaseIds, receiptEvents, syncReceivedUnits } from './receipt-events.js';
import { saveReceiptKey } from './refs.js';

const { setPurchaseLineStock, touchOrderBatch, touchPurchases } = stockLedger;

/*
 * 更正到货单（更正的核心在 correction.ts，方案在 arrival-correction-plan.ts）：这里是到货自己的部分。
 * 业务账号能改每行的数量和验收数；日期、送货单号、供应商、单价、库存品、采购明细、增删行要本机管理员。
 * 收尾：送货单号和原件的“已入过库”改记到替代单上，采购单的已到货按有效到货单重算，换采购单、订货单的版本号，
 * 读回核验采购单的已到货；采购单的修改历史里也记一条。
 * 财务看到的是“原单被更正替代”和一张新的到货单，应付跟着替代单变（红字冲销并重做在财务那边办）。
 */

type Context = CorrectionContext<'arrival', ArrivalPlan['view'], ArrivalPlan['data']>;
type Correction = ArrivalPlan['data']['corrections'][number];

/** 送货单号和原件的“已入过库”改记在替代单上（改了送货单号、供应商的，原来那个号放出来） */
function moveReceiptKeys(ctx: Context) {
  const { flow, plan, original, replacementId } = ctx,
    store = flow.store;
  store.db.prepare('DELETE FROM flow_receipt_keys WHERE document_id=?').run(original.id);
  saveReceiptKey(store, plan.document.supplierId, plan.document.reference, replacementId);
  store.db.prepare('UPDATE flow_file_uses SET document_id=? WHERE document_id=?').run(replacementId, original.id);
}

/** 采购单的已到货按有效到货单重算，采购单、订货单换版本号（开着的登记窗口拿旧版本登记会被拦） */
function syncPurchases(ctx: Context) {
  const { flow, plan, original, replacementId, at } = ctx,
    store = flow.store,
    { receipt, purchaseImpact } = plan.data;
  const purchaseIds = [...new Set([...purchaseImpact.map((p) => p.id), ...arrivalPurchaseIds(store, [original.id, replacementId])])];
  syncReceivedUnits(store, false, purchaseIds);
  touchPurchases(store, purchaseIds, at);
  // 订货单还差多少跟着变：和撤销一样换版本号
  const batches = [receipt.document.orderBatchId, plan.document.orderBatchId].flatMap((b) => (b == null ? [] : [b]));
  for (const batchId of new Set(batches)) touchOrderBatch(store, batchId, at);
}

/** 读回核验：采购单的已到货要和预览说的一样，不一样整笔撤回；返回读回的采购单 */
function verifiedPurchases(ctx: Context) {
  const { purchaseImpact } = ctx.plan.data,
    purchases = new StockViews(ctx.flow.store).purchases(true, purchaseImpact.map((p) => p.id));
  for (const p of purchaseImpact) {
    const saved = purchases.find((row) => row.id === p.id);
    if (!saved || saved.arrivalProgress !== p.arrivalProgress || p.lines.some((l) => saved.lines.find((sl) => sl.id === l.lineId)?.receivedQuantity !== l.after))
      throw new AppError('更正后采购到货核验不一致，事务已回滚。', 409);
  }
  return purchases;
}

/** 一行更正的说法：原登记多少、更正为多少；挂了采购单的另说有效累计到货、待到货和采购进度 */
function correctionText(l: Correction, purchases: PurchaseView[]) {
  const p = purchases.find((x) => x.id === l.purchaseId),
    line = p?.lines.find((pl) => pl.id === l.lineId);
  return (
    l.name + '原登记' + l.originalQuantity + l.unit + '，更正为' + l.correctedQuantity + l.unit +
    (p && line ? '；有效累计到货' + line.receivedQuantity + l.unit + '，待到货' + line.remainingQuantity + l.unit + '，采购进度：' + p.arrivalProgress : '')
  );
}

function finish(ctx: Context) {
  const { flow, plan, original, replacementId, actor } = ctx,
    store = flow.store,
    { receipt, purchaseImpact, corrections } = plan.data;
  for (const c of plan.changes) if (c.purchaseLineId) setPurchaseLineStock(store, c.purchaseLineId, c.stockId);
  moveReceiptKeys(ctx);
  syncPurchases(ctx);
  const purchases = verifiedPurchases(ctx);
  const stockImpact = plan.stockImpact,
    stockIds = [...plan.changes, ...stockImpact].flatMap((s) => (s.stockId ? [s.stockId] : [])),
    stock = new StockViews(flow.store).items(true, stockIds);
  const summary =
    (corrections.length ? corrections.map((l) => correctionText(l, purchases)).join('；') : '到货数量没有变，已按更正后的内容另出一张到货单') +
    '。' +
    stockImpact
      .filter((s) => s.stockId)
      .map((s) => s.name + '库存净变化' + s.delta + s.unit + '，现有' + s.after + s.unit)
      .join('；');
  // 修改历史：挂了采购单的，每张采购单的历史里也记一条（采购单详情看得到这次更正）
  const [after] = receiptEvents(store, undefined, { arrivalIds: [replacementId] });
  for (const p of purchaseImpact)
    audit(store, actor, {
      action: 'correct',
      entity: 'purchases',
      id: p.id,
      document: {
        requestId: ctx.requestId,
        reason: ctx.reason,
        before: receipt,
        after,
        arrivalId: original.id,
        replacementFlowId: replacementId,
      },
    });
  return {
    summary,
    result: {
      originalReceiptId: receipt.id,
      replacementReceiptId: 'flow-' + replacementId,
      replacementFlowId: replacementId,
      beforeAmount: plan.view.beforeAmount,
      afterAmount: plan.view.afterAmount,
      purchases,
      stock,
      corrections,
    },
    audit: { before: receipt, after },
  };
}

/** 提交结果里到货多带的（结构在 shared/business/flow-correction-views.ts，同一请求号重发时按它读回）：采购单、库存品是读回的完整视图 */
type ArrivalResult = z.output<typeof arrivalCorrectionExtraSchema>;

export const arrivalCorrection: CorrectionKind<'arrival', CorrectionInput, ArrivalPlan['view'], ArrivalPlan['data'], ArrivalResult> = {
  kind: 'arrival',
  name: flowDocNames.arrival,
  effective: '已入库到货',
  schema: arrivalCorrectionPreviewSchema,
  commit: commitInput(correctionCommit(arrivalCorrectionPreviewSchema)),
  result: arrivalCorrectionExtraSchema,
  allow: () => {},
  stocked: arrivalStocked,
  plan: arrivalCorrectionPlan,
  // 新加的行没选库存品：同一种纸板已有库存品就入它，没有才新建（和核对入库同一个做法）
  prepare(flow, plan, actor, number) {
    const created = new Map<string, number>();
    plan.changes.forEach((c, i) => {
      if (c.stockId) return;
      c.stockId = flow.createdItem(created, newItemOf(c), actor, '到货单 ' + number + ' 的更正');
      plan.document.lines[i].stockId = c.stockId;
    });
  },
  // 确认人、确认时间沿用原单（和送货、完工同一个规矩）；谁、什么时候更正的看 correctedAt 和修改历史
  inherit: (flow, stored, plan) => ({
    supplierName: flow.ops.supplierName(plan.document.supplierId, true),
    correctionOfReceiptId: plan.data.receipt.id,
    confirmedBy: stored.confirmedBy,
    confirmedAt: stored.confirmedAt,
  }),
  finish,
};
