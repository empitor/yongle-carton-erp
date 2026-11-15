import type { Store } from '../core/index.js';
import type { Actor } from '../core/index.js';
import { AppError } from '../core/index.js';
import { FlowService } from '../flow/index.js';
import { OperationsService, OrderBatchService } from '../operations/index.js';
import { today } from '../../shared/core/index.js';
import type { DocumentExport } from '../../shared/documents/index.js';
// 导出文件交付完成后改业务状态：送货单出库（变送货中），订货单的采购单标已订货、建订货批次。在交付完成的事务里调用（service.ts 的 complete）。

/**
 * 导出出库：走 FlowService.shipDelivery。生成文件和交付完成跨了北京时间零点时，纸上印的“实际送货日期”是前一天，
 * 出库日要跟纸上一致，带上那天（确认会核对：不能晚于今天、不能早于关联订单的下单日期）。
 */
export function shipExported(store: Store, v: DocumentExport, actor: Actor) {
  const shipDate = v.shipDate && v.shipDate !== today() ? v.shipDate : undefined;
  return new FlowService(store).shipDelivery(v.id, v.expectedVersion, actor, shipDate);
}
/** 订货单交付完成：这几张采购单标成已订货（已订货的不动），建订货批次（同一批重新导出时沿用原来的批次） */
export function orderExported(store: Store, v: DocumentExport, exportId: string, actor: Actor) {
  const ops = new OperationsService(store),
    members = v.members ?? [{ id: v.id, version: v.expectedVersion }];
  for (const m of members) {
    const record = ops.repo.purchases(true, m.id)[0];
    if (!record || record.archived || record.businessStatus === '已取消')
      throw new AppError('采购已取消或归档，已交付文件但未修改业务状态。', 409);
    if (record.businessStatus !== '已订货') {
      if (record.version !== m.version)
        throw new AppError(
          '采购单已变化（' +
            record.number +
            '），文件已交付，但采购单还是待订货，请读取最新采购单后重新导出。',
          409,
        );
      ops.savePurchase({ ...record, status: '已订货', version: record.version }, actor, m.id, {
        skipBatch: true,
      });
    }
  }
  // 订货批次：到货页的待到货就是它；同一批重新导出时沿用原来的批次
  new OrderBatchService(store).create(
    members.map((m) => m.id),
    actor,
    {
      ...(v.batchNumber ? { number: v.batchNumber } : {}),
      exportId,
      schedule: v.scheduleEntries,
    },
  );
}
