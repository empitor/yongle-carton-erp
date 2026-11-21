import { useState } from 'react';
import { FormMessage, ListSummary, StatusChip, yuan } from '../../ui/index';
import { partyKindOf, type Kind } from './shared';
import { today } from '../../../shared/core/index';
import { FinSection, type HeadFn } from '../layout';
import { FinTable, col, type Col } from '../table';
import { exportHref, useFinPerms, useFinRead, type FinData } from '../fin-api';
import { statementRequest } from './statement-request';
import { markStatement } from './parties-api';
import { FormDialog } from '../FormDialog';
import { PartyPicker } from '../fields';
import { usePeriod } from '../page-state';

/** 对账单上的一行 */
type StatementLine = FinData<'GET /finance/statements'>['items'][number];

const statementState: Record<string, string> = {
  sent: '已发给对方',
  confirmed: '对方已确认',
  difference: '有差异',
};

const statementCols: Col<StatementLine>[] = [
  col('date', '日期'),
  col('number', '凭证号', { render: (r) => r.number ?? '未记账' }),
  col('description', '摘要', {
    wrap: true,
    // 红字那行的摘要由服务端按冲的是哪张单据生成（红字冲销 送货单 SH-…），被冲销的原来那行标“已冲销”
    render: (r) =>
      r.reversed ? (
        <>
          {r.description} <StatusChip tone="neutral">已冲销</StatusChip>
        </>
      ) : (
        r.description
      ),
  }),
  col('due_date', '到期日', { render: (r) => r.due_date || '—' }),
  col('delta', '发生额 / 元', {
    money: true,
    render: (r) =>
      // 只有红字那行用红色；收付款冲减余额也是负数，不标红
      r.red ? <span className="fin-negative">{yuan(r.delta)}</span> : yuan(r.delta),
  }),
];

/** 对账单：选单位和日期范围，导出给对方，标记对方是否确认。 */
export default function StatementTab({ kind, head }: { kind: Kind; head: HeadFn }) {
  const perms = useFinPerms();
  const [period] = usePeriod();
  const [partyId, setPartyId] = useState('');
  const [from, setFrom] = useState(period + '-01');
  const [to, setTo] = useState(today());
  const [dialog, setDialog] = useState(false);
  const query = { kind, partyId, from, to };
  const { data, error } = useFinRead(statementRequest(query));
  return (
    <>
      {head({
        primary: partyId && perms.edit ? { label: '标记对账状态', onClick: () => setDialog(true) } : null,
        more: partyId
          ? [{ label: '导出对账单', href: exportHref('/statements/export', query), download: true }]
          : [],
      })}
      <div className="fin-toolbar">
        <PartyPicker kind={partyKindOf(kind)} value={partyId} onChange={setPartyId} />
        <input type="date" aria-label="开始日期" value={from} onChange={(e) => setFrom(e.target.value)} />
        至
        <input type="date" aria-label="结束日期" value={to} onChange={(e) => setTo(e.target.value)} />
      </div>
      <FormMessage>{error}</FormMessage>
      {!partyId && (
        <FinSection title="对账单">
          <p className="fin-note">
            先在上面选一个{kind === 'receivable' ? '客户' : '供应商'}和日期范围，这里列出这段时间的发生额，可以导出发给对方。
          </p>
        </FinSection>
      )}
      {data && (
        <>
          <ListSummary
            items={[
              { label: '期初', value: yuan(data.opening) },
              { label: '期末', value: yuan(data.closing) },
              { label: '状态', value: (data.state && statementState[data.state.status]) || '还没发给对方' },
              ...(data.state?.discrepancy ? [{ label: '差异', value: data.state.discrepancy }] : []),
            ]}
          />
          {Number(data.advance) > 0 && (
            // 收付款没核销就记在预收（预付）上，也列在对账单里；“按单位”的“还欠”同样扣掉了，截至同一天两边一致
            <p className="fin-note">
              期末已扣掉还没抵货款的{kind === 'receivable' ? '预收款' : '预付款'} {yuan(data.advance)} 元，和应收应付“按单位”截至同一天的“还欠”一致。
            </p>
          )}
          <section className="panel business-records">
            <FinTable
              label="对账单"
              rows={data.items}
              rowKey={(_, i) => i}
              empty="这段时间没有发生额"
              cols={statementCols}
            />
          </section>
        </>
      )}
      {dialog && (
        <FormDialog
          title="标记对账状态"
          subtitle={from + ' 至 ' + to}
          size="sm"
          fields={[
            {
              name: 'status',
              label: '状态',
              type: 'select',
              required: true,
              options: [
                ['sent', '已发给对方'],
                ['confirmed', '对方已确认'],
                ['difference', '有差异'],
              ],
            },
            {
              name: 'discrepancy',
              label: '差异说明',
              type: 'textarea',
              placeholder: '例如：对方少记一笔 11 月 5 日的送货',
              show: (v) => v.status === 'difference',
            },
          ]}
          initial={{ status: data?.state?.status, discrepancy: data?.state?.discrepancy }}
          notice="对账状态已标记。"
          close={() => setDialog(false)}
          submit={(v) =>
            markStatement({
              ...query,
              status: String(v.status),
              discrepancy: String(v.discrepancy ?? ''),
              ...(data?.state ? { version: data.state.version } : {}),
            })
          }
        />
      )}
    </>
  );
}
