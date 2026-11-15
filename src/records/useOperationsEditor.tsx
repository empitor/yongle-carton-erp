import { useEffect, useState } from 'react';
import type { PurchaseView, StockItemView, SupplierView } from '../../shared/business/index';
import { errorMessage, type Order, type Product } from '../../shared/core/index';
import { emit } from '../ui/index';
import { readCatalog } from '../recordkit/catalog-api';
import { PurchaseEditor } from '../operations/PurchaseEditor';
import { StockEditor } from '../operations/StockEditor';
import { MovementDialog } from '../operations/MovementDialog';
import CustomerEditor from '../editors/CustomerEditor';
import PurchaseLaunch from '../operations/PurchaseLaunch';
import { purchaseSeedFrom } from '../operations/purchase-seed';

/** 开着的是哪个窗：采购单（新建时可带预填的供应商、纸板）、库存品、出入库、供应商、从订单安排订料 */
type OperationsEditor =
  | { type: 'purchase'; value?: PurchaseView; seed?: { supplierId?: number; stockIds?: number[] } }
  | { type: 'stock'; value?: StockItemView }
  /** 出入库 / 盘点：一定是对某个库存品 */
  | { type: 'move'; value: StockItemView }
  | { type: 'supplier'; value?: SupplierView }
  | { type: 'purchase-launch'; value: { orderId: number; productIds: number[] } };
/** 采购单、库存品编辑窗要的全部订单和产品 */
type Lookups = { orders: Order[]; products: Product[] };
/** 保存回来的记录：供应商带名称，采购单带单号 */
type Saved = { name?: string; number?: string };

/** 编辑窗办完以后列表上方的一句：供应商、采购单带上名称或单号 */
function savedNotice(type: OperationsEditor['type'] | undefined, result?: Saved) {
  if (type === 'supplier') return '供应商 ' + (result?.name || '') + ' 已保存。';
  if (type === 'purchase' && result?.number) return '采购单 ' + result.number + ' 已保存。';
  return type === 'move' ? '库存变动已登记，流水已保存。' : '已保存，列表和库存已更新。';
}

/** 编辑窗才用得上全部订单和产品，打开采购单、库存品窗时再读；读不出时不开窗，原因放进 error */
function useLookups(
  editor: OperationsEditor | null,
  superMode: boolean,
  setError: (message: string) => void,
  setEditor: (editor: null) => void,
) {
  const [lookups, setLookups] = useState<Lookups | null>(null);
  const needsLookups = !!editor && ['purchase', 'stock'].includes(editor.type);
  useEffect(() => {
    if (!needsLookups) {
      setLookups(null);
      return;
    }
    let active = true;
    setError('');
    readCatalog(['orders', 'products'], { all: superMode })
      .then(({ orders, products }: Lookups) => {
        if (active) setLookups({ orders, products });
      })
      .catch((e: unknown) => {
        if (active) {
          setError(errorMessage(e));
          setEditor(null);
        }
      });
    return () => {
      active = false;
    };
    // setError、setEditor 是 useState 给的，不会变
  }, [needsLookups, superMode, setError, setEditor]);
  return lookups;
}

type EditorsProps = {
  editor: OperationsEditor | null;
  lookups: Lookups | null;
  suppliers: SupplierView[];
  items: StockItemView[];
  kind: string;
  close: () => void;
  done: (result?: Saved) => void;
  launched: (message: string) => void;
};

/** 把开着的那个编辑窗画出来 */
function OperationsEditors({ editor, lookups, suppliers, items, kind, close, done, launched }: EditorsProps) {
  if (editor?.type === 'purchase')
    return lookups && (!editor.seed?.stockIds?.length || items.length > 0) ? (
      <PurchaseEditor
        key={editor.value?.id ?? 'new:' + location.hash}
        value={editor.value}
        initialValues={editor.value ? undefined : purchaseSeedFrom(editor.seed, items)}
        suppliers={suppliers}
        orders={lookups.orders}
        items={items}
        close={close}
        saved={done}
      />
    ) : null;
  if (editor?.type === 'stock')
    return lookups ? <StockEditor value={editor.value} kind={kind} products={lookups.products} close={close} saved={done} /> : null;
  if (editor?.type === 'move') return <MovementDialog item={editor.value} close={close} saved={done} />;
  // 供应商档案和客户档案同一个窗口、同样的结构
  if (editor?.type === 'supplier') return <CustomerEditor entity="suppliers" value={editor.value} close={close} saved={done} />;
  if (editor?.type === 'purchase-launch')
    return <PurchaseLaunch orderIds={[editor.value.orderId]} productIds={editor.value.productIds} close={close} done={launched} />;
  return null;
}

/**
 * 供应商、采购单、库存页的编辑窗：新建、编辑、出入库 / 盘点、安排订料。
 * 办完就关窗，结果用 setNotice 显示在列表上方。
 */
export function useOperationsEditor({
  superMode,
  suppliers = [],
  items = [],
  kind = 'raw',
  setNotice,
}: {
  superMode: boolean;
  suppliers?: SupplierView[];
  items?: StockItemView[];
  /** 库存页当前是原材料还是成品：新建库存品用 */
  kind?: string;
  setNotice: (message: string) => void;
}) {
  const [editor, setEditor] = useState<OperationsEditor | null>(null),
    [error, setError] = useState('');
  const lookups = useLookups(editor, superMode, setError, setEditor);
  /** 办完就关窗，结果显示在列表上方的提示里；列表靠“业务数据变了”重读。 */
  const done = (result?: Saved) => {
    const type = editor?.type;
    setEditor(null);
    emit('erp-business-changed');
    setNotice(savedNotice(type, result));
  };
  const close = () => setEditor(null);
  const launched = (message: string) => {
    setEditor(null);
    setNotice(message);
  };
  const editors = (
    <OperationsEditors {...{ editor, lookups, suppliers, items, kind, close, done, launched }} />
  );
  return { editor, setEditor, editors, error };
}
