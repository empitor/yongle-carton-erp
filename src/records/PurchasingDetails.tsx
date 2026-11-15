import type { ReactNode } from 'react';
import StockBatches from '../operations/StockBatches';
import ContactSection from '../recordkit/ContactSection';
import { purchaseState, sizeText, type PurchaseView, type StockItemView, type SupplierView } from '../../shared/business/index';
import RelatedBusiness from './RelatedBusiness';
import { Facts, Hint, Section, StatusChip, useLoad } from '../ui/index';
import { movementType } from '../warehouse/MovementDetail';
import { quantityString } from '../../shared/core/index';
import { businessStatusTone, useAgentRecord } from '../recordkit/record-meta';
import { loadMovements } from './list-api';
import { PurchaseDetails, type PurchaseReceipt } from './PurchaseDetails';
import type { Related } from './useRelatedData';

/**
 * 采购单、供应商、库存品的详情正文，按 docs/界面规范.md 排版。采购单正文在 PurchaseDetails.tsx。
 * 面板头部（类型、编号、状态、操作）由 records/RecordPanel 负责，正文从文件末尾的 purchasingDetails 接入。
 */

/** 库存品详情里“最近流水”读几笔 */
const RECENT_MOVEMENTS = 5;

function SupplierDetails({ row }: { row: SupplierView }) {
  const history = row.purchaseHistory;
  const agent = useAgentRecord('suppliers', row);
  return (
    <div className="pur-details" {...agent}>
      <ContactSection row={row} />
      <Section
        title={'采购单 · ' + history.length}
        extra={
          history.length > 0 ? (
            <a className="pur-more-link" href={'#purchases?q=' + encodeURIComponent(row.name) + '&scope=all'}>
              全部采购单
            </a>
          ) : undefined
        }
      >
        {history.length ? (
          <ul className="rb-docs">
            {history.map((p) => (
              <li key={p.id}>
                <a href={'#purchases?record=' + p.id}>{p.number}</a>
                <StatusChip tone={businessStatusTone(purchaseState(p))}>{purchaseState(p)}</StatusChip>
                <small>{p.orderDate}</small>
              </li>
            ))}
          </ul>
        ) : (
          <p className="pur-empty">还没有采购单。</p>
        )}
      </Section>
    </div>
  );
}

/** 库存品详情里的“最近流水”：最近 5 笔，完整的到流水页看。 */
function RecentMovements({ row }: { row: StockItemView }) {
  const loaded = useLoad([row.id, row.version, row.quantity].join('|'), () =>
    loadMovements({ kind: '', action: '', start: '', end: '', search: '', itemId: row.id, page: 1, pageSize: RECENT_MOVEMENTS }),
  );
  // 库存品变了（换了一个、或刚出入库）：重读时先说“正在读取”，不显示上一份
  const shown = loaded.loading || loaded.error ? null : loaded.data,
    rows = shown ? shown.rows : null,
    total = shown ? shown.filteredRecords : 0;
  return (
    <Section
      title={'最近流水' + (rows ? ' · ' + total : '')}
      extra={
        total > 0 ? (
          <a className="pur-more-link" href={'#warehouse?flow=1&kind=' + row.kind + '&item=' + row.id}>
            查看全部
          </a>
        ) : undefined
      }
    >
      {loaded.error && !loaded.loading ? (
        <p className="form-error" role="alert">
          {loaded.error}
        </p>
      ) : !rows ? (
        <p className="pur-empty" role="status">
          正在读取…
        </p>
      ) : !rows.length ? (
        <p className="pur-empty">还没有出入库记录。</p>
      ) : (
        <ul className="rb-docs pur-movements">
          {rows.map((m) => (
            <li key={m.id}>
              <span className="pur-movement-type">{movementType(m) || '变动'}</span>
              <strong className={m.direction === '-' ? 'pur-out' : 'pur-in'}>
                {m.direction}
                {m.delta} {m.unit}
              </strong>
              <span className="rb-doc-extra">
                余 {m.after} {m.unit}
              </span>
              <small>{m.date}</small>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function StockItemDetails({ row }: { row: StockItemView }) {
  const reserved = row.reservedUnits > 0,
    onOrder = row.onOrderUnits > 0;
  const agent = useAgentRecord('stock_items', row);
  return (
    <div className="pur-details" {...agent}>
      {row.balanceUnits === 0 && <Hint tone="info">当前零库存。</Hint>}
      <Section title="库存">
        <Facts
          items={[
            { label: '实际库存', value: row.quantity + ' ' + row.unit },
            {
              label: '可用',
              value: quantityString(Math.max(0, row.availableUnits)) + ' ' + row.unit,
              hidden: !reserved,
            },
            { label: '已安排未出库', value: row.reserved + ' ' + row.unit, hidden: !reserved },
            { label: '在途采购', value: row.onOrder + ' ' + row.unit, hidden: !onOrder || row.kind !== 'raw' },
          ]}
        />
      </Section>
      {row.kind === 'finished' && <StockBatches key={row.id} row={row} />}
      <Section title="规格">
        <Facts
          items={[
            { label: '尺寸', value: sizeText(row) },
            { label: '规格说明', value: row.specification },
            { label: '材质 / 配纸', value: row.material },
            { label: '楞型', value: row.flute },
            { label: '备注', value: row.notes, wide: true },
          ]}
        />
      </Section>
      <RecentMovements row={row} />
    </div>
  );
}

/** 采购区管的三类记录，各自的行 */
type PurchasingRows = { purchases: PurchaseView; suppliers: SupplierView; stock_items: StockItemView };
type DetailOptions = { correctReceipt?: (receipt: PurchaseReceipt) => void; related?: Related };
const details: { [E in keyof PurchasingRows]: (row: PurchasingRows[E], options: DetailOptions) => ReactNode } = {
  // 采购单外面套上 RelatedBusiness（下一步一句话和关联单据）
  purchases: (row, options) => (
    <RelatedBusiness entity="purchases" row={row} related={options.related}>
      <PurchaseDetails row={row} correctReceipt={options.correctReceipt} />
    </RelatedBusiness>
  ),
  suppliers: (row) => <SupplierDetails row={row} />,
  stock_items: (row) => <StockItemDetails row={row} />,
};

/** 接入点：RecordPanel 遇到采购单、供应商、库存品时用它代替 RecordDetails */
export const purchasingDetails = <E extends keyof PurchasingRows>(
  entity: E,
  row: PurchasingRows[E],
  options: DetailOptions = {},
) => details[entity](row, options);
