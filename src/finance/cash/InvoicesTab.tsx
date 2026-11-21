import { useRef, useState } from 'react';
import { Segmented, stepper, col, mon, type Col } from '../../ui/index';
import { MatchingSection, TaxSection } from './InvoiceSections';
import InvoicePanel from './InvoicePanel';
import { invoiceStateName } from './shared';
import { listInvoices, saveInvoice } from './cash-api';
import { today } from '../../../shared/core/index';
import { PeriodInput, type HeadFn } from '../layout';
import { FinList } from '../table';
import { FormDialog } from '../FormDialog';
import { useFinPerms, exportHref, type FinData } from '../fin-api';
import { usePeriod } from '../page-state';
import { optionOf } from '../submit-pick';

/** 发票列表一行 */
type InvoiceRow = FinData<'GET /finance/invoices'>['rows'][number];
/** 发票方向：销项、进项 */
const directions = [
  ['sale', '销项（开给客户）'],
  ['purchase', '进项（供应商开来）'],
] as const;
type Direction = (typeof directions)[number][0];

/** 发票列表的列 */
const invoiceColumns: Col<InvoiceRow>[] = [
  col('date', '日期'),
  col('number', '票号'),
  // 右侧详情打开时：1440 宽收类型、不含税、税率，1280 宽再收税额；票号、往来单位、状态、价税合计一直显示
  col('type', '类型', { priority: 'low' }),
  col('party_name', '往来单位', { wrap: true }),
  col('status', '状态', { render: (r) => invoiceStateName(r.status) }),
  col('net', '不含税', { money: true, priority: 'low' }),
  col('rate', '税率', { num: true, render: (r) => r.rate + '%', priority: 'low' }),
  col('tax', '税额', { money: true, priority: 'mid' }),
  mon('gross', '价税合计'),
];

/** 新建销项或进项发票；带原件的先上传原件。保存后打开它的详情 */
function InvoiceDialog({
  direction,
  close,
  saved,
}: {
  direction: Direction;
  close: () => void;
  saved: (id: number) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <FormDialog
      title={direction === 'sale' ? '新建销项发票' : '新建进项发票'}
      size="lg"
      note="金额按票面填，系统不替你算。保存后待确认，关联单据后确认。"
      sections={[
        { title: '哪张发票', columns: 3 },
        { title: '票面金额', columns: 4 },
        { title: '红票和原件', columns: 2 },
      ]}
      fields={[
        { name: 'type', label: '发票类型', required: true, section: '哪张发票' },
        { name: 'number', label: '票号', required: true, section: '哪张发票' },
        { name: 'date', label: '开票日期', type: 'date', required: true, section: '哪张发票' },
        {
          name: 'partyId',
          label: '往来单位',
          type: 'party',
          required: true,
          span: 2,
          section: '哪张发票',
          partyKind: direction === 'sale' ? 'customer' : 'supplier',
        },
        { name: 'taxId', label: '税号', section: '哪张发票' },
        { name: 'net', label: '不含税 / 元', type: 'money', required: true, section: '票面金额' },
        { name: 'rate', label: '税率 %', required: true, section: '票面金额' },
        { name: 'tax', label: '税额 / 元', type: 'money', required: true, section: '票面金额' },
        { name: 'gross', label: '价税合计 / 元', type: 'money', required: true, section: '票面金额' },
        {
          name: 'originalId',
          label: '红票对应的蓝票编号',
          type: 'int',
          hint: '只有红票要填',
          section: '红票和原件',
        },
        {
          name: 'attachment',
          label: '发票原件',
          hint: '选填，PDF、图片、OFD 或 XML',
          section: '红票和原件',
          render: () => <input ref={fileRef} type="file" accept=".pdf,.png,.jpg,.jpeg,.ofd,.xml" />,
        },
      ]}
      initial={{ type: '数电票', date: today() }}
      submitLabel="保存发票"
      notice="发票已保存，待确认，关联单据后确认。"
      close={close}
      submit={async (v) => saved((await saveInvoice({ ...v, direction }, fileRef.current?.files?.[0])).id)}
    />
  );
}

/**
 * 发票：新建销项、进项发票，关联单据后确认。下面两节是开票对比和税务底稿（默认收起），
 * 都跟着上面的销项 / 进项切换。
 */
export default function InvoicesTab({ head }: { head: HeadFn }) {
  const perms = useFinPerms();
  const [period, setPeriod] = usePeriod();
  const [direction, setDirection] = useState<Direction>('sale');
  const [selected, setSelected] = useState<number | null>(null);
  const [rows, setRows] = useState<InvoiceRow[]>([]);
  const [dialog, setDialog] = useState(false);
  return (
    <>
      {head({
        children: <PeriodInput value={period} onChange={setPeriod} />,
        primary: perms.edit ? { label: '新建发票', onClick: () => setDialog(true) } : null,
        more: [{ label: '导出税务底稿', href: exportHref('/tax/export', { period }), download: true }],
      })}
      <div className="fin-toolbar">
        <Segmented
          className="fin-segmented"
          label="发票方向"
          value={direction}
          onChange={(v) => {
            const picked = optionOf(v, directions);
            if (picked) setDirection(picked);
          }}
          options={directions}
        />
      </div>
      <FinList
        list={listInvoices}
        label="发票"
        query={{ direction, period }}
        onRow={(r) => setSelected(r.id)}
        onData={(d) => setRows(d.rows)}
        selected={selected}
        empty={'这个月没有' + (direction === 'sale' ? '销项' : '进项') + '发票'}
        cols={invoiceColumns}
      />
      <MatchingSection kind={direction === 'sale' ? 'receivable' : 'payable'} />
      <TaxSection period={period} />
      {selected && (
        <InvoicePanel
          id={selected}
          close={() => setSelected(null)}
          {...stepper(rows, (r) => r.id, selected, (r) => setSelected(r.id))}
        />
      )}
      {dialog && <InvoiceDialog direction={direction} close={() => setDialog(false)} saved={setSelected} />}
    </>
  );
}
