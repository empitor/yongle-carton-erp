import { planDate } from '../../shared/business/index';
import { today } from '../../shared/core/index';

/** 单据的日期判断：实际发货日、逾期。只算数据，详情、列表、仓库页都用。 */

/** 送货单的实际发货日：出库的那天（shippedAt）；还没出库的没有。 */
export function shipDate(d: { kind?: string; shippedAt?: string | null }): string {
  if (d.kind && d.kind !== 'delivery') return '';
  return d.shippedAt ? today(new Date(d.shippedAt)) : '';
}

/** 判断办没办完要看的：归档、状态、种类，生产任务的完工进度（百分比） */
type OpenState = { archived?: boolean; status: string; kind: string; progress?: number };

/** 还没办完的：待入库、待送货，以及没做完的生产任务。 */
export const isOpen = (r: OpenState) =>
  !r.archived &&
  (r.status === 'draft' || (r.kind === 'task' && r.status === 'confirmed' && Number(r.progress) < 100));

/** 还没办完、计划日已经过了：待送货，或没做完的生产任务。 */
export function flowOverdue(d: OpenState & { plannedDate?: string | null; date: string }) {
  if (d.archived) return false;
  const open =
    d.status === 'draft' ||
    (d.kind === 'task' && d.status === 'confirmed' && (d.progress ?? 0) < 100);
  const plan = d.kind === 'task' || d.kind === 'delivery' ? planDate(d) : '';
  return open && !!plan && plan < today();
}
