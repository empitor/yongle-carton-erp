import { useState } from 'react';
import { deliveryCandidates, selectedStockUnits } from '../../shared/warehouse-delivery';
import { formatStockSize, quantityString } from '../../shared/operations';

export default function DeliveryStockPicker({ value, data, change }: { value: any; data: any; change: (patch: any) => void }) {
  const [search, setSearch] = useState(''), [unit, setUnit] = useState('');
  const all = data.items.filter((i: any) => i.kind === 'finished' && !i.archived);
  const rows = all.filter((i: any) => (!unit || i.unit === unit) && [i.name, i.specification, formatStockSize(i), data.products.find((p: any) => p.id === i.productId)?.customerProductCode].join(' ').toLowerCase().includes(search.toLowerCase()));
  const lines = value.lines.filter((l: any) => l.stockId != null);
  const candidates = (item: any) => deliveryCandidates(item, value.customerId, data.orders, value.allowOverdelivery);
  const seed = (item: any, current: any[]) => {
    const choices = candidates(item).filter(c => !current.some(l => l.orderLineId === c.orderLineId));
    return { stockId: item.id, orderId: choices.length === 1 ? choices[0].orderId : null, orderLineId: choices.length === 1 ? choices[0].orderLineId : null, quantity: '', notes: '' };
  };
  const update = (index: number, patch: any) => change({ lines: lines.map((l: any, i: number) => i === index ? { ...l, ...patch } : l) });
  const eligible = rows.filter((i: any) => value.customerId && i.balanceUnits > 0 && candidates(i).length > 0);
  const checked = eligible.length > 0 && eligible.every((i: any) => lines.some((l: any) => l.stockId === i.id));
  return <section className="delivery-stock-picker">
    <div className="delivery-stock-heading"><div><h3>选择成品与本次送货数量</h3><small>已选 {new Set(lines.map((l: any) => l.stockId)).size} 种成品 · 不同客户的订单不会混用</small></div>
      <div className="delivery-stock-filters"><input aria-label="搜索送货成品" placeholder="名称、型号、规格" value={search} onChange={e => setSearch(e.target.value)} />
        <select aria-label="送货成品单位筛选" value={unit} onChange={e => setUnit(e.target.value)}><option value="">全部单位</option>{[...new Set<string>(all.map((i: any) => i.unit))].map(u => <option key={u}>{u}</option>)}</select></div></div>
    {!value.customerId && <p className="flow-warning">请先选择客户，再勾选成品。</p>}
    <div className="table-wrap"><table className="flow-table delivery-stock-table"><thead><tr>
      <th><input type="checkbox" aria-label="全选当前筛选的可送货成品" checked={checked} disabled={!eligible.length} onChange={e => {
        if (!e.target.checked) change({ lines: lines.filter((l: any) => !eligible.some((i: any) => i.id === l.stockId)) });
        else { const next = [...lines]; for (const item of eligible) if (!next.some(l => l.stockId === item.id)) next.push(seed(item, next)); change({ lines: next }); }
      }} /></th><th>产品名称 / 型号</th><th>规格</th><th>可用库存</th><th>对应订单与本次送货</th></tr></thead><tbody>
      {rows.map((item: any) => {
        const selected = lines.some((l: any) => l.stockId === item.id), choices = candidates(item), used = selectedStockUnits(lines, item.id);
        return <tr key={item.id}><td><input type="checkbox" aria-label={'选择送货成品 ' + item.name} checked={selected} disabled={!value.customerId || (!selected && (item.balanceUnits <= 0 || !choices.length))} onChange={e => change({ lines: e.target.checked ? [...lines, seed(item, lines)] : lines.filter((l: any) => l.stockId !== item.id) })} /></td>
          <td><strong>{item.name}</strong><small>{data.products.find((p: any) => p.id === item.productId)?.customerProductCode || '库存品 #' + item.id}</small></td><td>{item.specification || formatStockSize(item) || '待补充'}</td><td><strong>{item.quantity} {item.unit}</strong>{selected && <small className={used !== null && used > item.balanceUnits ? 'form-error' : ''}>本次 {used === null ? '待填写' : quantityString(used)} {item.unit}{used !== null && used > item.balanceUnits ? ' · 超出库存' : ''}</small>}</td>
          <td>{!selected ? <small>{!choices.length ? '该客户无可关联订单；现有业务不支持无订单发货' : choices.length + ' 条待交付明细可选'}</small> : lines.map((line: any, index: number) => line.stockId !== item.id ? null : <div className="delivery-allocation" key={index}>
            <select aria-label={item.name + ' 对应订单明细 ' + (index + 1)} value={line.orderLineId || ''} onChange={e => { const c = choices.find(c => c.orderLineId === Number(e.target.value)); update(index, { orderId: c?.orderId || null, orderLineId: c?.orderLineId || null }); }}>
              <option value="">请选择该客户的订单明细</option>{choices.filter(c => c.orderLineId === line.orderLineId || !lines.some((l: any) => l.orderLineId === c.orderLineId)).map(c => <option key={c.orderLineId} value={c.orderLineId}>{c.orderNumber} · {c.productName} · 待交付 {c.remainingQuantity ?? c.quantity} {c.unit}</option>)}</select>
            <div className="delivery-quantity"><input aria-label={item.name + ' 本次送货数量 ' + (index + 1)} inputMode="decimal" placeholder="送货数量" value={line.quantity} onChange={e => update(index, { quantity: e.target.value })} /><span>{item.unit}</span><button type="button" className="danger-text" onClick={() => change({ lines: lines.filter((_: any, i: number) => i !== index) })}>移除</button></div>
            <input aria-label={item.name + ' 明细备注 ' + (index + 1)} placeholder="明细备注（可选）" value={line.notes} onChange={e => update(index, { notes: e.target.value })} />
          </div>)}{selected && choices.some(c => !lines.some((l: any) => l.orderLineId === c.orderLineId)) && <button type="button" onClick={() => change({ lines: [...lines, seed(item, lines)] })}>分配到另一订单</button>}</td></tr>;
      })}{!rows.length && <tr><td colSpan={5}>没有符合条件的成品库存。</td></tr>}
    </tbody></table></div>
    <p className="sub">同一张送货单只对应一个客户。缺少该客户订单或单位/规格不匹配时不能发货；请先完善客户订单。库存仅在最后确认发货时扣减。</p>
    <details className="delivery-over-limit"><summary>超订单数量发货（特殊情况）</summary><label><input type="checkbox" checked={value.allowOverdelivery} onChange={e => change({ allowOverdelivery: e.target.checked })} />申请超订单发货，需有效超级管理员及明确原因，仍禁止超库存</label>{value.allowOverdelivery && <textarea aria-label="超订单发货原因" value={value.overdeliveryReason} onChange={e => change({ overdeliveryReason: e.target.value })} />}</details>
  </section>;
}
