import { formatDimensions } from '../shared/product-details';
import{useEffect}from'react';
import { precisionTotal } from '../shared/precision';
import { formatStockSize, type RecordEntity } from '../shared/operations';
export default function RecordDetails({ entity, row }: { entity: RecordEntity; row: any }) {
  useEffect(()=>{window.dispatchEvent(new CustomEvent('erp-ai-record-context',{detail:{module:entity==='stock_items'?(row.kind==='raw'?'raw_inventory':'finished_inventory'):entity,id:row.id,label:row.number||row.name}}));},[entity,row.id]);
  const pairs =
    entity === 'customers' || entity === 'suppliers'
      ? [
          [entity === 'suppliers' ? '供应商名称' : '客户名称', row.name],
          ['联系人', row.contact],
          ['联系方式', row.phone],
          ['地址', row.address],
          ['备注', row.notes],
        ]
      : entity === 'purchases'
        ? [
            ['采购单号', row.number],
            ['供应商', row.supplierName],
            ['关联客户订单', row.customerOrderNumber || '独立采购'],
            ['采购日期', row.orderDate],
            ['预计到货', row.expectedDate],
            ['状态', row.status],
            ['程序计算金额 / 元', row.totalAmount ?? '待定价'],
            ['备注', row.notes],
          ]
        : entity === 'stock_items'
          ? [
              ['库存品', row.name],
              ['类别', row.kind === 'raw' ? '原材料' : '成品'],
              ['实际库存', row.quantity + ' ' + row.unit],
              ['规格', row.specification || formatStockSize(row)],
              ['楞型', row.flute],
              ['材质 / 配纸', row.material],
              ['备注', row.notes],
            ]
          : entity === 'products'
            ? [
                ['产品名称', row.name],
                ['尺寸与单位', formatDimensions(row)],
                ['材质 / 配纸', row.material],
                ['类型 / 楞型', row.flute],
                ['加工要求', row.requirements],
                ['参考单价', row.priceExact ?? String(row.priceCents / 100)],
              ]
            : [
                ['订单编号', row.number],
                ['客户', row.customerName],
                ['客户采购单号', row.externalPurchaseOrder],
                ['订单日期', row.orderDate],
                ['交货日期', row.deliveryDate],
                [
                  '订单状态',
                  row.status === '已发货'
                    ? '已完成 / 已发货'
                    : row.lines?.some((l: any) => l.shippedQuantity > 0)
                      ? '部分发货'
                      : row.status,
                ],
                ['币种', row.currency || 'CNY'],
                ['金额 / 元', row.totalAmountExact ?? String(row.totalCents / 100)],
                ['税费说明', (row.taxRate || '') + ' ' + (row.taxMode || '未明确')],
                ['合同条件', row.terms],
                ['整单备注', row.notes],
              ];
  return (
    <>
      <dl data-agent-module={entity==='stock_items'?(row.kind==='raw'?'raw_inventory':'finished_inventory'):entity} data-agent-record={row.id} data-agent-label={row.number||row.name} className="record-detail-grid">
        {pairs.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v || '未填写'}</dd>
          </div>
        ))}
      </dl>
      {entity === 'suppliers' && (
        <>
          <h3>历史采购记录（{row.purchaseHistory?.length || 0}张）</h3>
          {row.purchaseHistory?.map((p: any) => (
            <p key={p.id}>
              {p.number} · {p.orderDate} · {p.status}
            </p>
          ))}
        </>
      )}
      {entity === 'purchases' && (
        <>
          <h3>采购明细</h3>
          <div className="table-wrap">
            <table className="op-detail-table">
              <thead>
                <tr>
                  {[
                    '纸板名称 / 规格',
                    '楞型 / 材质',
                    '订购数量',
                    '累计到货',
                    '单价 / 元',
                    '金额 / 元',
                    '备注',
                  ].map((t) => (
                    <th key={t}>{t}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {row.lines.map((l: any) => (
                  <tr key={l.id}>
                    <td>
                      {l.name}
                      <span className="sub">{l.specification || formatStockSize(l)}</span>
                    </td>
                    <td>
                      {l.flute || '—'} / {l.material || '—'}
                    </td>
                    <td>
                      {l.quantity} {l.unit}
                    </td>
                    <td>{l.receivedQuantity}</td>
                    <td>{l.unitPrice ?? '待定'}</td>
                    <td>{l.amount ?? '待定'}</td>
                    <td>{l.notes || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3>到货历史（{row.receipts.length}批）</h3>
          {row.receipts.map((r: any) => (
            <p key={r.id}>
              {r.reversed && <strong>已冲销 · </strong>}
              {r.reference} · {r.date} · {r.actorName} · 本批
              {r.items.map((l: any) => l.quantity).join(' / ')}（各明细单位见上表）
            </p>
          ))}
        </>
      )}
      {entity === 'orders' && (
        <div className="table-wrap record-detail-lines">
          <table>
            <thead>
              <tr>
                {[
                  '产品名称',
                  '规格型号',
                  '备注',
                  '数量',
                  '单位',
                  '单价 / 元',
                  '金额 / 元',
                  '累计已发货',
                  '待发货',
                ].map((k) => (
                  <th key={k}>{k}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {row.lines.map((l: any, i: number) => (
                <tr key={i}>
                  <td>{l.productName}</td>
                  <td>{l.specification || '未填写'}</td>
                  <td>
                    {l.notes || '—'}
                    {(l.taxRate || l.taxMode || l.deliveryDate) && (
                      <span className="sub">
                        {l.taxRate} {l.taxMode} {l.deliveryDate}
                      </span>
                    )}
                  </td>
                  <td>{l.quantity}</td>
                  <td>{l.unit || '未确认'}</td>
                  <td>{l.unitPriceExact ?? String(l.unitPriceCents / 100)}</td>
                  <td>{precisionTotal([l]).exact}</td>
                  <td>
                    {l.shippedQuantity === null ? '历史数量待核对' : (l.shippedQuantity ?? 0)}{' '}
                    {l.unit || ''}
                  </td>
                  <td>
                    {l.remainingQuantity === null
                      ? '历史数量待核对'
                      : (l.remainingQuantity ?? l.quantity)}{' '}
                    {l.unit || ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
