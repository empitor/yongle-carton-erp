import { useState } from 'react';
import { ManagementDialog, RowDelete } from '../ui/index';
import { EditorFooter, FormMessage, FormSection } from '../ui/index';
import { finishedAvailable, type ProductionPlanGroup } from '../../shared/business/index';
import { FINISHED_UNIT, quantityString, today } from '../../shared/core/index';
import { usePlanSource, usePlanSubmit, type PlanRow, type RowEdit } from './useTaskPlan';

type Group = ProductionPlanGroup;

/**
 * 安排生产只有这一个窗口，两种进来的方式：
 * - 多选订单：每张订单按“下一步”算出还要排产的产品（已在做、库存够的不排），
 *   同一产品合成一张生产任务（关联这几张订单），数量 = 合计待发 − 库存可用，能改。
 * - 从产品（勾选或详情），或者什么都没选（生产任务页页头）：没有订单也能先排生产备货，
 *   每种产品一张任务，可以再加产品，数量由人填，库存可用只作参考。
 * 成品单位只有“只”。保存就是正式任务（服务端安排即下达）；数量填 0 的这次不排。
 */
export default function TaskPlanDialog({
  orderIds = [],
  products,
  close,
  done,
}: {
  orderIds?: number[];
  /** 从产品发起（勾选的产品行或产品详情） */
  products?: { id: number; name: string }[];
  close: () => void;
  done: (message: string) => void;
}) {
  const productMode = !orderIds.length;
  const { source: state, error: loadError } = usePlanSource(orderIds);
  // 按产品排的：这次排哪几种（页头进来是空的，自己加）
  const [chosen, setChosen] = useState<{ id: number; name: string }[]>(products || []),
    [edits, setEdits] = useState<Record<string, RowEdit | undefined>>({}),
    [removed, setRemoved] = useState<string[]>([]);
  const action = usePlanSubmit(done),
    busy = action.busy,
    error = action.error || loadError;
  // 按产品排：每种产品一张任务
  const groups: Group[] = !state
    ? []
    : productMode
      ? chosen.map((p) => ({
          key: 'product-' + p.id,
          productId: p.id,
          name: p.name,
          unit: FINISHED_UNIT,
          orderIds: [],
          needUnits: 0,
          availableUnits: finishedAvailable(state.items, p.id),
          suggested: '',
        }))
      : state.groups;
  const rows: PlanRow[] = groups
    .filter((g) => !removed.includes(g.key))
    .map((g) => ({
      ...g,
      quantity: edits[g.key]?.quantity ?? g.suggested,
      plannedDate: edits[g.key]?.plannedDate ?? today(),
    }));
  const planned = rows.filter((r) => Number(r.quantity) > 0),
    quantityBad = rows.some((r) => r.quantity.trim() !== '' && !(Number(r.quantity) >= 0));
  const set = (key: string, patch: RowEdit) => setEdits((e) => ({ ...e, [key]: { ...e[key], ...patch } }));
  return (
    <ManagementDialog
      title="安排生产"
      subtitle={
        state
          ? productMode
            ? '没有订单也能先排生产备货，每种产品一张任务'
            : '选了 ' + orderIds.length + ' 张订单，同一产品合成一张任务'
          : undefined
      }
      size="lg"
      close={close}
      busy={busy}
      footer={
        <EditorFooter note="生产任务不动库存；安排后就是正式任务，在排产板上待生产。">
          <button className="secondary" disabled={busy} onClick={close}>
            取消
          </button>
          <button
            className="primary"
            disabled={busy || !planned.length || quantityBad}
            onClick={() => void action.submit(planned)}
          >
            {busy ? '正在安排…' : '安排生产（' + planned.length + ' 张）'}
          </button>
        </EditorFooter>
      }
    >
      <FormMessage>{error}</FormMessage>
      {!state ? (
        !error && (
          <p className="help-text" role="status">
            正在读取订单、生产任务和库存…
          </p>
        )
      ) : (
        <>
          <FormSection
            title="要排的生产任务"
            hint={
              productMode
                ? '填这次要生产多少；库存可用只作参考。'
                : '数量 = 这几张订单还没发的合计 − 成品库存可用，可以改。'
            }
            columns={1}
          >
            {rows.length ? (
              <PlanTable
                rows={rows}
                productMode={productMode}
                number={(id) => state.orders.find((o) => o.id === id)?.number || '订单'}
                set={set}
                remove={(key) => setRemoved((x) => [...x, key])}
              />
            ) : (
              <p className="choice-list-empty">{productMode ? '还没选要排的产品，在下面加。' : '选的订单都不用再排产。'}</p>
            )}
            {productMode && (
              <select
                aria-label="加一种要生产的产品"
                value=""
                onChange={(e) => {
                  const value = e.currentTarget.value;
                  const p = state.products.find((x) => x.id === Number(value));
                  if (p) setChosen((c) => (c.some((x) => x.id === p.id) ? c : [...c, { id: p.id, name: p.name }]));
                  setRemoved((x) => x.filter((k) => k !== 'product-' + value));
                }}
              >
                <option value="">加一种要生产的产品…</option>
                {state.products
                  .filter((p) => !chosen.some((c) => c.id === p.id && !removed.includes('product-' + p.id)))
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            )}
          </FormSection>
          {state.skipped.length > 0 && (
            <FormSection title="这次不排的订单" columns={1}>
              <ul className="help-list">
                {state.skipped.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </FormSection>
          )}
        </>
      )}
    </ManagementDialog>
  );
}

/** 要排的生产任务表：产品、关联订单（按订单排时）、待发和库存可用、本次生产、计划日期、去掉 */
function PlanTable({
  rows,
  productMode,
  number,
  set,
  remove,
}: {
  rows: PlanRow[];
  productMode: boolean;
  /** 订单编号换成单号 */
  number: (id: number) => string;
  set: (key: string, patch: RowEdit) => void;
  remove: (key: string) => void;
}) {
  return (
    <div className="line-table">
      <table>
        <thead>
          <tr>
            <th>产品</th>
            {!productMode && <th>关联订单</th>}
            <th className="num">{productMode ? '库存可用' : '待发 / 库存可用'}</th>
            <th className="num">本次生产</th>
            <th>计划日期</th>
            <th aria-label="操作" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>{r.name}</td>
              {!productMode && <td className="wh-cell-text">{r.orderIds.map(number).join('、')}</td>}
              <td className="num">
                {!productMode && quantityString(r.needUnits) + ' / '}
                {quantityString(r.availableUnits) + ' ' + r.unit}
              </td>
              <td className="num">
                <div className="wh-qty">
                  <input
                    aria-label={r.name + ' 本次生产数量'}
                    aria-required="true"
                    inputMode="decimal"
                    value={r.quantity}
                    onChange={(e) => set(r.key, { quantity: e.currentTarget.value })}
                  />
                  <span>{r.unit}</span>
                </div>
              </td>
              <td>
                <input
                  type="date"
                  aria-label={r.name + ' 计划生产日期'}
                  aria-required="true"
                  value={r.plannedDate}
                  onChange={(e) => set(r.key, { plannedDate: e.currentTarget.value })}
                />
              </td>
              <td>
                <RowDelete label={'去掉 ' + r.name} onClick={() => remove(r.key)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
