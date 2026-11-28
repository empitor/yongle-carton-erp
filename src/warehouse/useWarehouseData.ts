import { useBusinessRevision, useLoad } from '../ui/index';
import { RECENT_DAYS } from '../../shared/business/index';
import { readCatalog } from '../recordkit/catalog-api';
import { readFlowDaily, readFlowList } from '../flow/flow-api';
import { readOrderBatches, type OrderBatch } from './order-batch-api';
import {
  isWarehouseDoc,
  type WarehouseKind,
  type WarehousePurchase,
  type WarehouseScope,
} from './warehouse-list';

// 默认只读还要处理的加最近 RECENT_DAYS 天的（和服务端不给天数时一样）；搜索、筛到更早的日期、打开更早的单据时再读全部。

/** 到货页对照的采购单：另读一遍全部采购单（路线图“已知问题”记着，到送货页不读） */
const readPurchases = (kind: WarehouseKind): Promise<WarehousePurchase[]> =>
  kind === 'arrival' ? readCatalog(['purchases']).then((r) => r.purchases) : Promise.resolve([]);
/** 到货页的待到货订货单：读不到时页头和待到货按没有订货单显示，不挡住到货记录 */
const readBatches = (kind: WarehouseKind): Promise<OrderBatch[]> =>
  kind === 'arrival' ? readOrderBatches().catch(() => []) : Promise.resolve([]);

/**
 * 到货、送货页要读的数据：到货、送货记录（full 为 false 时只读待处理和最近 RECENT_DAYS 天的），
 * 到货页另读采购单和待到货的订货单，“已归档”这一档才读已归档的单据。业务数据变了（erp-business-changed）就重读。
 */
export function useWarehouseData(kind: WarehouseKind, scope: WarehouseScope, full: boolean, actorId: unknown) {
  const [revision] = useBusinessRevision();
  const main = useLoad(
    actorId ? [kind, full, actorId].join('|') : null,
    () =>
      Promise.all([readFlowDaily(kind, full ? null : RECENT_DAYS), readPurchases(kind), readBatches(kind)]).then(
        ([d, purchases, batches]) => ({
          records: d.records,
          recentFrom: full ? '' : d.from || '',
          purchases,
          batches,
        }),
      ),
    revision,
  );
  // 已归档的单据（“已归档”这一档才读），和另两档同一张表、同一套筛选
  const archived = useLoad(
    scope === 'archived' && actorId ? [kind, actorId].join('|') : null,
    () => readFlowList(kind, true).then((rows) => rows.filter(isWarehouseDoc(kind))),
    revision,
  );
  const data = actorId ? main.data : null;
  return {
    records: data?.records || [],
    archivedRows: archived.data || [],
    archivedLoading: archived.loading,
    purchases: data?.purchases || [],
    batches: data?.batches || [],
    revision,
    // 第一次读完记录以后，才能判断链接打开的单据在不在里面
    loaded: !!main.data,
    recentFrom: data?.recentFrom || '',
    error: main.error || archived.error,
    busy: main.loading,
  };
}
