import { useState } from 'react';
import { Plus } from 'lucide-react';
import { FormMessage, FormSection, Hint, toCents, yuan, RowDelete, FormField } from '../ui/index';
import { today } from '../../shared/core/index';
import { EditorShell } from './editor';
import { PartyField } from './fields';
import { syncEvents, useAccounts, useFinPerms, useFinRead, type FinData } from './fin-api';
import { enableFinance } from './settings/settings-api';
import type { HeadAction } from './layout';

/*
 * 启用财务：设置页、概览、台账、凭证、报表都能直接打开同一个启用窗口。
 * 只有有财务负责人权限（finance:close）的账号能启用；别人看到的是一句说明，没有走不通的链接。
 */

type OpeningRow = {
  accountCode: string;
  /** 应收、应付、预收、预付这几个科目要按客户或供应商填，选的单位编号和名称 */
  auxId: string;
  auxName: string;
  debit: string;
  credit: string;
  yearDebit: string;
  yearCredit: string;
};
const openingColumns = [
  ['debit', '期初借方'],
  ['credit', '期初贷方'],
  ['yearDebit', '本年累计借方'],
  ['yearCredit', '本年累计贷方'],
] as const;
const partyWords: Record<string, string> = { customer: '客户', supplier: '供应商' };
/** 末级科目（期初只填末级） */
type LeafAccount = FinData<'GET /finance/accounts'>[number];
type Taxpayer = NonNullable<FinData<'GET /finance/settings'>['taxpayer']>;
const taxpayers: readonly (readonly [Taxpayer, string])[] = [
  ['general', '一般纳税人'],
  ['small', '小规模纳税人'],
];

/** 按客户或供应商记的科目，这一行要选是哪个单位。 */
function OpeningParty({
  kind,
  row,
  onChange,
}: {
  kind: 'customer' | 'supplier';
  row: OpeningRow;
  onChange: (patch: Partial<OpeningRow>) => void;
}) {
  return (
    <PartyField
      kind={kind}
      label={'期初' + partyWords[kind]}
      placeholder={'选择' + partyWords[kind]}
      value={row.auxId}
      onChange={(v, name) => onChange({ auxId: v, auxName: name })}
    />
  );
}

/** 期初余额表：每行一个科目（往来科目再选单位），底部是合计 */
function OpeningTable({
  rows,
  setRows,
  options,
  partyKind,
  sum,
}: {
  rows: OpeningRow[];
  setRows: (fn: (all: OpeningRow[]) => OpeningRow[]) => void;
  options: LeafAccount[];
  partyKind: (code: string) => 'customer' | 'supplier' | null;
  sum: (key: keyof OpeningRow) => number;
}) {
  return (
    <div className="line-table">
      <table>
        <thead>
          <tr>
            <th>科目</th>
            <th>往来单位</th>
            {openingColumns.map(([k, label]) => (
              <th key={k} className="num">
                {label}
              </th>
            ))}
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const update = (patch: Partial<OpeningRow>) =>
              setRows((all) => all.map((x, j) => (j === i ? { ...x, ...patch } : x)));
            const kind = partyKind(r.accountCode);
            return (
              <tr key={i}>
                <td>
                  <select
                    aria-label="期初科目"
                    value={r.accountCode}
                    onChange={(e) => update({ accountCode: e.target.value, auxId: '', auxName: '' })}
                  >
                    <option value="">请选择</option>
                    {options.map((a) => (
                      <option key={a.code} value={a.code}>
                        {a.code} {a.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  {kind ? <OpeningParty kind={kind} row={r} onChange={update} /> : '—'}
                </td>
                {openingColumns.map(([k, label]) => (
                  <td key={k} className="num">
                    {/* aria-label 保持英文键名：界面检查脚本按它找输入框 */}
                    <input
                      aria-label={k}
                      title={label}
                      inputMode="decimal"
                      value={r[k]}
                      onChange={(e) => update({ [k]: e.target.value })}
                    />
                  </td>
                ))}
                <td>
                  <RowDelete
                    className="fb-row-delete"
                    label={'删除第 ' + (i + 1) + ' 行'}
                    onClick={() => setRows((all) => all.filter((_, j) => j !== i))}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="fb-total">
            <td colSpan={2}>合计</td>
            {openingColumns.map(([k]) => (
              <td key={k} className="num">
                {yuan(sum(k))}
              </td>
            ))}
            <td />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/**
 * 启用财务：先选月份和纳税人身份，再按科目填期初余额，底部随时显示借贷是否相等。
 * 应收 1122、预收 2203 按客户填，应付 2202、预付 1123 按供应商填，每个单位一行，科目合计由系统加出来。
 */
function EnableDialog({ settings, close }: { settings: FinData<'GET /finance/settings'>; close: () => void }) {
  const [period, setPeriod] = useState(today().slice(0, 7));
  const [taxpayer, setTaxpayer] = useState('');
  const [rows, setRows] = useState<OpeningRow[]>([]);
  const options = useAccounts().filter((a) => a.leaf);
  const partyKind = (code: string): 'customer' | 'supplier' | null => {
    const kind = options.find((a) => a.code === code)?.auxiliary;
    return kind === 'customer' || kind === 'supplier' ? kind : null;
  };
  const parse = (v: string) => (v.trim() ? toCents(v) : 0);
  const sum = (key: keyof OpeningRow) =>
    rows.reduce((n, r) => {
      try {
        return n + parse(r[key]);
      } catch {
        return n;
      }
    }, 0);
  const balanced = sum('debit') === sum('credit');
  const add = () =>
    setRows((all) => [
      ...all,
      { accountCode: '', auxId: '', auxName: '', debit: '', credit: '', yearDebit: '', yearCredit: '' },
    ]);
  return (
    <EditorShell
      title="启用财务"
      size="lg"
      submitLabel="确认启用"
      note={
        <span className={balanced ? undefined : 'fin-negative'}>
          期初借方 {yuan(sum('debit'))} · 贷方 {yuan(sum('credit'))}
          {balanced ? '' : ' · 借贷不平'}
        </span>
      }
      close={close}
      submit={async () => {
        for (const r of rows) {
          const kind = partyKind(r.accountCode);
          if (kind && !r.auxId) throw new Error('科目 ' + r.accountCode + ' 要选' + partyWords[kind] + '。');
        }
        const chosen = taxpayers.find(([key]) => key === taxpayer)?.[0];
        if (!chosen) throw new Error('请选择纳税人身份。');
        await enableFinance({
          period: period.trim(),
          taxpayer: chosen,
          version: settings.version,
          rows: rows.map((r) => {
            const kind = partyKind(r.accountCode);
            return {
            accountCode: r.accountCode,
            auxiliary: kind ? { kind, id: r.auxId, name: r.auxName } : null,
            debit: parse(r.debit),
            credit: parse(r.credit),
            yearDebit: parse(r.yearDebit),
            yearCredit: parse(r.yearCredit),
            };
          }),
        });
        // 启用后马上把启用月以来的单据登记进来，台账里待补税率的单子就能直接补；
        // 补扫失败不影响已经启用成功，打开概览、台账时会再补，这里不报
        await syncEvents().catch(() => undefined);
        return '财务已启用，从 ' + period + ' 开始记账。';
      }}
    >
      <FormMessage tone="warning">
        启用后期初和纳税人身份锁定，不能再改。期初借贷必须相等，填之前核对一下。
      </FormMessage>
      <FormSection title="从哪个月开始" columns={2}>
        <FormField label="启用月份" required hint="这个月之前的单据不进账，也不能补税率">
          <input type="month" required value={period} onChange={(e) => setPeriod(e.target.value)} />
        </FormField>
        <FormField label="纳税人身份" required>
          <select required value={taxpayer} onChange={(e) => setTaxpayer(e.target.value)}>
            <option value="">请选择</option>
            {taxpayers.map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </FormField>
      </FormSection>
      <FormSection
        title="期初余额"
        hint="按元填，可以先空着。应收、预收按客户，应付、预付按供应商，每个单位一行。"
        columns={1}
        extra={
          <button type="button" className="secondary" onClick={add}>
            <Plus size={14} aria-hidden="true" />
            加一行
          </button>
        }
      >
        {rows.length ? (
          <OpeningTable
            rows={rows}
            setRows={setRows}
            options={options}
            partyKind={partyKind}
            sum={sum}
          />
        ) : (
          <p className="choice-list-empty">
            还没有期初余额。没有就直接启用；有的话点上面的加一行，按科目填。
          </p>
        )}
      </FormSection>
    </EditorShell>
  );
}

/**
 * 财务启用状态和“启用财务”这个动作。action 只在没启用、而且这个账号能启用时才有，
 * 页面拿它当页头主按钮；dialog 渲染在页面里。
 */
export function useEnable() {
  const perms = useFinPerms();
  const settings = useFinRead(['GET /finance/settings']);
  const [open, setOpen] = useState(false);
  const known = !!settings.data;
  // 还没读到设置时按已启用处理，避免一闪而过的“未启用”提示
  const enabled = settings.data ? !!settings.data.startPeriod : true;
  const canEnable = perms.close;
  const action: HeadAction | null =
    known && !enabled && canEnable ? { label: '启用财务', onClick: () => setOpen(true) } : null;
  const dialog =
    open && settings.data ? <EnableDialog settings={settings.data} close={() => setOpen(false)} /> : null;
  return { enabled, known, canEnable, action, dialog };
}

/** 没启用时的一句说明。能启用的账号用页头的“启用财务”，不能的只说找谁，不放走不通的链接。 */
export function NeedEnable({ what, canEnable }: { what: string; canEnable: boolean }) {
  return (
    <Hint>
      财务还没启用，启用后才能{what}。
      {canEnable ? '点页面上方的“启用财务”，选开始记账的月份就行。' : '请财务负责人在财务设置里启用。'}
      理论和实际盈亏不用启用也能看。
    </Hint>
  );
}
