import { lazy, Suspense, useEffect, useEffectEvent, useState } from 'react';
import type { Customer, Order, Product } from '../../shared/core/index';
import { emit, listen, readOnlyNotice } from '../ui/index';
import { readRecord } from '../recordkit/record-api';
import { idList } from '../recordkit/launch';

// 编辑窗点了才用，按需加载
const CustomerEditor = lazy(() => import('../editors/CustomerEditor'));
const OrderEditor = lazy(() => import('../editors/OrderEditor'));
const ProductEditor = lazy(() => import('../editors/ProductEditor'));

/** 订单、客户、产品页开着的编辑窗：编辑哪一条，或新建（订单可以带客户、产品） */
export type RecordEditor =
  | { kind: 'customers'; value?: Customer }
  | { kind: 'products'; value?: Product }
  | { kind: 'orders'; value?: Order; preset?: { customerId?: number; productIds?: number[] } }
  | null;

type OpenEditor = NonNullable<RecordEditor>;

/** 按主键重读开着的这一条（订单、客户、产品） */
async function reread(current: OpenEditor, id: number): Promise<OpenEditor> {
  switch (current.kind) {
    case 'orders':
      return { kind: 'orders', value: await readRecord('orders', id) };
    case 'customers':
      return { kind: 'customers', value: await readRecord('customers', id) };
    case 'products':
      return { kind: 'products', value: await readRecord('products', id) };
  }
}

/** 还开着同一条才换成重读到的内容（订单窗原来带的预填照旧） */
function withFresh(latest: RecordEditor, fresh: OpenEditor): RecordEditor {
  if (!latest || latest.value?.id !== fresh.value?.id) return latest;
  if (latest.kind === 'orders' && fresh.kind === 'orders') return { ...latest, value: fresh.value };
  if (latest.kind === 'customers' && fresh.kind === 'customers') return { ...latest, value: fresh.value };
  if (latest.kind === 'products' && fresh.kind === 'products') return { ...latest, value: fresh.value };
  return latest;
}

/**
 * 编辑窗开哪个：换页就关；#orders?create=1 打开新建订单（只读账号只说一句为什么）；
 * 业务数据变了，开着的那条按主键重读，免得拿旧版本去存。
 */
export function useRecordEditor({
  page,
  routeKey,
  signedIn,
  canCreate,
  notify,
}: {
  page: string;
  routeKey: string;
  signedIn: boolean;
  canCreate: boolean;
  notify: (message: string, tone?: 'done' | 'error') => void;
}) {
  const [editor, setEditor] = useState<RecordEditor>(null);
  // 只跟着页面、地址、登录和权限打开；提示用当时最新的那个函数
  const say = useEffectEvent(notify);
  // 切换页面时关闭上一页的编辑窗；必须排在下面的 create=1 之前，否则会关掉刚打开的新建窗。
  useEffect(() => {
    setEditor(null);
  }, [page]);
  useEffect(() => {
    const params = new URLSearchParams(routeKey.split('?')[1] || '');
    if (page !== 'orders' || params.get('create') !== '1' || !signedIn) return;
    if (!canCreate) {
      say(readOnlyNotice, 'error');
      return;
    }
    setEditor({
      kind: 'orders',
      // 从客户、产品“新建订单”过来的：预先填客户或产品
      preset: {
        customerId: Number(params.get('customer')) || undefined,
        productIds: idList(params.get('products')),
      },
    });
  }, [page, routeKey, signedIn, canCreate]);
  useEffect(
    () =>
      listen('erp-business-changed', () =>
        setEditor((current) => {
          if (current?.value?.id)
            void reread(current, current.value.id)
              .then((fresh) => setEditor((latest) => withFresh(latest, fresh)))
              // 重读没读到（断网、刚被删）：编辑窗留着打开时的内容，保存时服务端按版本号把关
              .catch(() => {});
          return current;
        }),
      ),
    [],
  );
  return { editor, setEditor };
}

/** 客户、产品、订单的编辑窗，以及告诉助手当前打开的是哪条记录。保存后关窗、提示，列表靠“业务数据变了”重读。 */
export default function RecordEditors({
  editor,
  setEditor,
  customers,
  products,
  loading,
  routeKey,
  notify,
}: {
  editor: RecordEditor;
  setEditor: (editor: RecordEditor) => void;
  customers: Customer[];
  products: Product[];
  /** 列表还在读：订单编辑窗等客户、产品读到 */
  loading: boolean;
  routeKey: string;
  notify: (message: string, tone?: 'done' | 'error') => void;
}) {
  const close = () => setEditor(null);
  const saved = () => {
    emit('erp-business-changed');
    setEditor(null);
    notify('已保存到本机数据库');
  };
  return (
    <>
      {editor?.value && (
        <span
          data-agent-module={editor.kind}
          data-agent-record={editor.value.id}
          data-agent-label={'number' in editor.value ? editor.value.number : editor.value.name}
          style={{ position: 'fixed', width: 1, height: 1, left: 0, top: 0 }}
        />
      )}
      <Suspense fallback={<p role="status">正在打开…</p>}>
        {editor?.kind === 'customers' && <CustomerEditor value={editor.value} close={close} saved={saved} />}
        {editor?.kind === 'products' && (
          <ProductEditor value={editor.value} customers={customers} close={close} saved={saved} />
        )}
        {editor?.kind === 'orders' && (
          <OrderEditor
            loading={loading}
            key={editor.value ? editor.value.id + ':' + editor.value.version : 'new:' + routeKey}
            value={editor.value}
            preset={editor.preset}
            customers={customers}
            products={products}
            close={close}
            saved={(_, message) => {
              emit('erp-business-changed');
              setEditor(null);
              notify(message);
            }}
          />
        )}
      </Suspense>
    </>
  );
}
