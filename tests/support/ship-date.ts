import { today } from '../../shared/core/domain.js';
import type { FlowService } from '../../server/flow/index.js';

/**
 * 测试里补录历史送货：确认送货单时，出库日按单据上写的日期（真实操作里出库日就是确认那天）。
 * 不是送货单，或日期在今天以后，就不带，照常按今天出库。
 */
export function shipOnDocDate(flow: Pick<FlowService, 'get'>, id: number): { shipDate?: string } {
  const doc = flow.get(id);
  return doc.kind === 'delivery' && doc.status === 'draft' && doc.date <= today() ? { shipDate: doc.date } : {};
}
