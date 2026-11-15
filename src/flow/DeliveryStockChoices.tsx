import { deliveryBlockers } from '../../shared/business/index';
import { FormGroup } from '../ui/index';
import { stockText, type Candidate, type DeliveryFormData, type DeliveryPick, type StockItem } from './delivery-stock';

/** 送货单“送哪些货”上半：勾选这个客户能送的成品（多于一种时可全选），勾上就在下面加一行明细。 */
export function DeliveryStockChoices({
  pick,
  shown,
  eligible,
  picked,
  emptyText,
  describe,
}: {
  pick: DeliveryPick;
  /** 列出来的：已选的和能送的 */
  shown: StockItem[];
  /** 能送的（有库存、这个客户有订单在等） */
  eligible: StockItem[];
  /** 已选了几种（搜索筛掉的也算） */
  picked: number;
  emptyText: string;
  describe: (item: StockItem) => string;
}) {
  const { lines, candidates, seed, change } = pick;
  const isSelected = (item: StockItem) => lines.some((l) => l.stockId === item.id);
  const checked = eligible.length > 0 && eligible.every(isSelected);
  const toggleAll = (on: boolean) => {
    if (!on) return change({ lines: lines.filter((l) => !eligible.some((i) => i.id === l.stockId)) });
    const next = [...lines];
    for (const item of eligible) if (!next.some((l) => l.stockId === item.id)) next.push(seed(item, next));
    change({ lines: next });
  };
  return (
    <FormGroup label={'可送的成品 · 已选 ' + picked + ' 种'}>
      {shown.length ? (
        <div className="choice-list wh-picker-list">
          {eligible.length > 1 && (
            <label className="wh-picker-all">
              <input
                type="checkbox"
                aria-label="全选当前筛选的可发货成品"
                checked={checked}
                onChange={(e) => toggleAll(e.currentTarget.checked)}
              />
              <span>全选</span>
            </label>
          )}
          {shown.map((item) => {
            const selected = isSelected(item),
              choices = candidates(item);
            return (
              <label key={item.id}>
                <input
                  type="checkbox"
                  aria-label={'选择送货成品 ' + item.name}
                  checked={selected}
                  disabled={!selected && (item.balanceUnits <= 0 || !choices.length)}
                  onChange={(e) =>
                    change({
                      lines: e.currentTarget.checked
                        ? [...lines, seed(item, lines)]
                        : lines.filter((l) => l.stockId !== item.id),
                    })
                  }
                />
                <span className="wh-picker-name">
                  {item.name}
                  <em>{describe(item)}</em>
                </span>
                <small>
                  {stockText(item)} · {choices.length} 条订单可送
                </small>
              </label>
            );
          })}
        </div>
      ) : (
        <p className="choice-list-empty">{emptyText}</p>
      )}
    </FormGroup>
  );
}

/** 送货单“送哪些货”最后：现在不能送的成品，各说一句为什么 */
export function BlockedStock({
  blocked,
  candidates,
  orders,
  customerId,
}: {
  blocked: StockItem[];
  candidates: (item: StockItem) => Candidate[];
  orders: DeliveryFormData['orders'];
  customerId: number;
}) {
  return (
    <details className="line-card-more wh-picker-blocked">
      <summary>另有 {blocked.length} 种成品现在不能送</summary>
      <ul>
        {blocked.map((item) => {
          // 订单在等、但规格对不上或订单还待确认的，原因在上面的黄框里说，这里不说成“没有订单”
          const has = candidates(item).length > 0,
            blockers = has ? [] : deliveryBlockers(item, orders, customerId);
          return (
            <li key={item.id}>
              <span>{item.name}</span>
              <small>
                {has
                  ? '库存 ' + item.quantity + ' ' + item.unit + '，没有可送的数量'
                  : !blockers.length
                    ? '这个客户没有对应的待交付订单'
                    : blockers.some((b) => b.kind === 'spec')
                      ? '有订单在等，但现在对不上，原因见上面'
                      : '有订单在等，原因见上面'}
              </small>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
