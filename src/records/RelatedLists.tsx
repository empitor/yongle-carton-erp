import type { ReactNode } from 'react';
import { flowStatusText, purchaseState, recordNames, specLine, type FlowKind } from '../../shared/business/index';
import { StatusChip } from '../ui/index';
import { businessStatusTone } from '../recordkit/record-meta';
import type { RelatedData } from './useRelatedData';

/**
 * 订单、采购单详情最后的关联单据：生产任务、完工、送货、采购单（订单的），到货单、关联订单（采购单的），对应的库存品。
 * 都能点开；单据在当前页面的单据窗口里打开（open）。
 */

export type OrderRelated = Extract<RelatedData, { marks: unknown }>;
export type PurchaseRelated = Extract<RelatedData, { arrivals: unknown }>;

/** 能在单据窗口打开的一张：单据视图或台账里的到货单 */
export type LinkDoc = {
  id: number | string;
  flowId?: number;
  number?: string;
  reference?: string;
  plannedDate?: string | null;
  date?: string;
};
export type OpenDoc = (mode: FlowKind, doc: LinkDoc) => void;

/**
 * 关联单据的状态叫法走全站同一个函数（flowStatusText）。到货记录没带单据类型，按所在分组补上；
 * 它的 completed 是“到齐没有”（是非），和生产任务的完工数量不是一回事，只交状态那几项。
 */
const arrivalStatus = (d: PurchaseRelated['arrivals'][number]) =>
  flowStatusText({ kind: 'arrival', status: d.status, pending: d.pending, cancelled: d.cancelled, effective: d.effective, replacedBy: d.replacedBy });

/** 一组单据：标题和张数，每张写单号、状态、日期（生产任务另写完工进度） */
function DocGroup<D extends LinkDoc>(o: {
  title: string;
  docs: readonly D[];
  mode: FlowKind;
  open: OpenDoc;
  statusOf: (d: D) => string;
  extra?: (d: D) => ReactNode;
}) {
  if (!o.docs.length) return null;
  return (
    <div className="rb-group">
      <h4>
        {o.title} <span>{o.docs.length}</span>
      </h4>
      <ul className="rb-docs">
        {o.docs.map((d) => {
          const label = o.statusOf(d);
          return (
            <li key={d.id}>
              <button type="button" className="link" onClick={() => o.open(o.mode, d)}>
                {d.number || d.reference || '到货登记'}
              </button>
              <StatusChip tone={businessStatusTone(label)}>{label}</StatusChip>
              {o.extra?.(d)}
              <small>{d.plannedDate || d.date}</small>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** 一组链接（采购单、订单）：标题和条数 */
function LinkGroup({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  if (!count) return null;
  return (
    <div className="rb-group">
      <h4>
        {title} <span>{count}</span>
      </h4>
      <ul className="rb-docs">{children}</ul>
    </div>
  );
}

/** 订单的关联单据有没有 */
export const orderHasDocs = (d: OrderRelated) =>
  d.tasks.length + d.productions.length + d.deliveries.length + d.purchases.length > 0;
/** 采购单的关联单据有没有 */
export const purchaseHasDocs = (d: PurchaseRelated) => d.arrivals.length + d.orders.length > 0;

/** 订单的关联单据：生产任务、完工、送货、采购单 */
export function OrderDocs({ data, open }: { data: OrderRelated; open: OpenDoc }) {
  return (
    <>
      <DocGroup
        title={recordNames.task}
        docs={data.tasks}
        mode="task"
        open={open}
        statusOf={flowStatusText}
        extra={(t) => (
          <span className="rb-doc-extra">
            完工 {t.completed} / {t.quantity} {t.unit}
          </span>
        )}
      />
      <DocGroup title={recordNames.production} docs={data.productions} mode="production" open={open} statusOf={flowStatusText} />
      <DocGroup title={recordNames.delivery} docs={data.deliveries} mode="delivery" open={open} statusOf={flowStatusText} />
      <LinkGroup title={recordNames.purchases} count={data.purchases.length}>
        {data.purchases.map((p) => {
          const state = purchaseState(p);
          return (
            <li key={p.id}>
              <a href={'#purchases?record=' + p.id}>{p.number}</a>
              <StatusChip tone={businessStatusTone(state)}>{state}</StatusChip>
              <span className="rb-doc-extra">{p.supplierName}</span>
              <small>{p.orderDate}</small>
            </li>
          );
        })}
      </LinkGroup>
    </>
  );
}

/** 采购单的关联单据：到货单、给哪几张订单订的料 */
export function PurchaseDocs({ data, open }: { data: PurchaseRelated; open: OpenDoc }) {
  return (
    <>
      <DocGroup title="到货单" docs={data.arrivals} mode="arrival" open={open} statusOf={arrivalStatus} />
      <LinkGroup title={recordNames.orders} count={data.orders.length}>
        {data.orders.map((o) => (
          <li key={o.id}>
            <a href={'#orders?order=' + o.id}>{o.number}</a>
            <span className="rb-doc-extra">{o.customerName}</span>
            <small>{o.deliveryDate ? '交期 ' + o.deliveryDate : ''}</small>
          </li>
        ))}
      </LinkGroup>
    </>
  );
}

/** 对应的库存品（订单是成品，采购单是原材料）：同一种货几张单都在用，这里是总数 */
export function StockList({ stocks, title }: { stocks: OrderRelated['stocks']; title: string }) {
  if (!stocks.length) return null;
  return (
    <details className="rb-stocks">
      <summary>
        {title} · {stocks.length}
      </summary>
      <p className="help-text">同一种货可能几张订单都在用；这里是总数，不代表这张单独占。</p>
      <ul className="rb-docs">
        {stocks.map((s) => (
          <li key={s.id}>
            <a href={'#warehouse?kind=' + s.kind + '&q=' + encodeURIComponent(s.name)}>{s.name}</a>
            <span className="rb-doc-extra">{specLine(s)}</span>
            <small>
              {s.quantity} {s.unit}
            </small>
          </li>
        ))}
      </ul>
    </details>
  );
}
