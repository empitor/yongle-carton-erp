import type { InputHTMLAttributes, ReactNode } from 'react';
import { X } from 'lucide-react';
import { Combobox, yuan } from '../ui/index';
import { financeReportTemplates, taxModes } from '../../shared/finance/index';
import { useAccounts, useCashAccounts, useFinRead, useParties } from './fin-api';
import { partyObligations } from './parties/parties-api';

/*
 * 财务编辑窗和筛选用的字段件，按 docs/界面规范.md 做：标签在上、说明在下。
 * 一般的字段用 src/ui 的 FormField（外层是 label.field，界面检查脚本按它找输入框）。
 */

export type Span = 1 | 2 | 3 | 'full';

/** 一个勾选项：方框在前，文字在后，一句说明放下面。 */
export function FinCheck({
  label,
  hint,
  checked,
  onChange,
  span = 'full',
}: {
  label: ReactNode;
  hint?: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  span?: Span;
}) {
  return (
    <label className={'field form-field fin-ed-check span-' + span}>
      <span className="fin-ed-check-row">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span>{label}</span>
      </span>
      {hint && <small className="form-field-hint">{hint}</small>}
    </label>
  );
}

/** 输入框后面跟一个单位，例如“元”“%”“天”。 */
export function UnitInput({
  unit,
  ...props
}: { unit: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <span className="fin-unit-input">
      <input {...props} />
      <span className="fin-unit" aria-hidden="true">
        {unit}
      </span>
    </span>
  );
}

export const cashFlowItems: string[] = Object.values(
  financeReportTemplates.cashflow.groups as Record<string, readonly string[]>,
).flat();

export function AccountInput({
  value,
  onChange,
  label,
  required,
  under,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  required?: boolean;
  /** 只让选这个科目和它的下级（例如往来科目只能 1122 下） */
  under?: string;
}) {
  const options = useAccounts()
    .filter((a) => a.leaf && a.enabled && (!under || a.code.startsWith(under)))
    .map((a) => ({ value: a.code, label: a.code + ' ' + a.name, keywords: a.name }));
  return (
    <Combobox
      ariaLabel={label}
      placeholder="输入科目编号或名称"
      value={value}
      required={required}
      options={options}
      onChange={onChange}
    />
  );
}
export function CashAccountSelect({
  value,
  onChange,
  label,
  required,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  required?: boolean;
}) {
  const accounts = useCashAccounts();
  return (
    <select
      aria-label={label}
      required={required}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">请选择</option>
      {accounts.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name}
          {a.last_four ? ' · ' + a.last_four : ''}
        </option>
      ))}
    </select>
  );
}
/** 编辑窗里选客户或供应商。onChange 第二个参数是选中单位的名称（要写进明细或提示时用）。 */
export function PartyField({
  kind,
  value,
  onChange,
  label,
  required,
  placeholder,
}: {
  kind: 'customer' | 'supplier';
  value: string;
  onChange: (v: string, name: string) => void;
  label: string;
  required?: boolean;
  /** 不写时是“输入客户名称”“输入供应商名称” */
  placeholder?: string;
}) {
  const options = useParties(kind);
  return (
    <Combobox
      ariaLabel={label}
      placeholder={placeholder ?? (kind === 'customer' ? '输入客户名称' : '输入供应商名称')}
      value={value}
      required={required}
      options={options}
      onChange={(v) => onChange(v, options.find((o) => o.value === v)?.label || '')}
    />
  );
}
/** 从未结清的往来单里选，不用记内部编号。 */
export function ObligationSelect({
  kind,
  partyId,
  value,
  onChange,
  label,
  required,
}: {
  kind: 'receivable' | 'payable';
  partyId: unknown;
  value: string;
  onChange: (v: string) => void;
  label: string;
  required?: boolean;
}) {
  // 单位编号是空的不带（和原来拼地址时一样）
  const { data } = useFinRead(partyObligations(kind, String(partyId) || undefined));
  // 红字冲销的两笔不算未结清
  const rows = (data?.rows || []).filter((o) => !o.reversal_state && o.balance > 0);
  return (
    <select
      aria-label={label}
      required={required}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{data && !rows.length ? '这个单位没有未结清的单子' : '请选择'}</option>
      {rows.map((o) => (
        <option key={o.id} value={o.id}>
          {(o.source_number || o.description) +
            ' · ' +
            o.date +
            ' · 未结 ' +
            yuan(o.balance) +
            ' 元'}
        </option>
      ))}
    </select>
  );
}
/* ---------- 下拉选项 ---------- */
export function PartyPicker({
  kind,
  value,
  onChange,
  allowAll,
}: {
  kind: 'customer' | 'supplier';
  value: string;
  onChange: (v: string) => void;
  allowAll?: boolean;
}) {
  const options = useParties(kind);
  return (
    <div className="fin-party-picker">
      <Combobox
        ariaLabel={kind === 'customer' ? '选择客户' : '选择供应商'}
        placeholder={(allowAll ? '全部' : '选择') + (kind === 'customer' ? '客户' : '供应商')}
        value={value}
        options={options}
        onChange={onChange}
      />
      {allowAll && value && (
        <button className="icon-button" aria-label="清除单位筛选" onClick={() => onChange('')}>
          <X size={14} />
        </button>
      )}
    </div>
  );
}

/** 页面能选的税率口径：“不含税”和“未税”同义，页面只列未税 */
export const taxModeOptions = taxModes.filter((m) => m !== '不含税').map((m) => [m, m] as const);
