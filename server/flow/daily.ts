import { z } from 'zod';
import { dateSchema, today } from '../../shared/domain.js';
import { FlowService } from './service.js';
import type { Store } from '../db.js';
export const dailyQuerySchema = z.strictObject({
  kind: z.enum(['arrival', 'delivery', 'task']),
  date: dateSchema.default(today),
  scope: z.enum(['day', 'all']).default('day'),
});
/** 同一批次按身份合并；计划日与真实完成日分别归属，未计划的实物流转也保留。 */
export class WarehouseDaily {
  constructor(readonly store: Store) {}
  records(kind: 'arrival' | 'delivery' | 'task'): any[] {
    const flow = new FlowService(this.store);
    if (kind === 'arrival') {
      const records = flow.arrivalRecords({ includeInactive: true });
      const plans = flow.arrivalPlans({ includeInactive: true });
      const purchases = this.store.purchases(true);
      const byId = new Map(records.map((r: any) => [r.id, r]));
      const merged = plans.map((p: any) => {
        const record = byId.get('flow-' + p.id);
        if (record) byId.delete(record.id);
        const lines =
          record?.lines ||
          p.lines.map((l: any, index: number) => {
            const purchase = purchases.find((x) =>
                x.lines.some((x: any) => x.id === l.purchaseLineId),
              ),
              pl = purchase?.lines.find((x: any) => x.id === l.purchaseLineId);
            return {
              ...l,
              index,
              purchaseId: purchase?.id,
              purchaseNumber: purchase?.number,
              orderedQuantity: pl?.quantity,
              receivedQuantity: pl?.receivedQuantity,
              remainingQuantity: pl?.remainingQuantity,
              arrivalStatus: pl?.arrivalStatus,
              acceptedQuantity: null,
              rejectedQuantity: null,
              stockedQuantity: '0',
              movements: [],
            };
          });
        return {
          ...p,
          ...record,
          lines,
          id: record?.id || 'flow-' + p.id,
          flowId: p.id,
          plannedDate: p.plannedDate,
          plannedTime: p.plannedTime,
          plan: p,
          actualDate: record?.status === 'confirmed' ? record.date : null,
          completed: !!record?.effective,
          cancelled: ['cancelled', 'reversed'].includes(p.status),
          pending: p.status === 'draft',
        };
      });
      return [
        ...merged,
        ...[...byId.values()].map((r: any) => ({
          ...r,
          actualDate: r.status === 'confirmed' ? r.date : null,
          plannedDate: null,
          completed: !!r.effective,
          cancelled: !r.effective && r.status !== 'draft',
          pending: r.status === 'draft',
          flowId: r.source === 'flow' ? Number(r.id.replace('flow-', '')) : null,
        })),
      ];
    }
    if (kind === 'task') return flow.list('task');
    const orders = this.store.orders(true),
      stocks = this.store.stock_items(true);
    return flow.list('delivery').map((d) => ({
      ...d,
      customerName:
        this.store.customers(true).find((c) => c.id === d.customerId)?.name || '历史客户',
      completed: d.status === 'confirmed',
      pending: d.status === 'draft',
      cancelled: ['cancelled', 'reversed'].includes(d.status),
      // 旧单据未保存计划字段时，仅作实际记录，不猜曾有计划。
      plannedDate: d.plannedDateSource === 'explicit' ? d.plannedDate : null,
      lines: d.lines.map((l: any) => {
        const o = orders.find((o) => o.id === l.orderId),
          ol = o?.lines.find((x) => x.id === l.orderLineId),
          stock = stocks.find((s) => s.id === l.stockId);
        return {
          ...ol,
          ...l,
          orderNumber: l.orderNumber || o?.number,
          productName: l.productName || ol?.productName || stock?.name,
          specification: l.specification || ol?.specification || stock?.specification,
          unit: l.unit || ol?.unit || stock?.unit,
          orderedQuantity: ol?.quantity,
          shippedQuantity: ol?.shippedQuantity,
          remainingQuantity: ol?.remainingQuantity,
          shippingStatus: ol?.shippingStatus,
          movements: this.store.db
            .prepare(
              "SELECT * FROM stock_movements WHERE source_kind IN ('flow_delivery','flow_reversal') AND source_id=? AND item_id=? ORDER BY created_at,id",
            )
            .all(String(d.id), l.stockId),
        };
      }),
    }));
  }
  get(raw: unknown) {
    const { kind, date, scope } = dailyQuerySchema.parse(raw),
      all = this.records(kind);
    if (kind === 'task')
      return { kind, date, records: all.filter((r) => (r.plannedDate || r.date) === date) };
    const dates = new Set(all.flatMap((r) => [r.plannedDate, r.actualDate]).filter(Boolean));
    const summarize = (d: string) => ({
      planned: all.filter((r) => !r.cancelled && r.plannedDate === d).length,
      completed: all.filter((r) => !r.cancelled && r.completed && r.actualDate === d).length,
      pending: all.filter((r) => !r.cancelled && r.pending && r.plannedDate === d).length,
    });
    return {
      kind,
      date,
      summary: summarize(date),
      counts: Object.fromEntries(
        [...dates].map((d) => [
          d,
          {
            ...summarize(d),
            total: all.filter((r) => !r.cancelled && (r.plannedDate === d || r.actualDate === d))
              .length,
          },
        ]),
      ),
      records: all.filter(
        (r) =>
          scope === 'all' || r.plannedDate === date ||
          r.actualDate === date ||
          (!r.plannedDate && r.status === 'draft' && r.date === date),
      ),
    };
  }
}
