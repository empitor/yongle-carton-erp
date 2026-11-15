import { Suspense, lazy, useState } from 'react';
import WarehouseRecords from '../warehouse/WarehouseRecords';
import SuppliersPage from './SuppliersPage';
import PurchasesPage from './PurchasesPage';
import StockPage from './StockPage';
import MovementsPage from './MovementsPage';
import { notify, hashParams } from '../ui/index';

const DeliveryPlanDialog = lazy(() => import('../warehouse/DeliveryPlanDialog'));
const ids = (v: string | null) => (v ? v.split(',').map(Number).filter((n) => n > 0) : undefined);

/**
 * 采购和库存的几个页面按地址分开：供应商、采购单；库存（#warehouse）下按参数是库存、流水（flow=1）、
 * 到货（arrivals=1）、送货（deliveries=1）。带 createDelivery=1 进来的直接打开安排送货。
 * recycle 是归档页里的已归档供应商、采购单、库存品。
 */
export default function OperationsPage({
  mode,
  recycle = false,
}: {
  mode: 'suppliers' | 'purchases' | 'warehouse';
  recycle?: boolean;
}) {
  // 进页面时读一次地址参数；换页面时外面换 key 重新挂载
  const [route] = useState(() => {
    const params = hashParams();
    return {
      flow: params.get('flow') === '1',
      deliveries: params.get('deliveries') === '1',
      arrivals: params.get('arrivals') === '1',
    };
  });
  // 带 createDelivery=1 进来：按地址里的订单（order）或成品库存（stock）打开安排送货窗口
  const [deliveryLaunch, setDeliveryLaunch] = useState<{ orderIds?: number[]; stockIds?: number[] } | null>(() => {
    const params = hashParams();
    return params.get('createDelivery') === '1'
      ? { orderIds: ids(params.get('order')), stockIds: ids(params.get('stock')) }
      : null;
  });
  if (mode === 'suppliers') return <SuppliersPage recycle={recycle} />;
  if (mode === 'purchases') return <PurchasesPage recycle={recycle} />;
  // 到货、送货页放在和原来一样的外框里（样式按它排）
  const records = (kind: 'arrival' | 'delivery') => (
    <div className="operations-workspace unified-business-page">
      <div>
        <WarehouseRecords key={kind} kind={kind} />
      </div>
    </div>
  );
  const warehouse = route.arrivals ? (
    records('arrival')
  ) : route.deliveries ? (
    records('delivery')
  ) : route.flow ? (
    <MovementsPage />
  ) : (
    <StockPage recycle={recycle} />
  );
  return (
    <>
      {warehouse}
      {deliveryLaunch && (
        <Suspense fallback={null}>
          <DeliveryPlanDialog
            {...deliveryLaunch}
            close={() => setDeliveryLaunch(null)}
            done={(message) => {
              setDeliveryLaunch(null);
              notify(message);
            }}
          />
        </Suspense>
      )}
    </>
  );
}
