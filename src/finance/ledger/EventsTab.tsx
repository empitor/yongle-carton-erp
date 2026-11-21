import { useState } from 'react';
import { FormMessage, useConfirm, hashParams, notify, stepper, useAction } from '../../ui/index';
import { useFinPerms, useSyncOnOpen } from '../fin-api';
import { type HeadFn } from '../layout';
import { FinList, col, mon, type Col } from '../table';
import { Status } from '../status';
import EventPanel, { canGenerate, problemOf, sourceName, statusOf, type EventRow } from './EventPanel';
import { generateEventVoucher, listEvents } from './ledger-api';

/** 业务单据列表的列 */
const eventColumns: Col<EventRow>[] = [
  col('date', '日期'),
  col('source_kind', '来源', { render: sourceName }),
  col('number', '单号', { render: (r) => r.number || r.source_id }),
  col('status', '状态', { render: (r) => <Status value={statusOf(r)} /> }),
  // 说明是长句，详情里有全文；1280 宽打开详情时收起，日期、单号、状态、金额一直显示
  col('problem', '说明', { wrap: true, render: (r) => problemOf(r) || '—', priority: 'mid' }),
  mon('amount_cents', '金额 / 元'),
];

/**
 * 业务单据：送货、到货确认后自动进来，在这里生成凭证或处理差异。
 * 页头主按钮“生成凭证（N）”一次给本页可记账的单据生成待记账凭证，先确认。
 */
export default function EventsTab({ head }: { head: HeadFn }) {
  const perms = useFinPerms();
  // 结账页“去处理”带 status=all 过来看全部（要处理的有差异、待补税率、待算成本……都在里面），平常默认“可记账”
  const [status, setStatus] = useState(() => (hashParams().get('status') === 'all' ? '' : 'ready'));
  const [confirmDialog, confirm] = useConfirm();
  const [row, setRow] = useState<EventRow | null>(null);
  const [rows, setRows] = useState<EventRow[]>([]);
  const action = useAction();
  const sync = useSyncOnOpen();
  const ready = rows.filter(canGenerate);
  const generateAll = async () => {
    const moved = ready.filter((r) => r.booking_date).length;
    if (
      !(await confirm({
        title: '给 ' + ready.length + ' 张单据生成凭证',
        message:
          '按记账模板生成待记账凭证，到“凭证”页签审核、记账后才生效。' +
          (moved ? '其中 ' + moved + ' 张所在月份已结账，记到最早没结账的月份。' : ''),
        confirmLabel: '生成凭证',
      }))
    )
      return;
    await action.run(async () => {
      for (const r of ready) await generateEventVoucher(r);
      notify('已为 ' + ready.length + ' 张单据生成待记账凭证。');
    });
  };
  return (
    <>
      {head({
        primary:
          perms.edit && ready.length > 0
            ? { label: '生成凭证（' + ready.length + '）', disabled: action.busy, onClick: () => void generateAll() }
            : null,
      })}
      <div className="fin-toolbar">
        <select aria-label="单据状态" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">全部</option>
          <option value="ready">可记账</option>
          <option value="info_pending">待补税率</option>
          <option value="difference">有差异</option>
          <option value="awaiting_allocation_reversal">待撤销核销</option>
          <option value="cost_pending">待算成本</option>
          <option value="waiting_invoice">等发票</option>
          <option value="source_deleted">单据已删</option>
        </select>
        <span className="fin-note">送货、到货确认后自动进来，这里是记账前的处理。缺税率的到月度台账补。</span>
      </div>
      <FormMessage close={sync.clear}>{sync.error}</FormMessage>
      <FormMessage close={action.clear}>{action.error}</FormMessage>
      <FinList
        list={listEvents}
        label="业务单据"
        query={{ status: status || undefined }}
        onData={(d) => setRows(d.rows)}
        onRow={setRow}
        selected={row?.id}
        empty={status === 'ready' ? '没有可记账的单据' : '没有符合条件的单据'}
        cols={eventColumns}
      />
      {row && (
        <EventPanel
          key={row.id}
          row={row}
          close={() => setRow(null)}
          {...stepper(rows, (r) => r.id, row.id, setRow)}
        />
      )}
      {confirmDialog}
    </>
  );
}
