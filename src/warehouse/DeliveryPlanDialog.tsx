import { useEffect, useMemo, useRef, useState } from 'react';
import { ManagementDialog, Loading } from '../ui/index';
import { EditorFooter, FormField, FormMessage, FormSection } from '../ui/index';
import { createFlow } from '../flow/flow-api';
import { deliveryPlan, openOrder, pendingByOrderLine, type PlanPreset } from '../../shared/business/index';
import { errorMessage, userError } from '../../shared/core/index';
import DeliveryBlockers from '../flow/DeliveryBlockers';
import { emit } from '../ui/index';
import { readCatalog } from '../recordkit/catalog-api';
import DeliveryPlanGroup, { type GroupInput } from './DeliveryPlanGroup';
import { StockOwners, Unplanned } from './DeliveryPlanNotes';
import { deliveryBody, emptyText, planLookups, planProblem, shownGroups, type PlanData } from './delivery-plan';

type Props = {
  stockIds?: number[];
  orderIds?: number[];
  /** 可发货里勾好的：给哪个客户、哪几行多少 */
  preset?: PlanPreset;
  close: () => void;
  done: (message: string) => void;
};

/** 还在读的时候按什么都没有排：没有送货单，也没有要提示的 */
const NO_DATA: PlanData = { items: [], orders: [], customers: [], pending: new Map() };

/** 打开时读一次库存品、订单、客户和待送货单（已经排在待送货单上的数量不再重复排，可用库存也已扣掉它们） */
function usePlanData() {
  const [data, setData] = useState<PlanData | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    readCatalog(['items', 'orders', 'customers', 'pendingDeliveries'])
      .then(({ items, orders, customers, pendingDeliveries }) => {
        if (live) setData({ items, orders, customers, pending: pendingByOrderLine(pendingDeliveries) });
      })
      .catch((e: unknown) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, []);
  return { data, error, setError };
}

/**
 * 安排送货只有这一个窗口：按交期先后把可用库存分到订单明细，按客户自动分成几张待送货的送货单。
 * 打开方式：选了订单（orderIds）、选了成品库存（stockIds）、可发货里勾好的几行（preset），
 * 或者什么都没选（送货页页头）——先选给哪个客户，带出这个客户在等的订单。
 * 几个客户在等同一种货时先让人选给谁；每张送货单的日期、收货信息、每行数量都能改；超过订单还没发的要写原因。
 * 安排后在送货里待送货，导出送货单时出库。排法在共用的 deliveryPlan（和助手同一份），窗口状态和检查在 delivery-plan.ts。
 */
export default function DeliveryPlanDialog({ stockIds, orderIds, preset, close, done }: Props) {
  const { data, error, setError } = usePlanData();
  const [busy, setBusy] = useState(false),
    // 什么都没选进来的：给哪个客户
    [pickedCustomer, setPickedCustomer] = useState<number | null>(null),
    [owners, setOwners] = useState<Record<number, number>>({}),
    [edits, setEdits] = useState<Record<string, string>>({}),
    [removed, setRemoved] = useState<string[]>([]),
    [inputs, setInputs] = useState<Record<number, Partial<GroupInput>>>({});
  // 重试时内容没变就沿用同一个请求编号（服务端不会重复建单）；已经建好的不再提交
  const requests = useRef<Record<number, { body: string; id: string }>>({}),
    created = useRef<Record<number, string>>({});
  const chooseCustomer = !stockIds && !orderIds && !preset;
  const plan = useMemo(
    () => deliveryPlan(data || NO_DATA, { preset, stockIds, orderIds, customerId: pickedCustomer, owners }),
    [data, preset, stockIds, orderIds, pickedCustomer, owners],
  );
  const { blockers, contested } = plan;
  const groups = shownGroups(plan, removed, edits);
  const look = planLookups(data, inputs);
  async function submit() {
    const problem = planProblem(groups, created.current, look);
    if (problem) return setError(problem);
    setBusy(true);
    setError('');
    const made: string[] = Object.entries(created.current).map(([id, n]) => look.customerName(Number(id)) + ' ' + n);
    try {
      for (const g of groups) {
        if (created.current[g.customerId]) continue;
        const body = deliveryBody(g, look.inputOf(g), look.overOf(g.lines).length > 0);
        const text = JSON.stringify(body),
          prior = requests.current[g.customerId];
        if (!prior || prior.body !== text) requests.current[g.customerId] = { body: text, id: crypto.randomUUID() };
        const saved = await createFlow('delivery', { ...body, requestId: requests.current[g.customerId].id });
        created.current[g.customerId] = saved.number || '';
        made.push(look.customerName(g.customerId) + ' ' + (saved.number || ''));
      }
      emit('erp-business-changed');
      done('已安排 ' + made.length + ' 张送货：' + made.join('；') + '。在送货里待送货，导出送货单时出库。');
    } catch (e) {
      setError((made.length ? '已安排 ' + made.join('；') + '；' : '') + userError(errorMessage(e)));
      if (made.length) emit('erp-business-changed');
    } finally {
      setBusy(false);
    }
  }
  return (
    <ManagementDialog
      title="安排送货"
      subtitle={groups.length > 1 ? '按客户分成 ' + groups.length + ' 张送货单' : undefined}
      size="lg"
      close={close}
      busy={busy}
      footer={
        <EditorFooter note="安排后在送货里待送货，导出送货单时出库。">
          <button className="secondary" disabled={busy} onClick={close}>
            取消
          </button>
          <button className="primary" disabled={busy || !groups.length} onClick={() => void submit()}>
            {busy ? '正在安排…' : '安排送货（' + groups.length + ' 张）'}
          </button>
        </EditorFooter>
      }
    >
      <FormMessage>{error}</FormMessage>
      {!data ? (
        <Loading what="库存、订单和客户" />
      ) : (
        <>
          {chooseCustomer && (
            <CustomerPicker
              customers={[...new Set(data.orders.filter(openOrder).map((o) => o.customerId))]}
              picked={pickedCustomer}
              customerName={look.customerName}
              pick={(id) => {
                setPickedCustomer(id);
                setEdits({});
                setRemoved([]);
              }}
            />
          )}
          {blockers.length > 0 && <DeliveryBlockers blockers={blockers} />}
          {contested.length > 0 && (
            <StockOwners contested={contested} owners={owners} setOwners={setOwners} customerName={look.customerName} />
          )}
          {groups.map((g, n) => (
            <DeliveryPlanGroup
              key={g.customerId}
              title={(groups.length > 1 ? '送货单 ' + (n + 1) + ' · ' : '') + look.customerName(g.customerId)}
              lines={g.lines}
              input={look.inputOf(g)}
              change={(patch) => setInputs((x) => ({ ...x, [g.customerId]: { ...x[g.customerId], ...patch } }))}
              over={look.overOf(g.lines)}
              locked={busy || !!created.current[g.customerId]}
              stockName={(id) => data.items.find((i) => i.id === id)?.name || '库存品'}
              lineInfo={look.lineInfo}
              setQuantity={(k, q) => setEdits((x) => ({ ...x, [k]: q }))}
              remove={(k) => setRemoved((r) => [...r, k])}
            />
          ))}
          {!groups.length && !(chooseCustomer && !pickedCustomer) && (
            <p className="choice-list-empty">{emptyText(blockers.length > 0, !!stockIds)}</p>
          )}
          <Unplanned
            idle={plan.idle}
            skipped={plan.skipped}
            missing={plan.missing}
            orderNumber={(id) => data.orders.find((o) => o.id === id)?.number || '订单'}
          />
        </>
      )}
    </ManagementDialog>
  );
}

/** 什么都没选进来的：先选给哪个客户（只列有订单在等的客户） */
function CustomerPicker({
  customers,
  picked,
  customerName,
  pick,
}: {
  customers: number[];
  picked: number | null;
  customerName: (id: number) => string;
  pick: (id: number | null) => void;
}) {
  return (
    <FormSection title="送给谁" hint="选了客户，按交期先后带出这个客户在等的订单和可用库存">
      <FormField label="客户" required span="full">
        <select aria-label="送给哪个客户" value={picked ?? ''} onChange={(e) => pick(Number(e.target.value) || null)}>
          <option value="">请选择有订单在等的客户</option>
          {customers.map((id) => (
            <option key={id} value={id}>
              {customerName(id)}
            </option>
          ))}
        </select>
      </FormField>
    </FormSection>
  );
}
