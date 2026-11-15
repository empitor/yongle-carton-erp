import type { ReactNode } from 'react';
import { specLine } from '../../shared/business/index';
import { DetailPanel } from '../ui/index';
import { ActionBar, Hint, StatusChip } from '../ui/index';
import { purchasingDetails } from './PurchasingDetails';
import { orderDisplayStatus } from '../../shared/core/index';
import { type RecordEntity } from '../../shared/business/index';
import { productIncomplete } from '../../shared/business/index';
import OrderDetail, { orderAmount } from './OrderDetail';
import { CustomerDetail, ProductDetail, productSize } from './PartyProductDetails';
import { businessStatusTone } from '../recordkit/record-meta';
import { purchaseState } from '../../shared/business/index';
import { useRecordActions, type RecordActionProps } from './useRecordActions';
import type { Related } from './useRelatedData';
import { recordLabel, type RecordRowOf } from './record-rows';
import type { StockItemView } from '../../shared/business/index';

const join = (parts: unknown[]) => parts.filter(Boolean).join(' · ') || undefined;

/**
 * 成品库存的规格说明是“尺寸 / 材质 / 楞型 / 加工要求”拼成的（shared/core/domain.ts 的 specification），
 * 材质、楞型另外再写时会重复。这里判断某个值是不是已经是规格说明里的一段；
 * specWithoutMaterial 去掉规格说明里和材质、楞型一样的段，给有单独“材质 / 楞型”一栏的列表用。
 */
const specParts = (row: { specification?: string | null }) =>
  String(row.specification ?? '')
    .split(' / ')
    .map((p) => p.trim())
    .filter(Boolean);
const inSpec = (row: { specification?: string | null }, value: unknown) => {
  const text = String(value ?? '').trim();
  return !!text && specParts(row).includes(text);
};
export function specWithoutMaterial(row: {
  specification?: string | null;
  material?: string | null;
  flute?: string | null;
}) {
  const drop = [row.material, row.flute].map((v) => String(v ?? '').trim()).filter(Boolean);
  return specParts(row)
    .filter((p) => !drop.includes(p))
    .join(' / ');
}

/** 库存品的那一行：规格说明里已经写了材质、楞型的不再接一遍；“现存 1050 只”整段不断行，单位不单独掉到下一行 */
function stockSubtitle(row: StockItemView): ReactNode {
  const spec = specLine({
      ...row,
      material: inSpec(row, row.material) ? null : row.material,
      flute: inSpec(row, row.flute) ? null : row.flute,
    }),
    stock = ['现存', row.quantity, row.unit].filter((v) => v != null && v !== '').join(' ');
  return (
    <>
      {spec && spec + ' · '}
      <span className="nowrap">{stock}</span>
    </>
  );
}

/** 每种记录在详情头部怎么写：类型（库存品分原材料、成品）、编号下面那一行上下文、状态文字（没有就是空） */
type Header<R> = { kicker: (row: R) => string; subtitle: (row: R) => ReactNode; status: (row: R) => string };
// 进度在正文里只出现一次，这里不再画进度链
const headers: { [E in RecordEntity]: Header<RecordRowOf[E]> } = {
  orders: {
    kicker: () => '订单',
    subtitle: (row) => join([row.customerName, '交期 ' + row.deliveryDate, '¥' + orderAmount(row)]),
    status: (row) => orderDisplayStatus(row),
  },
  customers: { kicker: () => '客户', subtitle: (row) => join([row.contact, row.phone]), status: () => '' },
  suppliers: { kicker: () => '供应商', subtitle: (row) => join([row.contact, row.phone]), status: () => '' },
  products: {
    kicker: () => '产品',
    subtitle: (row) => join([productSize(row), row.material, row.flute]),
    status: (row) => (productIncomplete(row) ? '资料不全' : ''),
  },
  purchases: {
    kicker: () => '采购单',
    subtitle: (row) => join([row.supplierName, row.expectedDate && '预计到货 ' + row.expectedDate]),
    status: (row) => purchaseState(row),
  },
  stock_items: { kicker: (row) => (row.kind === 'raw' ? '原材料' : '成品'), subtitle: stockSubtitle, status: () => '' },
};

function status(text: string, archived: boolean) {
  if (text)
    return (
      <StatusChip tone={text === '资料不全' ? 'warning' : businessStatusTone(text)}>
        {archived ? '已归档 · ' : ''}
        {text}
      </StatusChip>
    );
  if (!archived) return undefined;
  return <StatusChip tone="warning">已归档</StatusChip>;
}

type BodyOptions = { related: Related; correctReceipt?: (receipt: { flowId: number }) => void };
/** 详情正文：采购单、供应商、库存品的由采购区提供 */
const bodies: { [E in RecordEntity]: (row: RecordRowOf[E], o: BodyOptions) => ReactNode } = {
  orders: (row, o) => <OrderDetail row={row} related={o.related} />,
  customers: (row) => <CustomerDetail row={row} />,
  products: (row) => <ProductDetail row={row} />,
  purchases: (row, o) => purchasingDetails('purchases', row, o),
  suppliers: (row, o) => purchasingDetails('suppliers', row, o),
  stock_items: (row, o) => purchasingDetails('stock_items', row, o),
};

/**
 * 业务档案和单据的右侧详情面板：类型、编号、状态、一行上下文；
 * 头部主按钮是当前的下一步（订单按状态、采购单按订货和到货、档案是拿它开单），次要“编辑”，
 * 其余进“更多”，没有权限的直接不显示。正文的“下一步”只写一句为什么。
 */
export default function RecordPanel<E extends RecordEntity>({
  entity,
  row,
  archived,
  canEdit,
  superMode,
  localAdmin,
  busy,
  onEdit,
  onLifecycle,
  onHistory,
  onDelete,
  onMove,
  correctReceipt,
  close,
  previous,
  next,
}: RecordActionProps<E> & {
  correctReceipt?: (receipt: { flowId: number }) => void;
  close: () => void;
  previous: () => void;
  next: () => void;
}) {
  const title = recordLabel(row),
    header = headers[entity];
  const actions = useRecordActions({
    entity,
    row,
    archived,
    canEdit,
    superMode,
    localAdmin,
    busy,
    onEdit,
    onLifecycle,
    onHistory,
    onDelete,
    onMove,
  });
  return (
    <DetailPanel
      kicker={header.kicker(row)}
      title={title}
      subtitle={header.subtitle(row)}
      status={status(header.status(row), archived)}
      actions={<ActionBar primary={actions.primary} secondary={actions.secondary} more={actions.more} />}
      close={close}
      previous={previous}
      next={next}
    >
      {actions.related.error && !['orders', 'purchases'].includes(entity) && (
        <Hint tone="danger" role="alert">
          {actions.related.error}
        </Hint>
      )}
      {bodies[entity](row, { correctReceipt, related: actions.related })}
      {actions.dialogs}
    </DetailPanel>
  );
}
