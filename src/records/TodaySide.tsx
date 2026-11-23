import type { WorkbenchApi } from '../../shared/business/index';
import { pageHref } from '../../shared/core/index';
import { yuan, type Slots } from '../ui/index';

type Today = WorkbenchApi['GET /business/today']['response'];
type DueRow = Awaited<ReturnType<NonNullable<Slots['finance']>['dueSoon']>>[number];

/** 今日页右栏：今日安排（到货、生产、送货）、7 天内到期货款（有财务权限才有）、原材料零库存。 */
export default function TodaySide({
  schedule,
  dueRows,
  zeroStock,
}: {
  schedule: Today['schedule'];
  dueRows: readonly DueRow[];
  zeroStock: Today['zeroStock'];
}) {
  const hasSchedule = !!(
    schedule.arrivals.length ||
    schedule.tasks.length ||
    schedule.deliveries.length
  );
  return (
    <aside className="td-side">
      {hasSchedule && (
        <section className="td-group">
          <header>
            <h2>今日安排</h2>
          </header>
          <ul className="td-list">
            {/* 今天要到：订货单里截止日是今天、还没到齐的；逾期没到齐的服务端排在前面，标红 */}
            {schedule.arrivals.map((r) => (
              <li key={'a' + r.id}>
                <b className={r.overdue ? 'td-late' : undefined}>{r.overdue ? '逾期' : '到货'}</b>
                <a href={pageHref('warehouse', { arrivals: true })}>{r.overdue ? r.label.replace(/^逾期\s*/, '') : r.label}</a>
              </li>
            ))}
            {schedule.tasks.map((r) => (
              <li key={'t' + r.id}>
                <b>生产</b>
                <a href={pageHref('production')}>{r.label}</a>
              </li>
            ))}
            {schedule.deliveries.map((r) => (
              <li key={'d' + r.id}>
                <b>送货</b>
                <a href={pageHref('warehouse', { deliveries: true, kind: 'finished' })}>{r.label}</a>
              </li>
            ))}
          </ul>
        </section>
      )}
      {dueRows.length > 0 && (
        <section className="td-group">
          <header>
            <h2>
              7 天内到期货款 <span className="td-count">{dueRows.length}</span>
            </h2>
          </header>
          <ul className="td-list">
            {dueRows.map((d) => (
              <li key={d.id + ':' + d.installment_id}>
                <b>{d.kind === 'receivable' ? '应收' : '应付'}</b>
                <a href={pageHref('finance-ar', { tab: 'soon' })}>
                  {d.party_name} {yuan(d.balance)} 元
                </a>
                <small className={Number(d.days_to_due) < 0 ? 'td-late' : ''}>
                  {Number(d.days_to_due) < 0
                    ? '逾期 ' + -d.days_to_due + ' 天'
                    : d.days_to_due + ' 天后'}
                </small>
              </li>
            ))}
          </ul>
        </section>
      )}
      {zeroStock.length > 0 && (
        <section className="td-group">
          <header>
            <h2>
              原材料零库存 <span className="td-count">{zeroStock.length}</span>
            </h2>
          </header>
          <ul className="td-list">
            {zeroStock.map((i) => (
              <li key={i.id}>
                <a href={pageHref('warehouse', { kind: 'raw', q: i.name })}>{i.name}</a>
                {i.onOrder !== '0' && <small>在途 {i.onOrder}</small>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  );
}
