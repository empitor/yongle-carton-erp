import type { FlowKind } from '../../shared/core/index';
import { useState, lazy, Suspense, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import type { NextSteps } from '../../shared/business/index';
import { canEditBusiness, useAuthState, FinanceRelatedSlot, Hint, Section, Loading } from '../ui/index';
import { MarkCards } from '../marks/ProductMarks';
import { useRelatedData, type Related, type RelatedData } from './useRelatedData';
import { nextPlan, stepSentence } from './order-step';
import type { RecordRowOf } from './record-rows';
import { OrderDocs, PurchaseDocs, StockList, orderHasDocs, purchaseHasDocs, type OpenDoc } from './RelatedLists';
const FlowPage = lazy(() => import('../flow/FlowPage'));

/** 最上面一句“下一步”（为什么是这一步；按钮在详情头部）和要注意的提示 */
function NextStepSection(o: { plan: NextSteps | null; error: string; canEdit: boolean; archived: boolean }) {
  const { plan, error, canEdit } = o;
  const step = plan?.steps[0];
  return (
    <section className="rb-next" aria-label="下一步">
      {error && <Hint tone="danger">{error}</Hint>}
      {!canEdit && <p className="help-text">当前账号只能查看单据，操作需要业务编辑权限。</p>}
      {canEdit && !plan && !error && !o.archived && (
        <Loading />
      )}
      {plan?.done && (
        <p className="rb-done">
          <Check size={15} aria-hidden="true" />
          {plan.done}
        </p>
      )}
      {step && (
        <p className="rb-step-sentence">
          <strong>下一步</strong>
          {stepSentence(step)}
        </p>
      )}
      {plan?.notes.map((note) => (
        <Hint tone="warning" key={note}>
          {note}
        </Hint>
      ))}
    </section>
  );
}

/** 有内容的关联单据、唛头、对应的库存品（订单的带唛头、生产送货，采购单的带到货记录） */
function RelatedSections({ data, open }: { data: RelatedData; open: OpenDoc }) {
  const order = 'marks' in data ? data : null,
    purchase = 'arrivals' in data ? data : null;
  const hasDocs = order ? orderHasDocs(order) : purchase ? purchaseHasDocs(purchase) : false;
  return (
    <div className="rb-related">
      {hasDocs && (
        <Section title="关联单据">
          {order && <OrderDocs data={order} open={open} />}
          {purchase && <PurchaseDocs data={purchase} open={open} />}
        </Section>
      )}
      {order && order.marks.length > 0 && (
        <Section title={'产品唛头 · ' + order.marks.length}>
          <MarkCards marks={order.marks} />
        </Section>
      )}
      <StockList stocks={data.stocks} title={order ? '对应成品库存' : '对应原材料库存'} />
    </div>
  );
}

/**
 * 订单、采购单详情的骨架：最上面一句“下一步”和要注意的提示，
 * 中间是单据本身（children），最后是有内容的关联单据（都能点开）。
 * related 由详情面板传入（和头部按钮共用一份关联数据）；不传时自己读。
 */
export default function RelatedBusiness<E extends 'orders' | 'purchases'>({
  entity,
  row,
  children,
  related,
}: {
  entity: E;
  row: RecordRowOf[E];
  children?: ReactNode;
  related?: Related;
}) {
  const auth = useAuthState(),
    canEdit = canEditBusiness(auth);
  const own = useRelatedData(entity, row, !related);
  const data = related ? related.data : own.data,
    error = related ? related.error : own.error,
    plan = related ? related.plan : nextPlan(entity, row, own.data, canEdit);
  const [launch, setLaunch] = useState<{ mode: FlowKind; params: Record<string, string> } | null>(null);
  const open: OpenDoc = (mode, doc) => {
    const id = String(doc.flowId || doc.id).replace('flow-', '');
    setLaunch({ mode, params: { doc: id } });
  };
  return (
    <>
      <NextStepSection plan={plan} error={error} canEdit={canEdit} archived={!!row.archived} />
      {children}
      {entity === 'orders' && <FinanceRelatedSlot kind="orders" id={row.id} />}
      {data && <RelatedSections data={data} open={open} />}
      {launch && (
        <Suspense fallback={<p role="status">正在打开单据…</p>}>
          <FlowPage
            key={launch.mode + JSON.stringify(launch.params)}
            mode={launch.mode}
            dialogOnly
            launch={launch.params}
            onClose={() => setLaunch(null)}
          />
        </Suspense>
      )}
    </>
  );
}
