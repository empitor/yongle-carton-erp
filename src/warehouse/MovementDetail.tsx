import { flowNames, type MovementView } from '../../shared/business/index';
import { DetailPanel, beijingTime, useLoad, Loading } from '../ui/index';
import { ActionBar, Facts, Hint, Section, StatusChip, type Tone } from '../ui/index';
import { movementTypeLabel, movementTypeOf } from '../../shared/business/index';
import { flowDocHref, isFlowKind, pageHref, quantityString } from '../../shared/core/index';
import { readMovementRevisions } from './stock-api';

/** 算流水类型要看的几项（流水行、或只带方向的汇总行） */
type TypedMovement = Parameters<typeof movementTypeOf>[0];
/** 流水关联的一张单据：链接、单号、是哪种单据 */
type MovementLink = { href: string; label: string; kind: string };

/** 流水的业务类型：全站同一个（shared/business/movement-filters.ts 的 movementTypeLabel），采购退货、系统维护也认得出 */
export const movementType = (m: TypedMovement) => movementTypeLabel(m);

const flowKindName: Record<string, string> = flowNames;

/** 类型标签的颜色：流水列表和详情同一个——撤销红色，出库灰色，入库绿色。 */
export const movementTone = (m: TypedMovement): Tone =>
  movementTypeOf(m) === 'reversal' ? 'danger' : m.direction === '-' ? 'neutral' : 'success';

/** 修订记录里的数量带正负号（千分整数），和详情上面的“数量 -1000 只”“+300 张”对得上。 */
export const signedQuantity = (units: number) => (units < 0 ? '-' : units > 0 ? '+' : '') + quantityString(Math.abs(units));

/**
 * 流水关联的单据：来源单据、采购单、客户订单，有哪个列哪个。采购单号、订单号没有（null 或空）的不列，
 * 不拼出空的查询链接。
 */
function movementLinks(m: MovementView): MovementLink[] {
  return [
    ...(m.flowNumber && isFlowKind(m.flowKind)
      ? [{ href: flowDocHref(m.flowKind, Number(m.source_id)), label: m.flowNumber, kind: flowKindName[m.flowKind] || '业务单据' }]
      : []),
    ...(m.purchaseNumber
      ? [{ href: pageHref('purchases', { q: m.purchaseNumber }), label: m.purchaseNumber, kind: '采购单' }]
      : []),
    ...(m.customerOrderNumber
      ? [{ href: pageHref('orders', { q: m.customerOrderNumber }), label: m.customerOrderNumber, kind: '客户订单' }]
      : []),
  ];
}

/** 流水被管理员改写过时展示原值，打开面板时才读取修订台账。 */
function MovementRevisions({ id, count }: { id: string; count: number }) {
  // 读不到就当没有修订记录：修订记录只是补充说明，详情上面已经写了改过几次
  const loaded = useLoad(id, () => readMovementRevisions(id).catch(() => []));
  const list = loaded.loading ? null : loaded.data;
  return (
    <Section title={'修订记录（' + count + ' 次）'}>
      {!list ? (
        <Loading />
      ) : (
        <div className="table-wrap">
          <table className="wh-linked">
            <thead>
              <tr>
                <th>日期</th>
                <th>原因</th>
                <th className="num">原变动 → 现在</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r, i) => (
                <tr key={i}>
                  <td>
                    {r.at.slice(0, 10)}
                    <small>{r.actorName}</small>
                  </td>
                  <td>{r.reason}</td>
                  <td className="num">
                    {signedQuantity(Number(r.before.delta_units))}
                    {' → '}
                    {/* 改挂到别的单据、改备注这类修订不动数量，after 里没有数量，按原数量显示 */}
                    {r.after ? signedQuantity(Number(r.after.delta_units ?? r.before.delta_units)) : '已移除'}
                    <small>
                      {r.after && r.after.delta_units == null ? '数量没变 · ' : ''}
                      原业务日期 {r.before.date}
                    </small>
                  </td>
                </tr>
              ))}
              {!list.length && (
                <tr>
                  <td colSpan={3}>—</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

type Props = { m: MovementView; close: () => void; previous: () => void; next: () => void };

/** 一条出入库流水的详情：变动、库存品、关联单据，改写过的再列修订记录。 */
export default function MovementDetail({ m, close, previous, next }: Props) {
  const quantity = m.direction + m.delta + ' ' + m.unit;
  const links = movementLinks(m);
  const flowHref = m.flowNumber && isFlowKind(m.flowKind) ? flowDocHref(m.flowKind, Number(m.source_id)) : null;
  return (
    <DetailPanel
      kicker={'出入库流水 · ' + (m.kind === 'raw' ? '原材料' : '成品')}
      title={m.itemName}
      status={<StatusChip tone={movementTone(m)}>{movementType(m)}</StatusChip>}
      subtitle={quantity + '，变动后 ' + m.after + ' ' + m.unit}
      actions={flowHref ? <ActionBar secondary={[{ label: '去更正原单据', href: flowHref }]} /> : undefined}
      close={close}
      previous={previous}
      next={next}
    >
      {/* 流水是单据确认时自动记的，库存余额全靠它算：不能单独删，要改就改原单据 */}
      <Hint>
        {m.flowNumber
          ? '流水由单据 ' + m.flowNumber + ' 自动生成，不能单独删除。数量记错了就打开原单据更正（撤销后重做），流水会跟着改。'
          : '流水不能单独删除。手工出入库记错了，就在库存里对这个库存品再做一笔反向出入库或盘点。'}
      </Hint>
      {m.revisionCount > 0 && <Hint tone="warning">管理员改过这条流水 {m.revisionCount} 次，原值见最后的修订记录。</Hint>}
      <Section title="变动">
        <Facts
          items={[
            {
              label: '数量',
              value: <strong className={m.direction === '-' ? 'movement-negative' : 'movement-positive'}>{quantity}</strong>,
            },
            { label: '变动前 → 后', value: m.before + ' → ' + m.after + ' ' + m.unit },
            { label: '业务日期', value: m.date },
            { label: '记录时间', value: beijingTime(m.created_at) },
            { label: '操作人', value: m.actor_name },
            { label: '备注', value: m.notes, wide: true },
          ]}
        />
      </Section>
      <Section title="库存品">
        <Facts
          items={[
            { label: '仓库', value: m.kind === 'raw' ? '原材料' : '成品' },
            { label: '规格', value: m.itemSpecification },
            { label: '材质 / 楞型', value: [m.material, m.flute].filter(Boolean).join(' / ') },
          ]}
        />
      </Section>
      <Section title="关联单据">
        {links.length ? (
          <ul className="record-links">
            {links.map((l) => (
              <li key={l.kind + l.label}>
                <a href={l.href}>{l.label}</a>
                <small>{l.kind}</small>
              </li>
            ))}
          </ul>
        ) : (
          <p className="wh-muted">—</p>
        )}
      </Section>
      {m.revisionCount > 0 && <MovementRevisions id={m.id} count={m.revisionCount} />}
    </DetailPanel>
  );
}
