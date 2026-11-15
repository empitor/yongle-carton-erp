/* 记账模板（fin_templates）给人看的叫法，和送货、到货模板往来科目的限制：页面和服务端校验用同一份。 */

/** 模板名 → 叫法（tests/finance-settings.test.ts 比对建库预置的每个模板） */
export const templateTitles: Record<string, string> = {
  'delivery.confirmed': '送货确认',
  'arrival.confirmed': '到货暂估',
  'settlement.discount': '现结优惠',
  deposit: '保证金',
  interest: '压款利息',
  notes: '承兑票据',
  bad_debt: '坏账',
  expense: '费用报销',
  asset: '固定资产',
  payroll: '工资',
  inventory: '存货和成本',
};

/** 每个模板里各用途 → 叫法 */
export const templateFieldTitles: Record<string, Record<string, string>> = {
  'delivery.confirmed': { party: '往来（应收）', net: '收入', tax: '销项税额' },
  'arrival.confirmed': { party: '往来（应付）', net: '入库成本' },
  'settlement.discount': { fee: '优惠计入' },
  deposit: { paid: '交出的保证金', received: '收到的保证金' },
  interest: { fee: '利息计入' },
  notes: { receivable: '收到的承兑汇票', payable: '开出的承兑汇票' },
  bad_debt: { expense: '坏账损失' },
  expense: { liability: '报销款' },
  asset: { asset: '固定资产原值', depreciation: '累计折旧', disposal: '固定资产清理', gain: '处置收益', loss: '处置损失' },
  payroll: { wages: '应发工资', social: '社保', housing: '公积金', tax: '个税' },
  inventory: { raw: '原材料', finished: '库存商品', material: '生产领料', sales: '销售成本', adjustment: '盘点差异' },
};

/**
 * 送货、到货生成的凭证里往来科目（party）只能是应收账款（1122）、应付账款（2202）或它们的下级：
 * 对账单、账龄、收付款核销、票据、发票都按这两个科目算，改成别的科目两边就对不上。
 */
export const templatePartyAccounts: Record<string, { code: string; name: string }> = {
  'delivery.confirmed': { code: '1122', name: '应收账款' },
  'arrival.confirmed': { code: '2202', name: '应付账款' },
};
