import type { PromptPreset } from '../../../shared/ai/index.js';

// 订单识别的默认规则：只放表上放不下的——本公司是谁、各家原件的写法习惯。栏目怎么填写在表上（shared/import/order-form.ts）。
const rules: [string, string][] = [
  [
    '买卖双方',
    '本公司是宁波甬勒包装制品有限公司，通常是供应方（乙方），采购方（甲方）是客户。按合同里的实际角色判断，不能只看名称写在哪个位置。',
  ],
  [
    '产品名称、规格和备注',
    '按值的意思填，不照搬原表的列名：原表把存货名称叫“规格”、把尺寸写在“备注”列的，名称、尺寸照样分开填。名称里的英文字母、数字和空格原样保留，不在中英文之间加减空格。',
  ],
  [
    '含税合同的单价和金额',
    '原表同时有“单价（含税）”“金额（不含税）”“税额”“价税合计”时：单价填含税单价，原文行金额填价税合计，含税／未税填含税，税率照原文；不含税金额和税额写进明细备注，不拿它们改单价。只有未税金额、没有含税单价或价税合计时，单价和金额都列进“拿不准”。',
  ],
];

/** 默认条目的编号：固定前缀接 12 位序号，序号从 10 起 */
const ENTRY_NUMBER_FROM = 10;
const ENTRY_NUMBER_DIGITS = 12;
function preset(entries: [string, string][]): PromptPreset {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    name: '标准纸箱订单识别',
    entries: entries.map(([name, content], i) => ({
      id: `00000000-0000-4000-8000-${String(i + ENTRY_NUMBER_FROM).padStart(ENTRY_NUMBER_DIGITS, '0')}`,
      name,
      content,
      enabled: true,
    })),
  };
}

// 只有这些规则能在设置里改；表、固定口径和后端校验不受它们影响。
export function defaultPromptPreset(): PromptPreset {
  return preset(rules);
}
