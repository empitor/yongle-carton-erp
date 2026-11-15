import type { ReactNode } from 'react';
import { arrivalProgressText } from '../../shared/business/index';
import { displayAmount } from '../../shared/core/index';
import { Hint, StatusChip } from '../ui/index';
import { businessStatusTone } from '../recordkit/record-meta';
import type { CorrectionPreview } from './useCorrection';

/*
 * 更正窗里“更正后的影响”（服务端核验返回的，前端只显示）：一张三列表（项目 / 原来 / 更正后），
 * 各种单据自己的几行在前，库存品的原来、更正后、净变化和金额在后。
 */

type Preview<K extends CorrectionPreview['kind']> = Extract<CorrectionPreview, { kind: K }>;

const amount = (v: string | null) => (v == null ? '待定' : displayAmount(v));
const qty = (v: string | null, unit: string | undefined) => (v == null ? '—' : v + ' ' + unit);
const asIs = (v: string) => v;

function ImpactTable({ plan, children }: { plan: Pick<CorrectionPreview, 'warnings'>; children: ReactNode }) {
  return (
    <section className="ed-section" aria-label="更正影响">
      <header>
        <h3>更正后的影响</h3>
      </header>
      {plan.warnings.map((w) => (
        <Hint key={w} tone="warning">
          {w}
        </Hint>
      ))}
      <div className="table-wrap">
        <table className="wh-table">
          <thead>
            <tr>
              <th>项目</th>
              <th className="num">原来</th>
              <th className="num">更正后</th>
            </tr>
          </thead>
          <tbody>{children}</tbody>
        </table>
      </div>
    </section>
  );
}

/** 一行：项目（带小字）、原来、更正后（带小字） */
function Row(o: { label: ReactNode; sub?: ReactNode; before: ReactNode; after: ReactNode; afterSub?: ReactNode }) {
  return (
    <tr>
      <td>
        {o.label}
        {o.sub && <small>{o.sub}</small>}
      </td>
      <td className="num">{o.before}</td>
      <td className="num">
        <strong>{o.after}</strong>
        {o.afterSub && <small>{o.afterSub}</small>}
      </td>
    </tr>
  );
}

/** 每个库存品：原来、更正后、净变化（到货新加的行还没对应库存品的，只说核对时怎么对应） */
function StockRows({ plan }: { plan: Pick<CorrectionPreview, 'stockImpact'> }) {
  return (
    <>
      {plan.stockImpact.map((s, i) => (
        <Row
          key={'s' + (s.stockId ?? 'new' + i)}
          label={s.name + ' · 库存'}
          sub={s.stockId == null ? '核对时对应已有的同一种纸板，没有就新建' : undefined}
          before={qty(s.before, s.unit)}
          after={qty(s.after, s.unit)}
          afterSub={'净变化 ' + s.delta + ' ' + s.unit}
        />
      ))}
    </>
  );
}

/** 前后不一样才列的一行（日期、产品这类）：show 把前后各换成要显示的文字 */
function changedRow<T>(label: string, change: { before: T; after: T }, show: (v: T) => string) {
  const before = show(change.before),
    after = show(change.after);
  return before !== after ? <Row label={label} before={before} after={after} /> : null;
}

/** 到货：每张采购单累计到货、库存、本次到货金额 */
function ArrivalImpact({ plan }: { plan: Preview<'arrival'> }) {
  return (
    <ImpactTable plan={plan}>
      {plan.purchaseImpact.flatMap((p) =>
        p.lines.map((l) => (
          <Row
            key={p.id + ':' + l.lineId}
            label={l.name + ' · 累计到货'}
            sub={
              <>
                {p.number}{' '}
                <StatusChip tone={businessStatusTone(arrivalProgressText(p.arrivalProgress))}>
                  {arrivalProgressText(p.arrivalProgress)}
                </StatusChip>
              </>
            }
            before={qty(l.before, l.unit)}
            after={qty(l.after, l.unit)}
            afterSub={'待到货 ' + l.remaining + ' ' + l.unit}
          />
        )),
      )}
      <StockRows plan={plan} />
      <Row label="本次到货金额" before={amount(plan.beforeAmount) + ' 元'} after={amount(plan.afterAmount) + ' 元'} />
    </ImpactTable>
  );
}

/** 送货：出库日期（改了才列）、每条订单明细的已发、库存、本次送货金额 */
function DeliveryImpact({ plan }: { plan: Preview<'delivery'> }) {
  return (
    <ImpactTable plan={plan}>
      {changedRow('出库日期', plan.date, asIs)}
      {plan.orderImpact.map((o) => (
        <Row
          key={'o' + o.orderLineId}
          label={o.productName + ' · 订单已发'}
          sub={o.orderNumber + ' · 订购 ' + o.ordered + ' ' + o.unit}
          before={qty(o.before, o.unit)}
          after={qty(o.after, o.unit)}
        />
      ))}
      <StockRows plan={plan} />
      <Row label="本次送货金额" before={amount(plan.beforeAmount) + ' 元'} after={amount(plan.afterAmount) + ' 元'} />
    </ImpactTable>
  );
}

/** 完工：日期、产品、合格、报废（改了才列），生产任务的已入库，成品和纸板库存；超计划的提示在 warnings 里 */
function ProductionImpact({ plan }: { plan: Preview<'production'> }) {
  const withUnit = (v: string) => qty(v, plan.unit);
  return (
    <ImpactTable plan={plan}>
      {changedRow('完工日期', plan.date, asIs)}
      {changedRow('产品', plan.product, (p) => p.name)}
      {changedRow('合格', plan.good, withUnit)}
      {changedRow('报废', plan.scrap, withUnit)}
      {plan.taskImpact.map((t) => (
        <Row
          key={'t' + t.id}
          label={t.number + ' · 已入库'}
          sub={'计划 ' + t.planned + ' ' + t.unit}
          before={qty(t.before, t.unit)}
          after={qty(t.after, t.unit)}
        />
      ))}
      <StockRows plan={plan} />
    </ImpactTable>
  );
}

/** 核验出来的影响：按原单的种类（到货、送货、完工）各一张表 */
export default function CorrectionImpact({ plan }: { plan: CorrectionPreview }) {
  switch (plan.kind) {
    case 'arrival':
      return <ArrivalImpact plan={plan} />;
    case 'delivery':
      return <DeliveryImpact plan={plan} />;
    case 'production':
      return <ProductionImpact plan={plan} />;
  }
}
