import BusinessExport from './BusinessExport';
import RelatedBusiness from './RelatedBusiness';
import { formatDimensions } from '../shared/product-details';
import { useEffect } from 'react';
import { formatStockSize, type RecordEntity } from '../shared/operations';
import { ProgressSummary, PurchaseLines, ReceiptHistory, SalesLines } from './FulfillmentDetails';
export default function RecordDetails({
  entity,
  row,
  correctReceipt,
}: {
  entity: RecordEntity;
  row: any;
  correctReceipt?: (receipt: any) => void;
}) {
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent('erp-ai-record-context', {
        detail: {
          module:
            entity === 'stock_items'
              ? row.kind === 'raw'
                ? 'raw_inventory'
                : 'finished_inventory'
              : entity,
          id: row.id,
          label: row.number || row.name,
        },
      }),
    );
  }, [entity, row.id]);
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
            ['业务状态', row.businessStatus],
            ['到货进度', row.arrivalProgress],
            ['程序计算金额 / 元', row.totalAmount ?? '待定价'],
            ['有效到货金额 / 元', row.receivedAmount ?? '待定价'],
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
                ['客户产品编码 / 料号', row.customerProductCode],
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
                ['订单状态', row.status],
                ['发货进度', row.shippingProgress],
                ['币种', row.currency || 'CNY'],
                ['金额 / 元', row.totalAmountExact ?? String(row.totalCents / 100)],
                ['税费说明', (row.taxRate || '') + ' ' + (row.taxMode || '未明确')],
                ['合同条件', row.terms],
                ['整单备注', row.notes],
              ];
  return (
    <>
      <dl
        data-agent-module={
          entity === 'stock_items'
            ? row.kind === 'raw'
              ? 'raw_inventory'
              : 'finished_inventory'
            : entity
        }
        data-agent-record={row.id}
        data-agent-label={row.number || row.name}
        className="record-detail-grid"
      >
        {pairs.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v || '未填写'}</dd>
          </div>
        ))}
      </dl>
      {entity === 'customers' && (
        <div className="related-next-actions">
          <a className="action-link" href={'#orders?customerId=' + row.id + '&range=all'}>
            查看客户全部订单
          </a>
        </div>
      )}
      {entity === 'suppliers' && (
        <>
          <h3>历史采购记录（{row.purchaseHistory?.length || 0}张）</h3>
          {row.purchaseHistory?.map((p: any) => (
            <a className="related-link" href={'#purchases?record=' + p.id} key={p.id}>
              {p.number} · {p.orderDate} · {p.businessStatus} · {p.arrivalProgress}
            </a>
          ))}
        </>
      )}
      {entity === 'purchases' && (
        <>
          <BusinessExport
            kind="purchase"
            id={row.id}
            version={row.version}
            status={row.businessStatus}
          />
          <h3>采购明细</h3>
          <ProgressSummary row={row} purchase />
          <PurchaseLines row={row} correct={correctReceipt} />
          <h3>到货历史（{row.receipts.length}条，含原始与更正记录）</h3>
          <ReceiptHistory row={row} correct={correctReceipt} />
        </>
      )}
      {entity === 'orders' && <SalesLines row={row} />}
      {(entity === 'orders' || entity === 'purchases') && (
        <RelatedBusiness entity={entity} row={row} />
      )}
    </>
  );
}
