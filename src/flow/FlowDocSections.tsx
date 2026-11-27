import { quantityString, fieldLabel, fieldShort } from '../../shared/core/index';
import { planDate, type ArrivalDaily, type DeliveryDaily, type FlowDocView } from '../../shared/business/index';
import type { CatalogLists } from '../recordkit/catalog-api';
import { Facts, Section } from '../ui/index';
import { ArrivalLines, DeliveryLines } from './DocLines';
import { shipDate } from './flow-dates';
import { flowSourceFileUrl } from './flow-api';

/*
 * 到货单、送货单的详情正文：库存页、归档、从订单采购单点开的单据窗口和核对窗都是这一份。
 * 单据本身（doc）给基本信息；台账记录（record，readFlowRecord 读的）给验收入库、每行的采购单或订单进度和流水。
 * 核对窗里是还没核对的单据，没有台账记录：明细按档案（data）补采购单号、订单号。
 */

/** 详情要对照的档案（补采购单号、订单号用） */
type DetailData = Partial<CatalogLists>;
/** 单据带着的一笔库存流水：库里 stock_movements 的一行（列名是库里的） */
type MovementCells = { readonly [column: string]: string | number | null };
/** 列出来的一笔流水：流水本身，和它是哪个库存品、什么单位 */
type ListedMovement = { m: MovementCells; name?: string; unit?: string };

const signed = (deltaUnits: unknown) => {
  const n = Number(deltaUnits);
  return (n >= 0 ? '+' : '−') + quantityString(Math.abs(n));
};
const when = (date?: string | null, time?: string | null) => [date, time].filter(Boolean).join(' ');
/** 一笔流水在表里的 key：流水号，没有流水号的按位置 */
const movementKey = (m: MovementCells, index: number) => (m.id != null ? String(m.id) : 'row-' + index);

/**
 * 同一笔流水只列一次（按流水号），key 才不会重复：重复的 key 会让 React 留下残行，换一张单还挂着上一张的流水。
 * 服务端已按行只挂自己的流水（到货见 FlowService.arrivalRecords）；同一库存品几行的送货单仍可能每行都带着，这里去重。
 */
export function uniqueMovementRows<T extends { m: MovementCells }>(rows: readonly T[]) {
  const seen = new Set<string>();
  return rows.filter(({ m }, index) => {
    const key = movementKey(m, index);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 库存流水：按日期列出这张单据产生的入库、出库和撤销；没有流水不显示。 */
function MovementList({ title, rows: listed }: { title: string; rows: readonly ListedMovement[] }) {
  const rows = uniqueMovementRows(listed);
  if (!rows.length) return null;
  return (
    <Section title={title}>
      <div className="table-wrap">
        <table className="wh-linked">
          <thead>
            <tr>
              <th>日期</th>
              <th>库存品</th>
              <th className="num">数量</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ m, name, unit }, index) => (
              <tr key={movementKey(m, index)}>
                <td className="nowrap">{m.date}</td>
                <td>
                  {name}
                  {m.notes && <small>{m.notes}</small>}
                </td>
                <td className="num" title={'流水号 ' + String(m.id)}>
                  <span className={Number(m.delta_units) < 0 ? 'movement-negative' : 'movement-positive'}>
                    {signed(m.delta_units)} {unit}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

/** 经办人：有确认人写确认人，没有（还没核对）才写登记人；四种单据一样 */
export const handler = (d: Pick<FlowDocView, 'confirmedBy' | 'actorName'>) => d.confirmedBy || d.actorName;
/** 撤销、更正以后原来的日期照常显示，后面写明（docs/界面/总规矩.md“详情”） */
const undoneMark = (d: Pick<FlowDocView, 'status' | 'replacedBy'>) =>
  d.status === 'reversed' ? (d.replacedBy ? ' · 已更正' : ' · 已撤销') : '';

/**
 * 到货单：到货明细（采购单和到货进度）→ 基本信息（到货时间、送货单号、验收入库、原件）→ 入库流水。
 * 待入库的入库数写“核对时算”；过了核对这一步的（已入库、已取消、已撤销）没有入库数写“—”。
 */
export function ArrivalSections({ d, record, data }: { d: FlowDocView<'arrival'>; record?: ArrivalDaily; data: DetailData }) {
  const pending = d.status === 'draft';
  // 到货单登记时就填了到货日期：待入库的也显示那天（写明还没核对入库），撤销、更正的照常显示；取消的不算到过货
  const arrived = d.status !== 'cancelled';
  return (
    <>
      {record ? (
        <ArrivalLines lines={record.lines} confirmed={!pending} />
      ) : (
        <ArrivalLines
          lines={d.lines}
          confirmed={!pending}
          purchaseOf={(l) => data.purchases?.find((p) => p.lines.some((x) => x.id === l.purchaseLineId))}
        />
      )}
      <Section title="基本信息">
        <Facts
          items={[
            {
              label: fieldLabel('date', { record: 'arrival' }),
              value: arrived ? (
                <>
                  <span className="nowrap">{when(d.date, d.actualTime)}</span>
                  {pending && ' · 待核对入库'}
                  {undoneMark(d)}
                </>
              ) : (
                ''
              ),
            },
            { label: '供应商送货单号', value: d.reference },
            {
              label: '验收 / 入库',
              value: record ? [record.inspectionStatus, record.inventoryStatus].join(' · ') : '',
              hidden: pending || !record,
            },
            { label: '经办人', value: handler(d) },
            {
              label: '送货单原件',
              value: d.sourceId ? (
                <a target="_blank" rel="noreferrer" href={flowSourceFileUrl(d.sourceId)}>
                  查看原件
                </a>
              ) : (
                ''
              ),
              hidden: !d.sourceId,
            },
            { label: '备注', value: d.notes, wide: true, hidden: !d.notes },
          ]}
        />
      </Section>
      <MovementList
        title="入库流水"
        rows={(record?.lines || []).flatMap((l) => l.movements.map((m) => ({ m, name: l.item.name, unit: l.item.unit })))}
      />
    </>
  );
}

/** 送货单：送货明细（订单和发货进度）→ 基本信息（计划和实际发货、送达、联系人和地址）→ 出库流水。 */
export function DeliverySections({ d, record, data }: { d: FlowDocView<'delivery'>; record?: DeliveryDaily; data: DetailData }) {
  const shipped = shipDate(d);
  return (
    <>
      {record ? (
        <DeliveryLines lines={record.lines} />
      ) : (
        <DeliveryLines
          lines={d.lines}
          orderLineOf={(l) => {
            const order = data.orders?.find((o) => o.id === l.orderId);
            return { order, line: order?.lines.find((x) => x.id === l.orderLineId) };
          }}
        />
      )}
      <Section title="基本信息">
        <Facts
          items={[
            { label: fieldShort('plannedDate', { record: 'delivery' }), value: when(planDate(d), d.plannedTime) },
            { label: fieldLabel('date', { record: 'delivery' }), value: shipped ? shipped + undoneMark(d) : '还没出库' },
            { label: '送达', value: d.deliveredAt, hidden: !d.deliveredAt },
            { label: fieldLabel('siteName'), value: d.siteName, hidden: !d.siteName },
            { label: fieldLabel('contact', { record: 'delivery' }), value: [d.contact, d.phone].filter(Boolean).join(' ') },
            { label: '经办人', value: handler(d) },
            { label: '收货地址', value: d.address, wide: true },
            { label: '备注', value: d.notes, wide: true, hidden: !d.notes },
          ]}
        />
      </Section>
      <MovementList
        title="出库流水"
        rows={(record?.lines || []).flatMap((l) => l.movements.map((m) => ({ m, name: l.productName, unit: l.unit })))}
      />
    </>
  );
}
