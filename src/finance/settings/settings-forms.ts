import type { SubmitValues } from '../form-values';
import { bpText, percentToBp } from '../percent';
import type { FinData } from '../fin-api';
import { chosen, filled, optionOf, type Option } from '../submit-pick';
import type { saveSettings, saveSubject } from './settings-api';

/* 财务设置、科目两个编辑窗：下拉的选项，和表单的值（SubmitValues）转成接口要的正文。 */

type Settings = FinData<'GET /finance/settings'>;
/** 科目表的一行 */
export type AccountRow = FinData<'GET /finance/accounts'>[number];

export const revenueOptions: readonly Option<'delivery' | 'invoice'>[] = [
  ['delivery', '送货时'],
  ['invoice', '开票时'],
];
export const costOptions: readonly Option<'output' | 'material'>[] = [
  ['output', '按产量'],
  ['material', '按材料'],
];
export const categories: readonly Option<'asset' | 'liability' | 'equity' | 'cost' | 'profit'>[] = [
  ['asset', '资产'],
  ['liability', '负债'],
  ['equity', '所有者权益'],
  ['cost', '成本'],
  ['profit', '损益'],
];
export const directions: readonly Option<'debit' | 'credit'>[] = [
  ['debit', '借'],
  ['credit', '贷'],
];
export const cashKinds: readonly Option<'cash' | 'bank'>[] = [
  ['cash', '现金'],
  ['bank', '银行'],
];
export const auxiliaries: readonly Option<'customer' | 'supplier' | 'department' | 'employee' | 'project'>[] = [
  ['customer', '客户'],
  ['supplier', '供应商'],
  ['department', '部门'],
  ['employee', '员工'],
  ['project', '项目'],
];
/** 小税种税率的几个字段：键和标签 */
export const rateFields = [
  ['smallVat', '小规模征收率 %'],
  ['urban', '城建税率 %'],
  ['education', '教育费附加率 %'],
  ['localEducation', '地方教育附加率 %'],
  ['income', '所得税率 %'],
] as const;
type RateKey = (typeof rateFields)[number][0];

/** 税率以基点存：填 “3” 或 “1.5”，转成 300、150。空着就是未设置，不猜默认值。 */
const toBp = (value: unknown) =>
  value === undefined || String(value).trim() === '' ? null : percentToBp(String(value), '税率');
export const fromBp = (bp: number | null) => (bp === null ? '' : bpText(bp));

/** 编辑窗里的初值 */
export const settingsInitial = (data: Settings) => ({
  revenueRecognition: data.revenueRecognition,
  costAllocation: data.costAllocation,
  requireSeparateApprover: data.requireSeparateApprover,
  agingDays: data.agingDays.join('、'),
  ...Object.fromEntries(rateFields.map(([k]) => [k, fromBp(data.taxRates[k])])),
});

/** 保存财务设置的正文；制单审核分开只有超级管理员能改（别人不带这一项） */
export function settingsBody(data: Settings, v: SubmitValues, isSuper: boolean): Parameters<typeof saveSettings>[0] {
  const rate = (k: RateKey) => toBp(v[k]);
  return {
    version: data.version,
    revenueRecognition: optionOf(v.revenueRecognition, revenueOptions),
    costAllocation: optionOf(v.costAllocation, costOptions),
    ...(isSuper ? { requireSeparateApprover: v.requireSeparateApprover === true } : {}),
    agingDays: String(v.agingDays ?? '')
      .split(/[、,，\s]+/)
      .filter(Boolean)
      .map(Number),
    taxRates: {
      smallVat: rate('smallVat'),
      urban: rate('urban'),
      education: rate('education'),
      localEducation: rate('localEducation'),
      income: rate('income'),
    },
  };
}

/** 新建（account 是 null）或编辑科目的正文；编辑的带上打开时的版本 */
export function subjectBody(account: AccountRow | null, v: SubmitValues): Parameters<typeof saveSubject>[0] {
  return {
    account: {
      code: filled(v.code, '编码'),
      name: filled(v.name, '名称'),
      category: chosen(v.category, categories, '类别'),
      direction: chosen(v.direction, directions, '方向'),
      cashKind: optionOf(v.cashKind, cashKinds) ?? null,
      auxiliary: optionOf(v.auxiliary, auxiliaries) ?? null,
      enabled: v.enabled === true,
    },
    ...(account ? { version: account.version } : {}),
  };
}
