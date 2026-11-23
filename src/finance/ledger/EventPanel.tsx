import { useState } from 'react';
import { DetailPanel, ActionBar, Facts, Hint, Section, yuan, notify, useAction } from '../../ui/index';
import { pageHref, today } from '../../../shared/core/index';
import { useFinPerms, useFinRead, type FinData } from '../fin-api';
import { FormDialog } from '../FormDialog';
import { FinStatusChip } from '../status';
import { eventSourceNames } from '../labels';
import { acknowledgeEvent, correctEvent, generateEventVoucher } from './ledger-api';

/* 业务单据的详情：生成凭证、去补税率、核对无误、红字冲销（并重做）。列表在 EventsTab.tsx。 */

/** 业务单据列表的一行 */
export type EventRow = FinData<'GET /finance/events'>['rows'][number];

/** 没有往来凭证可红冲的来源：有差异时核对一下就行，库存数量和成本由月末成本计算按流水算。 */
const checkOnly = ['stock'];
const ackIntro: Record<string, string> = {
  stock: '盘点或管理员改了库存流水，数量变化由月末成本计算按流水算（算过成本的月份计入下一次成本计算）。确认后这条不再提示。',
};
/** 单据已删、原凭证还在时，“核对无误，保留凭证”的说明 */
const deletedIntro =
  '单据已删除，但原凭证记的收入或成本是真的（比如删单时保留了库存流水）：核对后保留原凭证，往来照常收付，这条不再提示。不是真的就关掉，点“红字冲销”。';
/** 要人处理的状态，说明用黄色提示。 */
const attention = ['info_pending', 'difference', 'source_deleted', 'awaiting_allocation_reversal'];

/** 状态：被红字冲销的原单据、做了红字冲销的那条都叫“已红字冲销”，和应收应付逐笔一个说法。 */
export const statusOf = (r: EventRow) => (r.reversal_state ? 'red_reversed' : r.status);
/** 说明：被冲销的原单据自己没写说明的，写一句去哪看 */
export const problemOf = (r: EventRow) =>
  r.problem || (r.reversal_state === 'reversed' ? '凭证已红字冲销，处理经过见同一单号的另一条。' : null);
export const sourceName = (r: EventRow) => eventSourceNames[r.source_kind] || r.source_kind;
export const eventTitle = (r: EventRow) => sourceName(r) + ' ' + (r.number || r.source_id);
/** 可以生成凭证：可记账、还没有凭证 */
export const canGenerate = (r: EventRow) => r.status === 'ready' && !r.voucher_id;
/** 红字冲销并重做之后按实际结果提示：重做了说重做，单据已撤销、被替代就说不再重做。 */
const correctedText = (name: string, result: FinData<'POST /finance/events/:id/correct'>) =>
  result.status === 'corrected'
    ? name + ' ' + (result.problem || '已处理。')
    : name +
      ' ' +
      (result.handled ? result.handled + '，' : '') +
      '已按单据现在的内容重做' +
      (result.voucher_id ? '，生成了待记账凭证。' : '。');

/**
 * 有差异的单据改了什么：服务端拿原来那张凭证依据的内容和单据现在的内容比，只列变了的、和财务有关的项。
 * 单据只是被撤销、内容没变时什么都不列（说明里已经写了“单据已撤销”）。
 */
function EventChanges({ id }: { id: number }) {
  const { data } = useFinRead(['GET /finance/events/:id', { params: { id } }]);
  const changes = data?.changes ?? [];
  if (!changes.length) return null;
  return (
    <Section title="改了什么">
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>项目</th>
              <th>改之前</th>
              <th>改之后</th>
            </tr>
          </thead>
          <tbody>
            {changes.map((c) => (
              <tr key={c.label}>
                <td>{c.label}</td>
                <td>{c.before}</td>
                <td>{c.after}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

function EventFacts({ row }: { row: EventRow }) {
  return (
    <Section title="基本信息">
      <Facts
        items={[
          { label: '来源', value: sourceName(row) },
          { label: '单号', value: row.number || row.source_id },
          { label: '日期', value: row.date },
          // 有差异的单据往往还没算出新金额，不显示“— 元”
          { label: '金额', value: yuan(row.amount_cents) + ' 元', hidden: row.amount_cents == null },
          {
            label: '凭证',
            value: row.voucher_id ? (
              <a href={pageHref('finance-ledger', { voucher: row.voucher_id })}>查看凭证</a>
            ) : (
              '还没生成'
            ),
            hidden: !row.voucher_id && !['ready', 'info_pending', 'waiting_invoice'].includes(row.status),
          },
          {
            label: '原来那张凭证',
            value: <a href={pageHref('finance-ledger', { voucher: row.previous_voucher_id ?? undefined })}>查看凭证</a>,
            hidden: !!row.voucher_id || !row.previous_voucher_id,
          },
        ]}
      />
    </Section>
  );
}

/** 红字冲销（并重做）、核对无误两个窗口，办完关掉详情。 */
function EventDialog({
  row,
  dialog,
  close,
  done,
}: {
  row: EventRow;
  dialog: 'correct' | 'ack';
  close: () => void;
  done: () => void;
}) {
  const title = eventTitle(row);
  if (dialog === 'correct')
    return (
      <FormDialog
        title={row.rebuild ? '红字冲销并重做' : '红字冲销'}
        subtitle={title}
        size="sm"
        columns={1}
        intro={
          row.rebuild
            ? '原凭证红冲，按单据现在的内容重新登记。已核销的要先撤销核销。'
            : '原凭证红冲。这张单据已' +
              (row.status === 'source_deleted' ? '删除' : '撤销或被更正替代') +
              '，不再重做。已核销的要先撤销核销。'
        }
        submitLabel={row.rebuild ? '确认冲销并重做' : '确认红字冲销'}
        fields={[
          { name: 'date', label: '更正日期', type: 'date', required: true },
          { name: 'reason', label: '原因', type: 'textarea', required: true },
        ]}
        // 撤销、更正过的到货默认记在撤销（更正）那天（服务端给，那个月已结账的给最早没结账月份的 1 号），别的默认今天
        initial={{ date: row.correction_date ?? today() }}
        close={close}
        submit={async (v) => {
          const result = await correctEvent(row, v);
          done();
          notify(correctedText(title, result));
        }}
      />
    );
  return (
    <FormDialog
      title={row.status === 'source_deleted' ? '保留原凭证' : '核对差异'}
      subtitle={title}
      size="sm"
      columns={1}
      intro={row.status === 'source_deleted' ? deletedIntro : ackIntro[row.source_kind] || ackIntro.stock}
      submitLabel="核对无误"
      fields={[{ name: 'reason', label: '说明', type: 'textarea', required: true }]}
      notice="已核对，这条不再提示。"
      close={close}
      submit={async (v) => {
        await acknowledgeEvent(row, v);
        done();
      }}
    />
  );
}

/** 业务单据详情；换一条时由列表给新的 key，窗口和出错跟着清掉。 */
export default function EventPanel({
  row,
  close,
  previous,
  next,
}: {
  row: EventRow;
  close: () => void;
  previous?: () => void;
  next?: () => void;
}) {
  const perms = useFinPerms();
  const action = useAction();
  const [dialog, setDialog] = useState<'correct' | 'ack' | null>(null);
  const title = eventTitle(row);
  const differs = row.status === 'difference';
  return (
    <DetailPanel
      kicker="业务单据"
      title={title}
      subtitle={[row.date, row.amount_cents == null ? null : yuan(row.amount_cents) + ' 元']
        .filter(Boolean)
        .join(' · ')}
      status={<FinStatusChip value={statusOf(row)} />}
      close={close}
      previous={previous}
      next={next}
      actions={
        perms.edit ? (
          <ActionBar
            primary={[
              {
                label: '生成凭证',
                hidden: !canGenerate(row),
                disabled: action.busy,
                onClick: () =>
                  void action.run(async () => {
                    await generateEventVoucher(row);
                    close();
                    notify(title + ' 已生成待记账凭证。');
                  }),
              },
              {
                label: '去台账补税率',
                href: pageHref('finance-flow', { missing: true }),
                hidden: row.status !== 'info_pending',
              },
              {
                label: '核对无误',
                hidden: !(differs && checkOnly.includes(row.source_kind)),
                onClick: () => setDialog('ack'),
              },
              {
                // 单据已撤销、被替代、删除的只红冲不重做，按钮不说“重做”
                label: row.rebuild ? '红字冲销并重做' : '红字冲销',
                hidden: !(
                  (differs && !checkOnly.includes(row.source_kind)) ||
                  row.status === 'source_deleted'
                ),
                onClick: () => setDialog('correct'),
              },
            ]}
            more={[
              {
                label: '核对无误，保留凭证',
                hidden: !(row.status === 'source_deleted' && row.keepable),
                onClick: () => setDialog('ack'),
              },
            ]}
          />
        ) : undefined
      }
    >
      {action.error && <Hint tone="danger">{action.error}</Hint>}
      {problemOf(row) && (
        <Hint tone={attention.includes(row.status) ? 'warning' : 'info'}>{problemOf(row)}</Hint>
      )}
      {row.booking_date && (
        <Hint tone="info">
          单据所在月份已结账，生成凭证时记在 {row.booking_date}，摘要注明单据日期；到期日仍按单据日期算。
        </Hint>
      )}
      {differs && <EventChanges id={row.id} />}
      <EventFacts row={row} />
      {dialog && <EventDialog row={row} dialog={dialog} close={() => setDialog(null)} done={close} />}
    </DetailPanel>
  );
}
