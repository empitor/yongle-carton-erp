import { lazy, Suspense } from 'react';
import type { RecordDialog } from './order-step';

const FlowPage = lazy(() => import('../flow/FlowPage'));
const PurchaseLaunch = lazy(() => import('../operations/PurchaseLaunch'));
const DeliveryPlanDialog = lazy(() => import('../warehouse/DeliveryPlanDialog'));
const TaskPlanDialog = lazy(() => import('../flow/TaskPlanDialog'));
const OrderBatchDialog = lazy(() => import('../operations/OrderBatchDialog'));
const BatchReceiveDialog = lazy(() => import('../warehouse/BatchReceiveDialog'));

/**
 * 把办理窗口画出来（按需加载）。close：窗口关了；done：办成了，带一句结果。
 * 安排订料、单据窗口自己提示结果，只调 close。
 */
export function RecordDialogView({
  dialog,
  close,
  done,
}: {
  dialog: RecordDialog;
  close: () => void;
  done: (message: string) => void;
}) {
  return (
    <Suspense fallback={null}>
      {dialog.type === 'flow' && (
        <FlowPage
          key={dialog.mode + JSON.stringify(dialog.params)}
          mode={dialog.mode}
          dialogOnly
          launch={dialog.params}
          onClose={close}
        />
      )}
      {dialog.type === 'purchase' && (
        <PurchaseLaunch orderIds={[dialog.orderId]} productIds={dialog.productIds} close={close} />
      )}
      {dialog.type === 'delivery' && (
        <DeliveryPlanDialog orderIds={dialog.orderIds} stockIds={dialog.stockIds} close={close} done={done} />
      )}
      {dialog.type === 'task' && (
        <TaskPlanDialog orderIds={dialog.orderIds} products={dialog.products} close={close} done={done} />
      )}
      {dialog.type === 'order-sheet' && (
        <OrderBatchDialog purchaseIds={dialog.purchaseIds} close={close} done={done} />
      )}
      {dialog.type === 'receive' && <BatchReceiveDialog purchaseId={dialog.purchaseId} close={close} done={done} />}
    </Suspense>
  );
}
