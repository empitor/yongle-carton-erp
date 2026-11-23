import { pageHref } from '../../../shared/core/index';
import {
  DetailPanel,
  ActionBar,
  Facts,
  Hint,
  Section,
  StatusChip,
  type RecordAction,
  type Tone,
  yuan,
} from '../../ui/index';
import { MoneyProgress } from '../detail';
import { obligationSource, type Kind } from './shared';
import { useSourceVoucher } from '../source-voucher';
import { useFinPerms } from '../fin-api';
import type { ObligationRow } from './parties-api';

export type Dialog = 'new' | 'due' | 'bad' | 'recalc' | 'credit';

/**
 * 往来单的结清情况，只用来显示状态标签。红字冲销的两笔成对看（服务端 reversal-pairs.ts）：
 * 冲销那笔余额记 0、标“红字冲销”；原来那笔记两笔合计的余额，两清标“已冲销”，
 * 冲销前已收付过的钱成了多付，标“多付”。
 */
function settleState(row: ObligationRow): [string, Tone] {
  const balance = Number(row.balance);
  if (row.reversal_state === 'reversal') return ['红字冲销', 'danger'];
  // 已冲销是两清，用中性色；红色只留给“红字”标签和负数金额，免得当成出错
  if (row.reversal_state === 'reversed')
    return balance < 0 ? ['多付', 'warning'] : ['已冲销', 'neutral'];
  if (balance < 0) return ['多付', 'warning'];
  if (balance === 0) return ['已结清', 'success'];
  if (row.days_to_due != null && Number(row.days_to_due) < 0)
    return ['逾期 ' + -row.days_to_due + ' 天', 'warning'];
  return ['未结清', 'accent'];
}
/** 红字冲销冲的那笔来自哪张单据：送货单、到货单写单号，手工记的写“手工记的应收 / 应付”（冲销只发生在业务单据的往来上）。 */
const documentText = (kind: Kind, number: unknown) =>
  number
    ? (kind === 'receivable' ? '送货单 ' : '到货单 ') + number
    : '手工记的' + (kind === 'receivable' ? '应收' : '应付');
const dueText = (row: ObligationRow) =>
  row.days_to_due == null
    ? null
    : Number(row.days_to_due) < 0
      ? '已逾期 ' + -row.days_to_due + ' 天'
      : row.days_to_due + ' 天';

/** 一笔往来的读法：红字冲销的、被冲销的、余额（负数是多付）。 */
function readRow(kind: Kind, row: ObligationRow) {
  return {
    balance: Number(row.balance),
    reversal: row.reversal_state === 'reversal',
    reversed: row.reversal_state === 'reversed',
    word: kind === 'receivable' ? '应收' : '应付',
  };
}

/** 详情顶部的说明：红字冲销、重记、多付，和收付进度。 */
function ObligationHints({ kind, row }: { kind: Kind; row: ObligationRow }) {
  const { balance, reversal, reversed, word } = readRow(kind, row);
  const paidWord = kind === 'receivable' ? '收' : '付';
  return (
    <>
    {reversal && (
      <Hint>
        这笔是红字冲销，冲掉了 {documentText(kind, row.pair_source_number)} 那笔{word}（
        {row.pair_date}，{yuan(row.pair_amount_cents)}{' '}
        元）。这笔本身不算欠款、也不算多付，结清情况看原来那笔。
      </Hint>
    )}
    {reversed && balance === 0 && (
      <Hint>
        这笔已在 {row.pair_date} 红字冲销，两笔一起看已经两清，不用再
        {paidWord}。
      </Hint>
    )}
    {reversed && balance < 0 && (
      <Hint tone="warning">
        这笔已红字冲销，冲销前已{paidWord}的 {yuan(-balance)}{' '}
        元成了多付，可以转去抵同一单位还没结清的另一笔。
      </Hint>
    )}
    {reversed && balance > 0 && (
      <Hint tone="warning">这笔红字冲销后还有 {yuan(balance)} 元没结清，请核对冲销金额。</Hint>
    )}
    {!!Number(row.rerecorded) && (
      <Hint>
        这笔是单据改过以后按新内容重新记的，前面那笔已红字冲销
        {reversed ? '，这笔后来又红字冲销了' : ''}
        。同一张单据冲销、重记的几笔在逐笔里按先后挨着。
      </Hint>
    )}
    {!row.reversal_state && balance < 0 && (
      <Hint tone="warning">多付了 {yuan(-balance)} 元，可以转去抵同一单位还没结清的另一笔。</Hint>
    )}
    {!row.reversal_state && Number(row.amount_cents) > 0 && (
      <MoneyProgress label="已收付" done={row.allocated} total={row.amount_cents} />
    )}
    </>
  );
}

function ObligationFacts({ kind, row }: { kind: Kind; row: ObligationRow }) {
  const { balance, reversal, reversed } = readRow(kind, row);
  return (
    <>
    <Section title="基本信息">
      <Facts
        items={[
          { label: '往来单位', value: row.party_name },
          { label: reversal ? '冲销日期' : '单据日期', value: row.date },
          {
            label: '到期日',
            value: row.due_date || '没有账期',
            hidden: !!row.reversal_state,
          },
          {
            label: '距到期',
            value: dueText(row),
            hidden: row.days_to_due == null || !!row.reversal_state,
          },
          {
            label: '冲的是',
            value:
              documentText(kind, row.pair_source_number) +
              ' · ' +
              row.pair_date +
              ' · ' +
              yuan(row.pair_amount_cents) +
              ' 元',
            hidden: !reversal,
          },
          {
            label: '冲销日期',
            value: row.pair_date,
            hidden: !reversed,
          },
          {
            label: '税率',
            value: row.tax_status === 'pending' ? '待补税率' : '已明确',
          },
          {
            label: '凭证',
            value: row.voucher_id ? (
              <a href={pageHref('finance-ledger', { voucher: row.voucher_id })}>
                {reversal ? '查看红字凭证' : '查看凭证'}
              </a>
            ) : (
              '未生成'
            ),
          },
          { label: '摘要', value: row.description, wide: true },
        ]}
      />
    </Section>
    <Section title="金额">
      <Facts
        items={[
          {
            label: '金额',
            value: reversal ? (
              <span className="fin-negative">{yuan(row.amount_cents)} 元</span>
            ) : (
              yuan(row.amount_cents) + ' 元'
            ),
          },
          {
            label: '冲掉',
            value: <span className="fin-negative">{yuan(row.pair_amount_cents)} 元</span>,
            hidden: !reversed,
          },
          {
            label: '已收付',
            value: yuan(row.allocated) + ' 元',
            hidden: reversal,
          },
          {
            label: '多付',
            value: yuan(-balance) + ' 元',
            hidden: balance >= 0,
          },
          {
            label: '还欠',
            value: yuan(Math.max(balance, 0)) + ' 元',
            hidden: balance < 0,
          },
          {
            label: '已开票',
            value: yuan(row.invoiced) + ' 元',
            hidden: reversal,
          },
        ]}
      />
    </Section>
    </>
  );
}


export default function ObligationPanel({
  kind,
  row,
  open,
  close,
  previous,
  next,
}: {
  kind: Kind;
  row: ObligationRow;
  open: (d: Dialog) => void;
  close: () => void;
  previous: () => void;
  next: () => void;
}) {
  const perms = useFinPerms();
  const [state, tone] = settleState(row);
  const { balance, reversal, word } = readRow(kind, row);
  const voucher = useSourceVoucher(row.record_kind === 'interest' ? row.voucher_id : null, close);
  const badDebt = useSourceVoucher(row.bad_debt_voucher_id, close, '坏账');
  const primary: RecordAction[] = [],
    secondary: RecordAction[] = [],
    more: RecordAction[] = [voucher.action, badDebt.action].filter((a): a is RecordAction => !!a);
  if (perms.edit) {
    if (balance < 0) primary.push({ label: '多付转抵', onClick: () => open('credit') });
    // 红字冲销的两笔已经不欠了，到期日和坏账都不用再管
    if (!row.reversal_state) {
      secondary.push({ label: '编辑到期日', onClick: () => open('due') });
      if (kind === 'receivable' && row.voucher_id)
        more.push({ label: '坏账', danger: true, onClick: () => open('bad') });
    }
  }
  return (
    <DetailPanel
      kicker={word}
      title={
        reversal
          ? row.pair_source_number || row.source_number || '手工记的' + word
          : obligationSource(row, '手工记的' + word)
      }
      status={<StatusChip tone={tone}>{state}</StatusChip>}
      subtitle={[row.party_name, (reversal ? '冲销日 ' : '单据日 ') + row.date].join(' · ')}
      actions={<ActionBar primary={primary} secondary={secondary} more={more} />}
      close={close}
      previous={previous}
      next={next}
    >
      <ObligationHints kind={kind} row={row} />
      <ObligationFacts kind={kind} row={row} />
      {voucher.dialog}
      {badDebt.dialog}
    </DetailPanel>
  );
}
