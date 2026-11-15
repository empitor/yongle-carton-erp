import { quantityString } from '../../shared/core/index';
import { planDate, type ArrivalDaily, type DeliveryDaily } from '../../shared/business/index';
import { ArrivalLines, DeliveryLines } from '../flow/DocLines';
import { Facts, Hint, Section } from '../ui/index';
import { shipDate } from '../flow/flow-dates';

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
 * 服务端已按行只挂自己的流水（到货见 FlowService.arrivalRecords）；同一库存品几行的送货单仍可能每行都带着，这里兜底。
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

/** 库存流水：按日期列出这张单据产生的入库、出库和撤销。 */
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

/** 到货明细的一行里详情正文要看的：纸板、数量，和这一行的入库流水 */
type ArrivalShownLine = { item: { name: string; unit: string }; quantity: string; movements?: readonly MovementCells[] };
/**
 * 到货详情正文要看的（台账的到货记录 ArrivalDaily）：状态和明细一定有；日期、送货单号、验收入库、经办人、
 * 备注和原件（在原单内容 document 里）这些说明有就显示，没有就不显示。
 */
type ArrivalShown = Pick<ArrivalDaily, 'status'> &
  Partial<
    Pick<
      ArrivalDaily,
      'pending' | 'replacedBy' | 'actualDate' | 'date' | 'actualTime' | 'reference' | 'inspectionStatus' | 'inventoryStatus' | 'actorName'
    >
  > & {
    document?: Partial<Pick<ArrivalDaily['document'], 'notes' | 'sourceId'>>;
    lines: ArrivalShownLine[];
  };

/** 到货单详情正文：基本信息、到货明细、入库流水。退货和更正历史由面板接在后面。 */
export function ArrivalSections({ record: r }: { record: ArrivalShown }) {
  const pending = !!r.pending;
  const notes = r.document?.notes;
  const sourceId = r.document?.sourceId;
  return (
    <>
      {!!r.replacedBy && <Hint tone="warning">这张到货单已更正，以更正后的到货为准，见下方“到货记录”。</Hint>}
      <Section title="基本信息">
        <Facts
          items={[
            {
              // 撤销（或更正）以后原来那天确实到过货：日期照旧显示，后面写明已撤销 / 已更正，不变成“—”；
              // 待入库的到货单登记时就填了到货日期，也显示那天，写明还没核对入库（和核对入库窗口同一个日期）
              label: '实际到货',
              value:
                r.actualDate || ['draft', 'confirmed', 'reversed'].includes(r.status) ? (
                  <>
                    <span className="nowrap">{when(r.actualDate || r.date, r.actualTime)}</span>
                    {r.status === 'draft' && ' · 待核对入库'}
                    {r.status === 'reversed' && (r.replacedBy ? ' · 已更正' : ' · 已撤销')}
                  </>
                ) : (
                  ''
                ),
            },
            { label: '供应商送货单号', value: r.reference },
            {
              label: '验收 / 入库',
              value: [r.inspectionStatus, r.inventoryStatus].filter(Boolean).join(' · '),
              hidden: pending || !(r.inspectionStatus || r.inventoryStatus),
            },
            { label: '经办人', value: r.actorName },
            {
              label: '送货单原件',
              value: sourceId ? (
                <a target="_blank" rel="noreferrer" href={'/api/flow/sources/' + sourceId + '/file'}>
                  查看原件
                </a>
              ) : (
                ''
              ),
              hidden: !sourceId,
            },
            { label: '备注', value: notes, wide: true, hidden: !notes },
          ]}
        />
      </Section>
      {/* 只有待入库的入库数写“核对时算”；已取消、已撤销的不会再核对 */}
      <ArrivalLines lines={r.lines} confirmed={!pending} />
      <MovementList
        title="入库流水"
        rows={r.lines.flatMap((l) => (l.movements || []).map((m) => ({ m, name: l.item.name, unit: l.item.unit })))}
      />
    </>
  );
}

/** 送货单详情正文：基本信息、送货明细、出库流水。 */
export function DeliverySections({ record: r }: { record: DeliveryDaily }) {
  return (
    <>
      <Section title="基本信息">
        <Facts
          items={[
            { label: '计划送货', value: when(planDate(r), r.plannedTime) },
            { label: '实际发货', value: shipDate({ ...r, kind: 'delivery' }) || '还没出库' },
            { label: '送达', value: r.deliveredAt, hidden: !r.deliveredAt },
            { label: '联系人', value: [r.contact, r.phone].filter(Boolean).join(' ') },
            { label: '经办人', value: r.confirmedBy || r.actorName },
            { label: '收货地址', value: r.address, wide: true },
            { label: '备注', value: r.notes, wide: true, hidden: !r.notes },
          ]}
        />
      </Section>
      <DeliveryLines lines={r.lines} />
      <MovementList
        title="出库流水"
        rows={r.lines.flatMap((l) => l.movements.map((m) => ({ m, name: l.productName, unit: l.unit })))}
      />
    </>
  );
}
