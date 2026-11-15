import { percentToBp } from '../percent';
import type { Field, SubmitValues } from '../form-values';

/* 新建固定资产窗口的字段表和提交内容。 */

export const assetSections = [
  { title: '什么资产', columns: 2 as const },
  { title: '值多少、用多久', columns: 2 as const },
  { title: '怎么记账', columns: 2 as const },
];

export const assetFields: Field[] = [
  { name: 'number', label: '编号', required: true, section: '什么资产' },
  { name: 'name', label: '名称', required: true, section: '什么资产' },
  { name: 'category', label: '类别', required: true, section: '什么资产', placeholder: '例如 设备、车辆' },
  { name: 'department', label: '部门', required: true, section: '什么资产' },
  { name: 'date', label: '入账日期', type: 'date', required: true, section: '值多少、用多久' },
  { name: 'original', label: '原值', type: 'money', required: true, section: '值多少、用多久' },
  { name: 'months', label: '使用月数', type: 'int', required: true, section: '值多少、用多久' },
  {
    name: 'residual',
    label: '残值率 %',
    required: true,
    section: '值多少、用多久',
    hint: '例如 5，没有残值填 0',
  },
  { name: 'expenseAccount', label: '折旧费用科目', type: 'account', required: true, section: '怎么记账' },
  { name: 'counterAccount', label: '付款科目', type: 'account', required: true, section: '怎么记账' },
  {
    name: 'cashFlow',
    label: '现金流量项目',
    type: 'cash-flow',
    required: true,
    section: '怎么记账',
    span: 'full',
  },
];

/** 残值率按百分比填，存万分比：5 → 500，2.5 → 250 */
export const assetBody = ({ residual, ...values }: SubmitValues) => ({
  ...values,
  residualBp: percentToBp(String(residual ?? '0'), '残值率'),
});
