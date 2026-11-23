import { sales } from '../../sales/index.js';
import type { z } from 'zod';
import type { Actor } from '../../core/index.js';
import { AppError, isLocalAdministrator } from '../../core/index.js';
import {
  correctionCommit,
  deliveryCorrectionExtraSchema,
  deliveryCorrectionPreviewSchema,
  type deliveryCorrectionViewSchema,
  flowDocNames,
  keepSnapshot,
  sumMoney,
  type CorrectionDetail,
  type FlowDocument,
  type FlowDocView,
} from '../../../shared/business/index.js';
import { deliverableOrder, quantityString, quantityUnits, today } from '../../../shared/core/index.js';
import { fail, type DeliveryLine, type FlowCommands } from '../documents/base.js';
import { commitInput, type CorrectionContext, type CorrectionKind } from '../rules/correction-movements.js';
import { shippedAtOf } from '../rules/confirm.js';
import {
  orderImpactOf,
  overdeliveryWarnings,
  replacementLines,
  shippedPriceWarnings,
  viewLines,
  type DeliveryInput,
  type Orders,
} from './delivery-correction-lines.js';
import { updateOrders } from '../rules/order-progress.js';
import { shippedByLine } from '../documents/shipped.js';
import { documentInput, validateFlow } from '../rules/validate.js';

/*
 * 更正送货单（更正的核心在 correction.ts，逐行的部分在 delivery-correction-lines.ts）：已出库（送货中、已送达）的
 * 送货单数量登记错了、某一行其实没发。业务账号（和“撤销这次送货”同一级）改每行数量、删掉没发的行；数量变多超出订单剩余的
 * 要超级管理员模式并写原因，数量变少不卡历史超发。本机管理员另能改出库日期、把一行换挂到同一客户的另一条订单明细、加行。
 * 不支持换客户。更正只改人改的东西：沿用的行照原单出库时抄下的品名、单价、税率这些（keepSnapshot）；替代单沿用原单的确认时间（财务按它定收入确认口径）、
 * 出库和送达记录；改了出库日期的，出库时间按新日期北京时间中午。
 */

/** 预览里送货自己的内容（结构在 shared/business/flow/flow-correction-views.ts） */
type View = CorrectionDetail<z.output<typeof deliveryCorrectionViewSchema>>;

/** 原送货单按内容应出的库存：每行出库，按库存品合计（出库为负） */
function stocked(stored: FlowDocument<'delivery'>) {
  const m = new Map<number, number>();
  for (const l of stored.lines || []) m.set(l.stockId, (m.get(l.stockId) || 0) - quantityUnits(l.quantity));
  return m;
}

/** 改出库日期、换挂、加行要本机管理员；出库日期不晚于今天、不晚于送达日（不早于下单日在核对订单时查） */
function checkHeader(original: FlowDocView<'delivery'>, stored: FlowDocument<'delivery'>, input: DeliveryInput, next: ReturnType<typeof replacementLines>, actor: Actor) {
  const date = input.date ?? original.date,
    dateChanged = date !== original.date;
  if (!next.structural && !dateChanged && !next.changed) fail('更正内容和原送货单一样，不用提交。');
  if ((next.structural || dateChanged) && !isLocalAdministrator(actor))
    throw new AppError('业务账号只能改每一行的数量、删掉没发的行；改出库日期、换订单明细、加行要本机管理员来做。', 403, 'permission');
  if (dateChanged && date > today()) fail('出库日期不能晚于今天。');
  // 送达日期列只收 YYYY-MM-DD（建表的 CHECK），内容里的和它一致
  const delivered = stored.deliveredAt;
  if (dateChanged && delivered && date > delivered) fail('出库日期不能晚于已确认的送达日期 ' + delivered + '。');
  return { date, dateChanged };
}

/** 换挂、新加的行守安排送货的规矩：同一客户正常待完成的订单，成品库存没归档；出库日期不早于各订单的下单日 */
function checkLinkedOrders(flow: FlowCommands, stored: FlowDocument<'delivery'>, lines: DeliveryLine[], orders: Orders, head: { date: string; dateChanged: boolean }) {
  const kept = new Set(stored.lines.map((l) => l.orderLineId)),
    added = lines.filter((l) => !kept.has(l.orderLineId));
  if (
    added.some((l) => {
      const order = orders.get(l.orderId);
      return !order || !deliverableOrder(order);
    })
  )
    fail('换挂、新加的行要选同一客户正常待完成订单的明细。');
  const addedStock = [...new Set(added.map((l) => l.stockId))];
  if (flow.ops.items(false, addedStock).length !== addedStock.length) fail('这条订单明细的成品库存已归档，请先恢复。');
  if (!head.dateChanged && !added.length) return;
  const late = [...orders.values()].find((o) => lines.some((l) => l.orderId === o.id) && o.orderDate > head.date);
  if (late) fail('出库日期不能早于订单 ' + late.number + ' 的下单日期 ' + late.orderDate + '。');
}

function plan(flow: FlowCommands, original: FlowDocView<'delivery'>, stored: FlowDocument<'delivery'>, input: DeliveryInput, actor: Actor) {
  const next = replacementLines(flow, stored, input),
    head = checkHeader(original, stored, input, next, actor);
  const allow = {
    allowOverdelivery: input.allowOverdelivery ?? stored.allowOverdelivery ?? false,
    overdeliveryReason: input.overdeliveryReason ?? stored.overdeliveryReason ?? '',
  };
  // 替代单按送货单的格式规整，再按出库的规则校验（客户、订单明细、成品、规格）；沿用的客户、订单、成品后来归档了也照样能更正。
  // 订单剩余这里不让它查（原单的数量还算在已发里），下面只查数量变多的行
  const checked = validateFlow(flow, documentInput('delivery', { ...stored, date: head.date, ...allow, lines: next.lines }), actor, false, {
    excludingId: original.id,
    skipRemaining: true,
    maintenance: true,
  });
  // 抄下来的快照引用没变的留着原单出库时的（品名、规格、单价、税率、材质楞型、尺寸，金额按新数量乘出库时的单价重算）；
  // 换挂、新加的行按那条订单明细、产品现在的取
  const document = keepSnapshot(stored, { ...checked.document, customerName: sales(flow.store).customer(checked.document.customerId, true)?.name }),
    lines = document.lines;
  const orders = new Map(
    sales(flow.store).ordersByIds([...new Set([...stored.lines, ...lines].map((l) => l.orderId))], true).map((o) => [o.id, o]),
  );
  checkLinkedOrders(flow, stored, lines, orders, head);
  const warnings = [
    ...checked.warnings,
    ...shippedPriceWarnings(checked.lines, lines),
    ...overdeliveryWarnings(flow, actor, { lines, stored, orders, originalId: original.id, allow }),
  ];
  const orderImpact = orderImpactOf(flow, stored, lines, orders);
  const view: View = {
    original,
    customerName: document.customerName ?? '',
    date: { before: original.date, after: head.date },
    lines: viewLines(lines, stored, input, next.used),
    orderImpact,
    beforeAmount: sumMoney(stored.lines.map((l) => l.amountExact ?? null)),
    afterAmount: sumMoney(lines.map((l) => l.amountExact ?? null)),
  };
  return {
    document,
    date: head.date,
    changes: checked.changes,
    warnings: [...new Set(warnings)],
    view,
    digest: { lines, orderImpact },
    data: { dateChanged: head.dateChanged, orderIds: [...orders.keys()], orderImpact },
  };
}

type DeliveryPlan = ReturnType<typeof plan>;

function finish(ctx: CorrectionContext<'delivery', DeliveryPlan['view'], DeliveryPlan['data']>) {
  const { flow, plan } = ctx,
    { orderIds, orderImpact } = plan.data;
  updateOrders(flow, orderIds);
  // 读回核验：每条订单明细的已发要和预览说的一样
  const shipped = shippedByLine(flow.store.db, orderIds);
  if (orderImpact.some((o) => quantityString(shipped.get(o.orderLineId) || 0) !== o.after))
    throw new AppError('更正后订单已发数量核验不一致，事务已回滚。', 409);
  const view = plan.view;
  const parts = [
    view.lines
      .filter((l) => l.before !== l.after)
      .map((l) => l.productName + ' ' + (l.before ?? '0') + ' ' + l.unit + ' → ' + l.after + ' ' + l.unit)
      .join('；'),
    ...(view.date.before !== view.date.after ? ['出库日期 ' + view.date.before + ' → ' + view.date.after] : []),
    ...plan.stockImpact.filter((s) => s.deltaUnits).map((s) => s.name + '库存净变化 ' + s.delta + ' ' + s.unit + '，现有 ' + s.after + ' ' + s.unit),
    ...orderImpact.map((o) => '订单 ' + o.orderNumber + ' ' + o.productName + ' 已发 ' + o.after + ' / ' + o.ordered + ' ' + o.unit),
  ];
  return {
    summary: parts.filter(Boolean).join('；') + '。',
    result: { orderImpact, beforeAmount: view.beforeAmount, afterAmount: view.afterAmount },
  };
}

/** 提交结果里送货多带的（结构在 shared/business/flow/flow-correction-views.ts，同一请求号重发时按它读回）：订单已发前后、送货金额前后 */
type DeliveryResult = z.output<typeof deliveryCorrectionExtraSchema>;

export const deliveryCorrection: CorrectionKind<'delivery', DeliveryInput, DeliveryPlan['view'], DeliveryPlan['data'], DeliveryResult> = {
  kind: 'delivery',
  name: flowDocNames.delivery,
  effective: '已出库送货单',
  schema: deliveryCorrectionPreviewSchema,
  commit: commitInput(correctionCommit(deliveryCorrectionPreviewSchema)),
  result: deliveryCorrectionExtraSchema,
  allow: () => {},
  stocked,
  plan,
  // 确认人、确认时间（财务的收入确认口径看它）、出库人、出库时间、送达记录沿用原单；改了出库日期的，出库时间按新日期北京时间中午
  inherit: (stored, plan) => ({
    confirmedBy: stored.confirmedBy,
    confirmedAt: stored.confirmedAt,
    shippedBy: stored.shippedBy,
    shippedAt: plan.data.dateChanged ? shippedAtOf(plan.date) : stored.shippedAt,
    ...(stored.deliveredAt ? { deliveredAt: stored.deliveredAt, deliveredBy: stored.deliveredBy } : {}),
  }),
  finish,
};
