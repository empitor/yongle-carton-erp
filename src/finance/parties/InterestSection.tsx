import { useState } from 'react';
import { DetailPanel, ActionBar, Facts, Hint, Section, yuan, stepper } from '../../ui/index';
import type { Kind } from './shared';
import { FinList, col, mon, type Col } from '../table';
import { FinSection, PeriodInput } from '../layout';
import { FormDialog } from '../FormDialog';
import { useFinPerms } from '../fin-api';
import { confirmInterest, listInterest, type InterestRow } from './parties-api';
import { usePeriod } from '../page-state';

/** 利息建议：从哪天之后算到哪天、几天、按什么利率，多少钱 */
type Estimate = NonNullable<InterestRow['estimate']>;
const rateText = (e: Estimate) => e.rate + '%' + (e.unit === 'monthly' ? '/月' : '/年');
// 每次确认记下算到哪天，下次从那天之后接着算；只算已经过去的天数
const basisText = (r: InterestRow) =>
  r.estimate
    ? '从 ' +
      r.estimate.from +
      ' 之后算到 ' +
      r.estimate.asOf +
      '，共 ' +
      r.estimate.days +
      ' 天 · ' +
      rateText(r.estimate)
    : '缺到期日';
/** 有新的利息可以确认时的建议（金额大于 0），没有是 null */
const confirmable = (r: InterestRow) => (r.estimate && r.estimate.amount > 0 ? r.estimate : null);

const interestCols: Col<InterestRow>[] = [
  col('date', '单据日期'),
  col('party_name', '往来单位', { wrap: true }),
  col('due_date', '到期日', {
    render: (r) => r.due_date || '—',
    priority: 'low',
  }),
  mon('balance', '还欠 / 元'),
  col('confirmed_through', '已算到', {
    render: (r) => r.confirmed_through || '还没算过',
  }),
  // 右侧详情打开时：1440 宽收计算依据，1280 宽再收本月已确认；详情里都有
  col('basis', '这次怎么算', { render: basisText, priority: 'low' }),
  col('estimate', '建议 / 元', {
    num: true,
    render: (r) => yuan(confirmable(r)?.amount ?? null),
  }),
  col('confirmed', '本月已确认 / 元', {
    num: true,
    priority: 'mid',
    render: (r) => (Number(r.confirmed) ? yuan(r.confirmed) : '—'),
  }),
];

/** 压款利息：系统按账期里设的利率给建议，点一行在详情里确认后才入账。默认收起。 */
export default function InterestSection({ kind }: { kind: Kind }) {
  const perms = useFinPerms();
  const [period, setPeriod] = usePeriod();
  const [row, setRow] = useState<InterestRow | null>(null);
  const [rows, setRows] = useState<InterestRow[]>([]);
  const [confirming, setConfirming] = useState(false);
  const estimate = row && confirmable(row);
  return (
    <FinSection
      id="interest"
      title="压款利息"
      note="按账期里设的利率给建议，从上次算到的那天之后接着算，只算已经过去的天数；确认后才入账"
      collapsed
      extra={<PeriodInput value={period} onChange={setPeriod} />}
    >
      <FinList
        list={listInterest}
        label="压款利息"
        query={{ period, kind }}
        onRow={setRow}
        onData={(d) => setRows(d.rows)}
        selected={row?.id}
        empty="没有设利息的单位，或者这个月没有要计息的单子"
        cols={interestCols}
      />
      {row && (
        <DetailPanel
          kicker="压款利息"
          title={row.party_name}
          subtitle={[period, '还欠 ' + yuan(row.balance) + ' 元'].join(' · ')}
          close={() => setRow(null)}
          {...stepper(rows, (r) => r.id, row.id, setRow)}
          actions={
            <ActionBar
              primary={[
                {
                  label: '确认利息',
                  hidden: !(perms.edit && estimate),
                  onClick: () => setConfirming(true),
                },
              ]}
            />
          }
        >
          <Hint>
            {row.confirmed_through ? '已算到 ' + row.confirmed_through + '。' : '还没确认过利息。'}
            {estimate
              ? '这次建议从 ' + estimate.from + ' 之后算到 ' + estimate.asOf + '，共 ' + estimate.days + ' 天。'
              : '没有新的天数要算。'}
          </Hint>
          <Section title="计算依据">
            <Facts
              items={[
                { label: '单据日期', value: row.date },
                { label: '到期日', value: row.due_date },
                { label: '还欠', value: yuan(row.balance) + ' 元' },
                { label: '最后一次收付款', value: row.last_paid },
                { label: '已算到', value: row.confirmed_through },
                {
                  label: '本月已确认',
                  value: Number(row.confirmed) ? yuan(row.confirmed) + ' 元' : '',
                },
                { label: '这次怎么算', value: basisText(row) },
                {
                  label: '建议金额',
                  value: estimate ? yuan(estimate.amount) + ' 元' : '',
                },
              ]}
            />
          </Section>
        </DetailPanel>
      )}
      {confirming && row && estimate && (
        <FormDialog
          title="确认利息"
          subtitle={[row.party_name, '还欠 ' + yuan(row.balance) + ' 元'].join(' · ')}
          size="sm"
          columns={1}
          intro={'从 ' + estimate.from + ' 之后接着算，下次从这次算到的那天之后再算。'}
          note={'建议 ' + yuan(estimate.amount) + ' 元，是算到 ' + estimate.asOf + ' 的。'}
          submitLabel="确认利息"
          fields={[
            {
              name: 'date',
              label: '算到哪天',
              type: 'date',
              required: true,
              hint: '不能晚于今天和这个月月底',
            },
            {
              name: 'amount',
              label: '金额 / 元',
              type: 'money',
              hint: '不填按算到的那天自动算；改了金额或填 0 要写原因',
            },
            { name: 'reason', label: '原因', wide: true },
          ]}
          initial={{ date: estimate.asOf }}
          notice="利息已确认。"
          close={() => setConfirming(false)}
          submit={async (v) => {
            await confirmInterest(period, row, v);
            setRow(null);
          }}
        />
      )}
    </FinSection>
  );
}
