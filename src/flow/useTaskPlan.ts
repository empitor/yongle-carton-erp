import { useEffect, useRef, useState } from 'react';
import { flowInput, type FlowDocView, type ProductionPlanGroup } from '../../shared/business/index';
import { planProductionForOrders } from '../../shared/business/index';
import { errorMessage, today, userError } from '../../shared/core/index';
import { emit } from '../ui/index';
import { readCatalog, type CatalogLists } from '../recordkit/catalog-api';
import { readRecord, readRelated } from '../recordkit/record-api';
import { createFlow } from './flow-api';

/* 安排生产窗口（TaskPlanDialog）的读和存：读排产资料、逐行建生产任务。 */

type Group = ProductionPlanGroup;
/** 读来的排产资料：按订单算出的分组、这次不排的订单和原因、订单号、成品库存（算可用）、按产品排时能加的产品 */
type PlanSource = {
  groups: Group[];
  skipped: string[];
  orders: readonly { id: number; number: string }[];
  items: CatalogLists['finishedItems'];
  products: readonly { id: number; name: string }[];
};
/** 表里的一行：一组加上这次填的数量和计划日期 */
export type PlanRow = Group & { quantity: string; plannedDate: string };
/** 一行里人改过的：数量、计划日期 */
export type RowEdit = { quantity?: string; plannedDate?: string };

/** 读排产要的资料：没给订单是按产品排（读成品库存和产品），给了订单就和助手 production.plan 同一份算法 */
async function loadSource(ids: number[]): Promise<PlanSource> {
  if (!ids.length) {
    const { finishedItems: items, products: all } = await readCatalog(['finishedItems', 'products']);
    return { groups: [], skipped: [], orders: [], items, products: all.filter((p) => !p.archived) };
  }
  const [orders, items] = await Promise.all([
    Promise.all(ids.map((id) => readRecord('orders', id))),
    readCatalog(['finishedItems']).then((r) => r.finishedItems),
  ]);
  // 关联单据读不到的订单按没有在做的任务算（planProductionForOrders 收 null）
  const related = await Promise.all(orders.map((o) => readRelated('orders', o.id).catch(() => null)));
  const plan = planProductionForOrders(orders, related, items);
  return { groups: plan.groups, skipped: plan.skipped.map((x) => x.orderNumber + '：' + x.reason), orders, items, products: [] };
}

/** 打开时读一次排产资料；订单换了再读 */
export function usePlanSource(orderIds: number[]) {
  const orderKey = orderIds.join(',');
  const [source, setSource] = useState<PlanSource | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    loadSource(orderKey ? orderKey.split(',').map(Number) : [])
      .then((s) => live && setSource(s))
      .catch((e: unknown) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [orderKey]);
  return { source, error };
}

/**
 * 逐行建生产任务（服务端安排即下达：保存出来就是已下达的任务）。已经建好的不再提交；内容没变的沿用上次的请求号，
 * 中途失败再点不会重复建。办完通知业务数据变了，交给 done 一句提示。
 */
export function usePlanSubmit(done: (message: string) => void) {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const requests = useRef<Record<string, { body: string; id: string } | undefined>>({}),
    created = useRef<Record<string, FlowDocView | undefined>>({});
  async function createOne(r: PlanRow) {
    const body = flowInput('task', {
      date: today(),
      plannedDate: r.plannedDate,
      plannedTime: null,
      actualTime: null,
      notes: '',
      productId: r.productId,
      quantity: r.quantity,
      unit: r.unit,
      orderIds: r.orderIds,
    });
    const text = JSON.stringify(body),
      prior = requests.current[r.key],
      request = prior && prior.body === text ? prior : { body: text, id: crypto.randomUUID() };
    requests.current[r.key] = request;
    return createFlow('task', { ...body, requestId: request.id });
  }
  async function submit(planned: PlanRow[]) {
    setBusy(true);
    setError('');
    const made: string[] = [];
    try {
      for (const r of planned) {
        const task = created.current[r.key] ?? (await createOne(r));
        created.current[r.key] = task;
        made.push(task.number);
      }
      emit('erp-business-changed');
      done('已安排 ' + made.length + ' 张生产任务：' + made.join('、') + '，在排产板上待生产。');
    } catch (e) {
      if (made.length) emit('erp-business-changed');
      setError((made.length ? '已处理 ' + made.join('、') + '；' : '') + userError(errorMessage(e)));
    } finally {
      setBusy(false);
    }
  }
  return { error, busy, submit };
}
