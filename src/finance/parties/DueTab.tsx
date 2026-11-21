import { useState } from 'react';
import { FormMessage, ListSummary, yuan, loadingText } from '../../ui/index';
import { percentOf } from '../percent';
import { type Kind, kindWord } from './shared';
import { MAX_PAGE_SIZE, today } from '../../../shared/core/index';
import { FinSection, type HeadFn } from '../layout';
import { FinList, FinTable, col, mon, type Col } from '../table';
import { useFinRead, type FinData } from '../fin-api';
import { listDiscountOpportunities } from './parties-api';

/* 到期和计划页签：到期提醒、现结优惠、收付计划。 */

/** 到期提醒一行、现结优惠一行、收付计划的一个月、一个月的到期明细一行 */
type SoonRow = FinData<'GET /finance/due-soon'>['rows'][number];
type DiscountRow = FinData<'GET /finance/discount-opportunities'>['rows'][number];
type Plan = FinData<'GET /finance/payment-plan'>;
type PlanMonth = Plan['forecast'][number];
type DueItem = Plan['detail']['rows'][number];

/** 到期提醒一次读够的笔数：服务端一页最多的条数，超过时提示缩短天数 */
const SOON_LIMIT = MAX_PAGE_SIZE;

/** 到期和计划：到期提醒、现结优惠、收付计划三节。都按页签上的应收 / 应付走。 */
export function DueTab({ kind, head }: { kind: Kind; head: HeadFn }) {
  return (
    <>
      {head({})}
      <SoonSection kind={kind} />
      <DiscountSection kind={kind} />
      <PlanSection kind={kind} />
    </>
  );
}

const soonCols: Col<SoonRow>[] = [
  col('due_date', '到期日'),
  col('days_to_due', '距今', {
    num: true,
    render: (r) =>
      Number(r.days_to_due) < 0 ? (
        <span className="fin-negative">逾期 {-r.days_to_due} 天</span>
      ) : (
        r.days_to_due + ' 天'
      ),
  }),
  col('party_name', '往来单位', { wrap: true }),
  col('date', '单据日期'),
  mon('balance', '金额 / 元'),
];

/** 到期提醒：接口不分应收应付，一次读够再按页签上的切换筛；已逾期的也列在这里。 */
function SoonSection({ kind }: { kind: Kind }) {
  const [days, setDays] = useState(7);
  const { data, error } = useFinRead(['GET /finance/due-soon', { query: { days, pageSize: SOON_LIMIT } }]);
  const rows = (data?.rows || []).filter((r) => r.kind === kind);
  return (
    <FinSection
      id="soon"
      title="到期提醒"
      note="已逾期的也在这里"
      extra={
        <label className="fin-period">
          <span>未来</span>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[7, 15, 30, 60].map((d) => (
              <option key={d} value={d}>
                {d} 天
              </option>
            ))}
          </select>
        </label>
      }
    >
      <FormMessage>{error}</FormMessage>
      <FinTable
        label="到期提醒"
        rows={rows}
        rowKey={(r, i) => r.id + ':' + r.installment_id + ':' + i}
        empty={data ? '这段时间没有到期的' + kindWord(kind) : loadingText()}
        cols={soonCols}
      />
      {data && data.filteredRecords > SOON_LIMIT && (
        <p className="fin-note">{'只列了最早到期的 ' + SOON_LIMIT + ' 笔，缩短天数看得更全。'}</p>
      )}
    </FinSection>
  );
}

const discountCols: Col<DiscountRow>[] = [
  col('date', '单据日期'),
  col('party_name', '往来单位', { wrap: true }),
  col('due_date', '到期日', { render: (r) => r.due_date || '—' }),
  mon('balance', '未结 / 元'),
  col('rate', '优惠', { num: true, render: (r) => r.offer.rate + '%' }),
  col('offer', '可省 / 元', { num: true, render: (r) => yuan(r.offer.amount) }),
  col('deadline', '最晚付款', { render: (r) => r.offer.deadline }),
  col('annual', '年化', {
    num: true,
    render: (r) =>
      r.offer.annualized
        ? percentOf(r.offer.annualized.numerator, r.offer.annualized.denominator)
        : '—',
  }),
];

function DiscountSection({ kind }: { kind: Kind }) {
  return (
    <FinSection
      id="discount"
      title="现结优惠"
      note={
        kind === 'payable'
          ? '现在付款能拿到供应商优惠的单子；收付款核销时填优惠金额'
          : '客户现在结清能享受优惠的单子；收付款核销时填优惠金额'
      }
    >
      <FinList
        list={listDiscountOpportunities}
        label="现结优惠"
        query={{ kind }}
        empty="现在没有可用的优惠"
        cols={discountCols}
      />
    </FinSection>
  );
}

const planCols: Col<PlanMonth>[] = [
  col('period', '月份', { render: (r) => (r.period === 'overdue' ? '已逾期' : r.period) }),
  mon('receivable', '应收到'),
  mon('payable', '应付出'),
  col('forecastCash', '预计资金', {
    money: true,
    render: (r) => (
      <span className={Number(r.forecastCash) < 0 ? 'fin-negative' : undefined}>
        {yuan(r.forecastCash)}
      </span>
    ),
  }),
];
const dueItemCols: Col<DueItem>[] = [
  col('party_name', '往来单位', { wrap: true }),
  col('date', '单据日期'),
  col('due_date', '到期日'),
  mon('balance', '金额 / 元'),
];

/** 收付计划：资金预测本身要把收和付放在一起算；点一个月看到期明细，明细按应收 / 应付筛。 */
function PlanSection({ kind }: { kind: Kind }) {
  const [months, setMonths] = useState(6);
  const [dueMonth, setDueMonth] = useState('');
  const date = today();
  const { data, error } = useFinRead([
    'GET /finance/payment-plan',
    { query: { date, months, dueMonth: dueMonth || undefined } },
  ]);
  const detail = (data?.detail.rows || []).filter((r) => r.kind === kind);
  return (
    <FinSection
      id="plan"
      title="收付计划"
      note="按到期日预测每月资金，收和付一起算"
      collapsed
      extra={
        <label className="fin-period">
          <span>看未来</span>
          <select value={months} onChange={(e) => setMonths(Number(e.target.value))}>
            {[3, 6, 12, 24].map((m) => (
              <option key={m} value={m}>
                {m} 个月
              </option>
            ))}
          </select>
        </label>
      }
    >
      <FormMessage>{error}</FormMessage>
      <ListSummary
        items={[
          { label: '现在的资金', value: yuan(data?.openingCash) },
          { label: '没有账期的应收', value: yuan(data?.noTerms.receivable), note: '没算进预测' },
          { label: '没有账期的应付', value: yuan(data?.noTerms.payable), note: '没算进预测' },
          ...(data?.deposits || []).map((d) => ({
            label: d.kind === 'paid' ? '付出的保证金' : '收到的保证金',
            value: yuan(d.balance),
          })),
        ]}
      />
      <FinTable
        label="按月收付计划"
        rows={data?.forecast || []}
        rowKey={(r) => r.period}
        // “已逾期”一行也能点开看明细（到期日早于今天的，和到期提醒的“逾期 N 天”同一口径）
        onRow={(r) => setDueMonth(r.period === dueMonth ? '' : r.period)}
        selected={dueMonth}
        cols={planCols}
      />
      {dueMonth && (
        <>
          <h3 className="fin-subhead">
            {dueMonth === 'overdue'
              ? '已逾期的' + kindWord(kind)
              : dueMonth + ' 到期的' + kindWord(kind)}
          </h3>
          <FinTable
            label={dueMonth === 'overdue' ? '已逾期明细' : dueMonth + ' 到期明细'}
            rows={detail}
            rowKey={(r, i) => r.id + ':' + r.installment_id + ':' + i}
            empty={
              dueMonth === 'overdue'
                ? '没有已逾期的' + kindWord(kind)
                : '这个月没有到期的' + kindWord(kind)
            }
            cols={dueItemCols}
          />
        </>
      )}
    </FinSection>
  );
}
