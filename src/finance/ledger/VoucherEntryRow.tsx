import { Combobox, RowDelete } from '../../ui/index';
import { auxiliaryKinds } from '../../../shared/finance/index';
import type { FinData } from '../fin-api';
import { PartyField, cashFlowItems } from '../fields';

/* 凭证编辑窗里的一条分录：科目、辅助项（客户供应商从档案选）、摘要、借贷、现金流量。窗口在 VoucherEditor.tsx。 */

export type Line = {
  accountCode: string;
  description: string;
  debit: string;
  credit: string;
  cashFlow: string;
  auxId: string;
  auxName: string;
};
/** 辅助核算的种类：客户、供应商、部门、员工、项目 */
type AuxKind = (typeof auxiliaryKinds)[number];
export const auxLabels: Record<AuxKind, string> = {
  customer: '客户',
  supplier: '供应商',
  department: '部门',
  employee: '员工',
  project: '项目',
};
/** 科目要求辅助核算时才要填。客户和供应商从档案选，其他照填名称。 */
function AuxiliaryCell({
  kind,
  line,
  label,
  onChange,
}: {
  kind: AuxKind;
  line: Line;
  label: string;
  onChange: (patch: Partial<Line>) => void;
}) {
  if (kind === 'customer' || kind === 'supplier')
    return (
      <PartyField
        kind={kind}
        label={label}
        placeholder={'选择' + auxLabels[kind]}
        value={line.auxId}
        onChange={(v, name) => onChange({ auxId: v, auxName: name })}
      />
    );
  return (
    <input
      aria-label={label}
      placeholder={auxLabels[kind]}
      value={line.auxName}
      onChange={(e) => onChange({ auxId: e.target.value.trim(), auxName: e.target.value })}
    />
  );
}
/** 能选的科目、哪些是现金银行科目（要选现金流量）、哪些要辅助核算 */
export function accountsInfo(rows: FinData<'GET /finance/accounts'>) {
  return {
    options: rows
      .filter((a) => a.leaf && a.enabled)
      .map((a) => ({ value: a.code, label: a.code + ' ' + a.name, keywords: a.name })),
    cashCodes: new Set(rows.filter((a) => a.cash_kind).map((a) => a.code)),
    auxKinds: new Map(
      rows.flatMap((a) => {
        const kind = auxiliaryKinds.find((k) => k === a.auxiliary);
        return kind ? [[a.code, kind] as const] : [];
      }),
    ),
  };
}

const none = <span className="fb-muted fb-cell-text">—</span>;

/** 一条分录：科目、辅助项、摘要、借贷（填一边清另一边）、现金流量、删除（至少留两行） */
export function EntryRow({
  line: l,
  index: i,
  accounts,
  update,
  remove,
}: {
  line: Line;
  index: number;
  accounts: ReturnType<typeof accountsInfo>;
  update: (patch: Partial<Line>) => void;
  remove?: () => void;
}) {
  const { options, cashCodes, auxKinds } = accounts;
  const auxKind = auxKinds.get(l.accountCode);
  return (
    <tr>
      <td className="fb-col-account">
        <Combobox
          ariaLabel={'第 ' + (i + 1) + ' 行科目'}
          placeholder="输入科目编号或名称"
          value={l.accountCode}
          options={options}
          onChange={(v) =>
            update(
              auxKinds.get(v) === auxKinds.get(l.accountCode)
                ? { accountCode: v }
                : { accountCode: v, auxId: '', auxName: '' },
            )
          }
        />
      </td>
      <td>
        {auxKind ? (
          <AuxiliaryCell
            kind={auxKind}
            line={l}
            label={'第 ' + (i + 1) + ' 行辅助项'}
            onChange={(patch) => update(patch)}
          />
        ) : (
          none
        )}
      </td>
      <td>
        <input
          aria-label={'第 ' + (i + 1) + ' 行摘要'}
          value={l.description}
          onChange={(e) => update({ description: e.target.value })}
        />
      </td>
      <td className="num">
        <input
          aria-label={'第 ' + (i + 1) + ' 行借方'}
          inputMode="decimal"
          value={l.debit}
          onChange={(e) => update({ debit: e.target.value, credit: '' })}
        />
      </td>
      <td className="num">
        <input
          aria-label={'第 ' + (i + 1) + ' 行贷方'}
          inputMode="decimal"
          value={l.credit}
          onChange={(e) => update({ credit: e.target.value, debit: '' })}
        />
      </td>
      <td>
        {cashCodes.has(l.accountCode) ? (
          <select
            aria-label={'第 ' + (i + 1) + ' 行现金流量'}
            value={l.cashFlow}
            onChange={(e) => update({ cashFlow: e.target.value })}
          >
            <option value="">请选择</option>
            {cashFlowItems.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        ) : (
          none
        )}
      </td>
      <td>
        {remove && <RowDelete className="fb-row-delete" label={'删除第 ' + (i + 1) + ' 行'} onClick={remove} />}
      </td>
    </tr>
  );
}
