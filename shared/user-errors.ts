const fieldNames: Record<string, string> = {
  customerId: '客户',
  supplierId: '供应商',
  productId: '产品',
  stockId: '库存品',
  stockItemId: '库存档案',
  purchaseLineId: '采购明细',
  orderLineId: '销售明细',
  orderDate: '下单日期',
  deliveryDate: '交货日期',
  expectedDate: '预计到货日期',
  plannedDate: '计划日期',
  plannedTime: '计划时间',
  actualTime: '实际时间',
  quantity: '数量',
  issued: '领用数量',
  returned: '退料数量',
  goodQuantity: '实际良品',
  scrapQuantity: '实际废品',
  unit: '数量单位',
  unitPriceExact: '单价',
  unitPriceCents: '单价',
  unitPrice: '单价',
  priceExact: '参考单价',
  priceCents: '参考单价',
  dimensionUnit: '尺寸单位',
  length: '长度',
  width: '宽度',
  height: '高度',
  material: '材质配纸',
  flute: '楞型',
  name: '名称',
  notes: '备注',
  operator: '实际操作人员',
  expectedVersion: '记录版本',
  version: '记录版本',
  taxRate: '税率',
  taxMode: '含税口径',
  customerProductCode: '客户料号',
  requestId: '提交编号',
  acknowledged: '操作确认',
};
export function userError(message: string) {
  return message
    .replace(
      /\b(?:lines|items|materials|quantities)\.(\d+)\./g,
      (_, i) => '第' + (Number(i) + 1) + '项 ',
    )
    .replace(/\b[A-Za-z][A-Za-z0-9_]*\b/g, (s) => fieldNames[s] || s)
    .replace(
      /Invalid input: expected number, received (?:NaN|undefined|null|string)/g,
      '请填写有效数值',
    )
    .replace(
      /Invalid input: expected string, received (?:undefined|null|number)/g,
      '请填写文字内容',
    )
    .replace(/Invalid input: expected true/g, '请核对并确认操作')
    .replace(/Too small: expected string to have >=(\d+) characters/g, '至少需要$1个字符')
    .replace(/Too big: expected string to have <=(\d+) characters/g, '不能超过$1个字符');
}
