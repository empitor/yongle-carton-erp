import { useState } from 'react';
import { pageHref } from '../../../shared/core/index';
import { DetailPanel, ActionBar, Facts, FormMessage, Hint, Section, yuan, useConfirm, notify, useAction, Loading, loadingText } from '../../ui/index';
import { useAccountNames } from '../editor';
import VoucherDialogs from './VoucherDialogs';
import { voucherStatusName } from '../../../shared/finance/index';
import { useFinPerms, useFinRead, type FinData } from '../fin-api';
import { voucherStep } from './ledger-api';
import { FinStatusChip, Status } from '../status';
import { voucherSourceText } from '../labels';

/** 凭证详情：凭证头、分录、冲销关系、来源 */
export type VoucherDetail = FinData<'GET /finance/vouchers/:id'>;
type VoucherEntry = VoucherDetail['entries'][number];

/** 来源模块生成的凭证到哪里处理（页面 → 页签），没列的说“生成它的那一页”。 */
const handledAt: Record<string, string> = {
  event_reversal: '凭证账簿 → 业务单据',
  cash: '资金发票 → 收付款',
  invoice: '资金发票 → 发票',
  note: '资金发票 → 票据',
  obligation: '应收应付',
  bad_debt: '应收应付',
  deposit: '应收应付 → 账期',
  interest: '应收应付 → 欠款明细（压款利息那一笔）',
  costing: '费用资产工资 → 成本毛利',
  expense: '费用资产工资 → 费用报销',
  asset_disposal: '费用资产工资 → 固定资产',
};

/** 凭证状态：未提交（业务单据里的“待确认”是另一回事）→ 待审核 → 已审核 → 已记账；叫法和导出同一份。 */
export function VoucherStatus({ value }: { value: unknown }) {
  return value === 'draft' ? (
    <span className="business-status" data-tone="muted">
      {voucherStatusName(value)}
    </span>
  ) : (
    <Status value={value} />
  );
}

const stepDone: Record<string, string> = {
  submit: '凭证已提交审核。',
  approve: '凭证已审核，记账后生效。',
  post: '凭证已记账。',
};

/** 详情顶部的说明：红字凭证、已被冲销、已记账不能改（来自别的功能的写明到哪处理） */
function VoucherHints(props: { data: VoucherDetail; linked: boolean; source: string | null }) {
  const { data, linked, source } = props;
  const h = data.header;
  const red = !!h.reversal_of;
  return (
    <>
      {red && <Hint>红字凭证：冲掉原凭证，分录和原凭证同方向，金额按负数计。</Hint>}
      {data.reversedBy ? (
        // 已经被红字冲销的原凭证不用再处理，指向冲它的那张
        <Hint>
          这张已被{' '}
          <a href={pageHref('finance-ledger', { voucher: data.reversedBy.id })}>
            {data.reversedBy.period + ' 第 ' + data.reversedBy.number + ' 号'}
          </a>{' '}
          红字冲销{data.reversedBy.status === 'posted' ? '' : '（红字凭证还没记账）'}，不用再处理。
        </Hint>
      ) : (
        h.status === 'posted' &&
        (red ? (
          // 红字凭证本身就是处理结果：和原凭证一起看已经抵平，没有要再去哪里处理的
          <Hint>已记账，不能改、不能删。它和冲掉的原凭证一起看已经抵平，不用再处理。</Hint>
        ) : (
          <Hint>
            已记账，不能改、不能删，错了只能红字冲销。
            {linked &&
              '这张是 ' +
                (source || '别的财务功能') +
                ' 生成的，要到“' +
                (h.event_id ? '凭证账簿 → 业务单据' : (h.module_source && handledAt[h.module_source]) || '生成它的那一页') +
                '”里处理。'}
          </Hint>
        ))
      )}
    </>
  );
}

/** 分录表：红字凭证的分录和原凭证同方向，金额按负数计（报表按冲销关系取负号），这里显示成红色负数 */
function VoucherEntries({ entries, red }: { entries: VoucherEntry[]; red: boolean }) {
  const accountName = useAccountNames();
  const sum = (key: 'debit' | 'credit') => entries.reduce((n, e) => n + e[key], 0);
  const money = (v: unknown) => (red ? <span className="fin-negative">-{yuan(v)}</span> : yuan(v));
  return (
    <Section title="分录">
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>科目</th>
              <th>摘要</th>
              <th className="num">借方</th>
              <th className="num">贷方</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.position}>
                <td>
                  {accountName(e.account_code)}
                  {(e.auxiliary_name || e.cash_flow) && (
                    <small>{[e.auxiliary_name, e.cash_flow].filter(Boolean).join(' · ')}</small>
                  )}
                </td>
                <td>{e.description || '—'}</td>
                <td className="num">{e.debit ? money(e.debit) : ''}</td>
                <td className="num">{e.credit ? money(e.credit) : ''}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="fb-total">
              <td colSpan={2}>合计</td>
              <td className="num">{money(sum('debit'))}</td>
              <td className="num">{money(sum('credit'))}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </Section>
  );
}

/** 凭证详情：一行操作（提交审核→审核→记账），作废和红字冲销收在“更多”里。 */
export default function VoucherPanel({
  id,
  close,
  previous,
  next,
}: {
  id: number;
  close: () => void;
  /** 列表里的上一张、下一张，用 ↑↓ 切换 */
  previous?: () => void;
  next?: () => void;
}) {
  const perms = useFinPerms();
  const { data, error } = useFinRead(['GET /finance/vouchers/:id', { params: { id } }]);
  const action = useAction();
  const [confirmDialog, confirm] = useConfirm();
  const [dialog, setDialog] = useState<'edit' | 'reverse' | 'void' | null>(null);
  if (!data)
    return (
      <DetailPanel kicker="记账凭证" title={error ? '凭证读取失败' : loadingText('凭证')} close={close}>
        {error ? <FormMessage>{error}</FormMessage> : <Loading />}
      </DetailPanel>
    );
  const h = data.header;
  const entries = data.entries;
  const linked = !!(h.module_source || h.event_id);
  const name = h.period + ' 第 ' + h.number + ' 号';
  const go = async (step: 'submit' | 'approve' | 'post') => {
    // 记账后不能改、不能删，先确认一下
    if (
      step === 'post' &&
      !(await confirm({
        title: '记账 ' + name,
        message: '记账后这张凭证不能改、不能删，错了只能红字冲销。',
        confirmLabel: '记账',
      }))
    )
      return;
    await action.run(async () => {
      await voucherStep({ id, version: h.version }, step);
      notify(stepDone[step]);
    });
  };
  const source = voucherSourceText(data.source);
  // 红字凭证的分录和原凭证同方向，金额按负数计（报表按冲销关系取负号），这里显示成红色负数
  const red = !!h.reversal_of;
  return (
    <DetailPanel
      kicker={red ? '红字冲销凭证' : '记账凭证'}
      title={name}
      subtitle={h.description}
      status={<FinStatusChip value={h.status}>{voucherStatusName(h.status)}</FinStatusChip>}
      close={close}
      previous={previous}
      next={next}
      actions={
        <ActionBar
          primary={[
            {
              label: '提交审核',
              hidden: !(h.status === 'draft' && perms.edit),
              disabled: action.busy,
              onClick: () => void go('submit'),
            },
            {
              label: '审核',
              hidden: !(h.status === 'pending' && perms.approve),
              disabled: action.busy,
              onClick: () => void go('approve'),
            },
            {
              label: '记账',
              hidden: !(h.status === 'approved' && perms.approve),
              disabled: action.busy,
              onClick: () => void go('post'),
            },
          ]}
          secondary={[
            {
              label: '编辑',
              hidden: !(h.status === 'draft' && perms.edit && !linked),
              onClick: () => setDialog('edit'),
            },
          ]}
          more={[
            {
              label: '作废',
              danger: true,
              hidden: !(!['posted', 'void'].includes(h.status) && perms.edit && !h.module_source),
              onClick: () => setDialog('void'),
            },
            {
              label: '红字冲销',
              danger: true,
              hidden: !(h.status === 'posted' && !h.reversal_of && perms.edit && !linked),
              onClick: () => setDialog('reverse'),
            },
          ]}
        />
      }
    >
      {action.error && <Hint tone="danger">{action.error}</Hint>}
      <VoucherHints data={data} linked={linked} source={source} />
      <Section title="基本信息">
        <Facts
          items={[
            { label: '日期', value: h.date },
            { label: '附件', value: h.attachment_count + ' 张' },
            { label: '制单', value: h.maker_name },
            { label: '审核', value: h.approver_name },
            { label: '记账', value: h.poster_name },
            { label: '来源', value: source, hidden: !source },
            {
              label: '冲销的是',
              value: data.original ? (
                <a href={pageHref('finance-ledger', { voucher: data.original.id })}>
                  {data.original.period + ' 第 ' + data.original.number + ' 号'}
                </a>
              ) : (
                '—'
              ),
              hidden: !h.reversal_of,
            },
          ]}
        />
      </Section>
      <VoucherEntries entries={entries} red={red} />
      <VoucherDialogs data={data} dialog={dialog} close={() => setDialog(null)} />
      {confirmDialog}
    </DetailPanel>
  );
}
