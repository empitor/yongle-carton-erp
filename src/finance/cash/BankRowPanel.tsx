import { DetailPanel, ActionBar, Facts, Section, StatusChip, yuan, notify, useAction } from '../../ui/index';
import { signedAmount } from '../detail';
import { ErrorLine } from '../layout';
import { useFinPerms, useFinRead, type FinData } from '../fin-api';
import { matchBankRow, type BankMatch } from './cash-api';

/* 银行流水的一行详情：基本信息、建议匹配的凭证分录，匹配和解除匹配。列表在 BankSection.tsx。 */

/** 一笔银行流水 */
type BankRow = FinData<'GET /finance/bank/rows'>['rows'][number];
type Match = (match: BankMatch, message: string) => void;

function Suggestions({ row, busy, match }: { row: BankRow; busy: boolean; match: Match }) {
  const perms = useFinPerms();
  const suggestions = useFinRead(['GET /finance/bank/rows/:id/suggestions', { params: { id: row.id } }]);
  return (
    <Section title="建议匹配" extra={<span className="fin-note">只给建议，点了才算</span>}>
      {!suggestions.data ? (
        <p className="fin-note">正在找金额相同的分录…</p>
      ) : !suggestions.data.length ? (
        <p className="fin-note">没有金额相同的分录。</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>日期</th>
              <th>对方</th>
              <th className="num">金额</th>
              <th aria-label="操作" />
            </tr>
          </thead>
          <tbody>
            {suggestions.data.map((s, i) => (
              <tr key={i}>
                <td>{s.date}</td>
                <td>{s.party_name || '—'}</td>
                <td className="num">{yuan(s.amount)}</td>
                <td className="fin-row-actions">
                  {perms.cash && (
                    <button
                      type="button"
                      className="fin-row-action"
                      disabled={busy}
                      onClick={() =>
                        match(
                          s.entries ? { entries: s.entries } : { voucherId: s.voucher_id, position: s.position },
                          '已匹配到凭证。',
                        )
                      }
                    >
                      匹配
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}

export default function BankRowPanel({
  row,
  accountName,
  action,
  close,
  previous,
  next,
}: {
  row: BankRow;
  accountName?: string;
  action: ReturnType<typeof useAction>;
  close: () => void;
  previous: () => void;
  next: () => void;
}) {
  const perms = useFinPerms();
  const match: Match = (body, message) =>
    void action.run(async () => {
      await matchBankRow(row, body);
      close();
      notify(message);
    });
  return (
    <DetailPanel
      kicker="银行流水"
      title={row.party_name || row.description || row.date}
      status={<StatusChip tone={row.voucher_id ? 'success' : 'neutral'}>{row.voucher_id ? '已匹配' : '未匹配'}</StatusChip>}
      subtitle={row.date + ' · ' + signedAmount(row.amount_cents)}
      actions={
        <ActionBar
          secondary={[
            {
              label: '解除匹配',
              hidden: !(row.voucher_id && perms.cash),
              disabled: action.busy,
              onClick: () => match({ voucherId: null }, '已解除匹配。'),
            },
          ]}
        />
      }
      close={close}
      previous={previous}
      next={next}
    >
      <ErrorLine text={action.error} close={action.clear} />
      <Section title="基本信息">
        <Facts
          items={[
            { label: '对方', value: row.party_name },
            { label: '金额', value: signedAmount(row.amount_cents) },
            { label: '日期', value: row.date },
            { label: '流水号', value: row.reference },
            { label: '银行账户', value: accountName },
            { label: '摘要', value: row.description, wide: true },
          ]}
        />
      </Section>
      {!row.voucher_id && <Suggestions row={row} busy={action.busy} match={match} />}
    </DetailPanel>
  );
}
