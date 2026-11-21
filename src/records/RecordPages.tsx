// 今日、订单、客户、产品、归档几页（原来在 App.tsx 里）：页头、列表、归档页和三个编辑窗。
// 一直挂着（不随换页卸载），归档页选的类型、列表筛选和原来一样换页后还在；只有这几页才显示内容、读数据。
import { Suspense, useState } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import type { RecordEntity } from '../../shared/business/index';
import { ErrorBoundary, FormMessage, ListSummary, PageHeading, type AuthState } from '../ui/index';
import KindRecords, { type ListKind } from './KindRecords';
import DashboardPage from './DashboardPage';
import RecordEditors, { useRecordEditor } from './RecordEditors';
import RecordsToolbar from './RecordsToolbar';
import TrashPage, { type FlowTrash } from './TrashPage';
import { isRecordPage } from './record-filters';
import { useRecordLists, type RecordLists } from './useRecordLists';

/** 页头的统计：订单（范围内、待完成、逾期）、客户数、产品（范围内、资料不全，点一下只看这些） */
function ListMeta({ page, lists }: { page: string; lists: RecordLists }) {
  const { busy, listMetrics, metricsPending, productAttention } = lists;
  if (page === 'orders')
    return (
      <ListSummary
        items={[
          { label: '订单', value: metricsPending ? '—' : listMetrics.orders.total, hint: '当前范围' },
          { label: '待完成', value: metricsPending ? '—' : listMetrics.orders.pending, hint: '已确认、生产中、待发货' },
          { label: '逾期', value: metricsPending ? '—' : listMetrics.orders.overdue, hint: '过了交期还没发完' },
        ]}
      />
    );
  if (page === 'customers') return <ListSummary items={[{ label: '客户', value: busy ? '—' : lists.customerRows.length }]} />;
  if (page === 'products')
    return (
      <ListSummary
        items={[
          { label: '产品', value: busy ? '—' : listMetrics.products.total, hint: '当前范围' },
          {
            // 点一下只看资料不全的；再点恢复。只是提醒，不影响下单和导入
            label: '资料不全',
            value: busy ? '—' : listMetrics.products.incomplete,
            hint: productAttention ? '正在只看这些，点一下恢复' : '点一下只看这些',
            onClick: () => lists.setProductAttention((v) => !v),
            active: productAttention,
          },
        ]}
      />
    );
  return null;
}

/** 列表空时的一句话：订单“待处理”都办完了、产品“资料不全”一个都没有，各说一句；别的用列表默认的 */
function emptyHint(listPage: ListKind, lists: RecordLists) {
  if (listPage === 'orders' && lists.listScope === 'pending' && !lists.search && !lists.orderFilterCount)
    return { title: '没有要处理的订单', description: '都发完了。切到“全部”看历史订单，或点右上角“新建订单”。' };
  if (listPage === 'products' && lists.productAttention)
    return { title: '没有资料不全的产品', description: '点上面“资料不全”恢复看全部。' };
  return undefined;
}

/** 订单、客户、产品页是哪一种列表；别的页不是 */
const listKinds: readonly ListKind[] = ['orders', 'customers', 'products'];
const listKindOf = (page: string) => listKinds.find((kind) => kind === page) ?? null;

const createLabels: Record<ListKind, string> = { customers: '新建客户', products: '新建产品', orders: '新建订单' };

/**
 * 订单、客户、产品页头只放一个主按钮“新建××”；刷新去掉（数据会自动刷新），
 * 订单页的“AI 导入”去掉（侧栏和右上角“新建”里都有）
 */
function CreateButton({ kind, disabled, open }: { kind: ListKind; disabled: boolean; open: () => void }) {
  return (
    <button className="primary" disabled={disabled} onClick={open}>
      <Plus size={17} />
      {createLabels[kind]}
    </button>
  );
}

/** 列表读不出来：原因和“重新加载” */
function ListError({ error, reload }: { error: string; reload: () => void }) {
  return (
    <FormMessage
      action={
        <button onClick={reload}>
          <RefreshCw size={14} />
          重新加载
        </button>
      }
    >
      {error}
    </FormMessage>
  );
}

/** 订单由服务端分页排序 */
const orderPaging = (lists: RecordLists) => ({
  page: lists.listMetrics.ordersPage,
  total: lists.listMetrics.ordersFiltered,
  onPage: lists.setOrderPage,
  sort: lists.orderSort,
  onSort: lists.setOrderSort,
});

export default function RecordPages({
  page,
  routeKey,
  auth,
  financeOnly,
  canCreate,
  title,
  notify,
}: {
  page: string;
  routeKey: string;
  auth: AuthState;
  financeOnly: boolean;
  canCreate: boolean;
  /** 页头的标题由 App 统一给（和别的页面同一张表） */
  title: string;
  /** 页面底部提示；tone 为 error 用红色 */
  notify: (message: string, tone?: 'done' | 'error') => void;
}) {
  const superMode = !!auth.actor?.superAdminMode;
  const [trashEntity, setTrashEntity] = useState<RecordEntity>('orders'),
    [flowTrash, setFlowTrash] = useState<FlowTrash>(null);
  const lists = useRecordLists({
    page,
    signedIn: !!auth.actor,
    actorId: auth.actor?.id,
    superMode,
    financeOnly,
    trashEntity,
  });
  const { editor, setEditor } = useRecordEditor({ page, routeKey, signedIn: !!auth.actor, canCreate, notify });
  const changed = (message?: string) => {
    if (message) notify(message);
    lists.reload();
  };
  const editors = (
    <RecordEditors
      editor={editor}
      setEditor={setEditor}
      customers={lists.customers}
      products={lists.products}
      loading={lists.busy}
      routeKey={routeKey}
      notify={notify}
    />
  );
  if (!auth.actor || !isRecordPage(page)) return editors;
  const { busy, error, productAttention } = lists;
  const listPage = listKindOf(page);
  return (
    <>
      <ErrorBoundary key={page}>
        <Suspense fallback={<p role="status">正在打开页面…</p>}>
          <PageHeading
            title={title}
            meta={!error && <ListMeta page={page} lists={lists} />}
            actions={
              listPage && canCreate ? (
                <CreateButton kind={listPage} disabled={busy || !!error} open={() => setEditor({ kind: listPage })} />
              ) : undefined
            }
          />
          {error && <ListError error={error} reload={lists.reload} />}
          {listPage && <RecordsToolbar page={listPage} lists={lists} superMode={superMode} />}
          {/* 今日待办不等经营概况：概况的数据由 DashboardPage 切到“经营概况”时自己读 */}
          {page === 'dashboard' && <DashboardPage />}
          {listPage && !error && (
            <KindRecords
              key={listPage}
              filterKey={[lists.search, lists.customerId, lists.status, lists.start, lists.end, lists.orderView, productAttention].join('|')}
              empty={emptyHint(listPage, lists)}
              paging={listPage === 'orders' ? orderPaging(lists) : undefined}
              kind={listPage}
              lists={lists}
              archived={lists.archivedView}
              edit={setEditor}
              changed={changed}
              allRecords={lists.allRecordsView && superMode}
            />
          )}
          {page === 'trash' && (
            <TrashPage
              lists={lists}
              trashEntity={trashEntity}
              setTrashEntity={setTrashEntity}
              flowTrash={flowTrash}
              setFlowTrash={setFlowTrash}
              edit={setEditor}
              changed={changed}
            />
          )}
          {page !== 'dashboard' && busy && !lists.loaded && <div className="empty">正在连接本机数据库…</div>}
        </Suspense>
      </ErrorBoundary>
      {editors}
    </>
  );
}
