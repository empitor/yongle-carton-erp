import { useState } from 'react';
import { ListSummary, yuan, col, mon, type Col } from '../../ui/index';
import { describeTerm, type Kind, kindWord, advanceWord } from './shared';
import { today } from '../../../shared/core/index';
import { FinList } from '../table';
import { FinSection } from '../layout';
import type { FinData } from '../fin-api';
import { listAging, listHeld } from './parties-api';

/* 欠款明细页签里的查看类内容：按单位汇总、账龄。 */

/** 按单位的一页（带全部单位的合计）、一行；账龄的一页（带分档天数和每档合计）、一行 */
type HeldPage = FinData<'GET /finance/held'>;
type HeldRow = HeldPage['rows'][number];
type AgingPage = FinData<'GET /finance/aging'>;
type AgingRow = AgingPage['rows'][number];
/** 账龄起算：按单据日、按到期日 */
type Basis = 'document' | 'due';

/** 按单位的列：已送货未开票只有应收有 */
function heldCols(kind: Kind): Col<HeldRow>[] {
  return [
    col('party_name', '往来单位', { wrap: true }),
    // 和逐笔的详情面板同屏：账期文字长、预收（预付）已算进还欠，先收；1280 宽再收最早到期和超授信，
    // 剩往来单位加四个金额列（还没到期、已到期、没有账期、还欠），一直显示
    col('term', '账期', { render: describeTerm, priority: 'low' }),
    col('earliest_due', '最早到期', {
      render: (r) => r.earliest_due || '—',
      priority: 'mid',
    }),
    mon('held', '还没到期'),
    mon('due', '已到期'),
    mon('no_terms', '没有账期'),
    // 预收（预付）为 0 的写“—”，1440 宽打开详情时先收（还欠已扣掉它）；
    // 还欠和对账单期末同一个数，负数是对方多付，和对账单一样不标红
    col('advance', advanceWord(kind), {
      money: true,
      priority: 'low',
      render: (r) => (Number(r.advance) ? yuan(r.advance) : '—'),
    }),
    ...(kind === 'receivable'
      ? [
          col<HeldRow>('uninvoiced', '已送货未开票', {
            money: true,
            priority: 'low',
            render: (r) => (Number(r.uninvoiced) ? yuan(r.uninvoiced) : '—'),
          }),
        ]
      : []),
    mon('net', '还欠'),
    // 超授信按还欠（已扣预收、预付）算；大多数单位是“—”，1280 宽打开详情时和最早到期一起收
    col('over_limit', '超授信', {
      money: true,
      priority: 'mid',
      render: (r) =>
        Number(r.over_limit) > 0 ? <span className="fin-negative">{yuan(r.over_limit)}</span> : '—',
    }),
  ];
}

/** 按单位汇总：每个单位没到期多少、已到期多少、预收（预付）多少、扣掉以后还欠多少（= 对账单期末）。点一行，下面的逐笔明细只看这个单位。 */
export function HeldSection({
  kind,
  party,
  onParty,
}: {
  kind: Kind;
  party: string;
  onParty: (partyId: string) => void;
}) {
  const [date, setDate] = useState(today());
  const [data, setData] = useState<HeldPage | null>(null);
  // 合计用服务端按全部单位算好的，不只加当前页
  const sum = (key: keyof HeldPage['totals']) => (data ? data.totals[key] : null);
  return (
    <FinSection
      id="held"
      title="按单位"
      note="点一行只看这个单位的逐笔明细"
      extra={
        <label className="fin-period">
          <span>截至</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
      }
    >
      {/* 常显一句会改变读数意思的；各列怎么算放进各项的口径说明（收起） */}
      <p className="fin-note">
        还欠和对账单期末是同一个数，已扣掉{advanceWord(kind)}。有凭证还没记账时可能暂时对不上前几列，记账后就对上了。
      </p>
      <ListSummary
        items={[
          {
            label: '还没到期',
            value: yuan(sum('held')),
            hint:
              '还没到期、已到期、没有账期按欠款单子算：凭证还没记账的单据也算，' +
              (kind === 'receivable' ? '收款' : '付款') +
              '核销、红字冲销一做就扣掉',
          },
          { label: '已到期没结', value: yuan(sum('due')) },
          { label: '没有账期', value: yuan(sum('no_terms')) },
          { label: advanceWord(kind), value: yuan(sum('advance')) },
          // 只有应收、按开票确认收入时才有；是 0 就不占位置
          ...(kind === 'receivable' && sum('uninvoiced')
            ? [{ label: '已送货未开票', value: yuan(sum('uninvoiced')), note: '算在欠款里，总账还没记' }]
            : []),
          {
            label: '还欠',
            value: yuan(sum('net')),
            hint:
              (kind === 'receivable' ? '送货' : '到货') +
              '没记账先算进还欠，' +
              (kind === 'receivable' ? '收款' : '付款') +
              '和手工登记的往来要等凭证记账后才进；超授信也按还欠算' +
              (kind === 'receivable' ? '。按开票确认收入的送货：还欠 = 前三列 − 预收 − 已送货未开票' : ''),
          },
        ]}
      />
      <FinList
        list={listHeld}
        label={kindWord(kind) + '按单位'}
        // 日期清空时不带（按今天算），和原来拼地址时一样
        query={{ kind, date: date || undefined }}
        onData={setData}
        rowKey={(r) => r.party_id}
        selected={party || null}
        onRow={(r) => onParty(r.party_id === party ? '' : r.party_id)}
        empty={
          kind === 'receivable' ? '没有客户欠款，也没有预收款' : '没有欠供应商的货款，也没有预付款'
        }
        cols={heldCols(kind)}
      />
    </FinSection>
  );
}

/** 账龄的列：按到期日算时没到期的写“未到期” */
const agingCols = (basis: Basis): Col<AgingRow>[] => [
  col('date', '单据日期'),
  col('party_name', '往来单位', {
    wrap: true,
    // 逐笔里已经写着“已冲销、两清”，这里还挂着是因为账龄只算已记账的，写一句免得看糊涂
    render: (r) =>
      Number(r.reversal_pending) ? (
        <>
          {r.party_name}
          <small className="fin-aging-note">红字凭证待记账，记账后不再计入</small>
        </>
      ) : (
        r.party_name
      ),
  }),
  col('due_date', '到期日', { render: (r) => r.due_date || '没有账期' }),
  // 按到期日算时没到期的是负数，写“未到期”，不写“-10 天”
  col('days', '账龄', {
    num: true,
    render: (r) => (basis === 'due' && Number(r.days) < 0 ? '未到期' : r.days + ' 天'),
  }),
  mon('balance', '余额 / 元'),
];

/** 账龄：按单据日或到期日分段。默认收起。 */
export function AgingSection({ kind }: { kind: Kind }) {
  const [basis, setBasis] = useState<Basis>('document');
  const [overdue, setOverdue] = useState(false);
  const [data, setData] = useState<AgingPage | null>(null);
  const bands = data?.bands || [];
  const bandName = (i: number) =>
    i === -1
      ? '没有账期'
      : i === 0
      ? // 第 0 段是账龄 0 天及以内：按单据日算就是当天的单子，按到期日算就是还没过到期日的
        basis === 'due'
        ? '没逾期'
        : '0 天（当天）'
      : i > bands.length
        ? bands.at(-1) + ' 天以上'
        : (bands[i - 2] || 0) + 1 + '–' + bands[i - 1] + ' 天';
  return (
    <FinSection
      id="aging"
      title="账龄"
      note="欠了多久"
      collapsed
      extra={
        <>
          <select
            aria-label="账龄起算"
            value={basis}
            onChange={(e) => {
              if (e.target.value === 'document' || e.target.value === 'due') setBasis(e.target.value);
            }}
          >
            <option value="document">按单据日算</option>
            <option value="due">按到期日算</option>
          </select>
          <label className="fin-check">
            <input
              type="checkbox"
              checked={overdue}
              onChange={(e) => setOverdue(e.target.checked)}
            />
            只看逾期
          </label>
        </>
      }
    >
      <p className="fin-note">
        只算已记账的欠款单子，不含{advanceWord(kind)}
        ：凭证还没记账的单据不在这里，红字冲销要等红字凭证记账后才扣掉，所以和上面“按单位”可能暂时对不上。没有账期的单子单独一档“没有账期”，和“按单位”一样。
        {basis === 'due' && '按到期日算时，账龄是过了到期日多少天，还没到期的写“未到期”。'}
      </p>
      <ListSummary
        items={(data?.totals || []).map((t) => ({
          label: bandName(Number(t.bucket)),
          value: yuan(t.balance),
          hint: t.count + ' 笔',
        }))}
      />
      <FinList
        list={listAging}
        label="账龄"
        query={{ kind, basis, overdue: overdue ? '1' : undefined }}
        onData={setData}
        empty="没有未结清的单子"
        cols={agingCols(basis)}
      />
    </FinSection>
  );
}
