import { z } from 'zod';
import {
  supplierSchema,
  purchaseSchema,
  purchaseLineSchema,
  stockItemSchema,
  receiptSchema,
  movementSchema,
} from '../../shared/operations.js';
type Column = [string, string];
function module(
  label: string,
  table: string,
  schema: z.ZodType,
  columns: Column[],
  rules: string[],
) {
  return {
    label,
    table,
    inputSchema: z.toJSONSchema(schema),
    fields: columns.map(([column, description]) => ({
      path: column,
      description,
      storage: table + '.' + column,
      dataType: column==='document'?'object|null': ['actor_id','source_id'].includes(column)||(column==='id'&&['stock_movements','purchase_receipts'].includes(table))?'string': /(_id|_units)$/.test(column) || ['id', 'version'].includes(column) ? 'integer' : 'string',
      access:
        column === 'id' || ['number','version','source_id','source_kind','delta_units','before_units','after_units','received_units','quantity_units'].includes(column) || /actor|created|updated/.test(column)
          ? ('system' as const)
          : ('input' as const),
      privacy: 'business' as const,
    })),
    matchingRules: rules,
  };
}
export const operationsMetadata = {
  suppliers: module(
    '供应商',
    'suppliers',
    supplierSchema,
    [
      ['id', '供应商稳定编号'],
      ['name', '供应商名称，必填，不自动合并同名单位'],
      ['contact', '联系人，可空'],
      ['phone', '联系电话，可空'],
      ['address', '地址，可空'],
      ['notes', '备注，可空'],
      ['version', '编辑版本号'],
      ['created_at', '建立时间'],
    ],
    ['名称相似不代表同一供应商；停用保留历史采购。'],
  ),
  purchases: module(
    '瓦楞纸板采购',
    'purchases',
    purchaseSchema,
    [
      ['id', '采购内部编号'],
      ['number', '系统生成采购单号'],
      ['supplier_id', '引用供应商id，不得伪造'],
      ['supplier_name', '采购时供应商名称快照'],
      ['customer_order_id', '关联客户订单id或null，允许独立采购'],
      ['order_date', '采购日期'],
      ['expected_date', '预计到货日期或null'],
      ['status', '持久化原有业务状态，API businessStatus返回；arrivalProgress及arrivalSummary由后端有效到货计算，status保留旧接口兼容展示'],
      ['notes', '备注'],
      ['version', '编辑/到货版本'],
      ['created_at', '建立时间'],
      ['updated_at', '最后修改时间'],
    ],
    [
      '采购只管理外购瓦楞纸板，不是客户订单或生产工单。',
      '到货后锁定供应商、日期和明细，取消仅取消未到货部分，不回退库存。',
    ],
  ),
  purchase_lines: module(
    '采购明细',
    'purchase_lines',
    purchaseLineSchema,
    [
      ['id', '明细编号'],
      ['purchase_id', '所属采购单'],
      ['stock_item_id', '明确选择的原材料库存品，或首次到货建立后关联'],
      [
        'document',
        '纸板名称、规格、长宽高/单位、楞型、配纸、数量单位、十进制单价与备注；缺尺寸和价格允许空',
      ],
      ['quantity_units', '订货数量的千分之一单位整数，1=0.001数量单位'],
      ['received_units', '有效到货总量千分单位缓存（非合格/实际入库数量）；与历史独立收货和已确认arrival去重并叠加明确管理员统计纠偏一致。remainingQuantity、arrivalStatus、receivedAmount后端派生；实际库存单独按stockedQuantity流水计算'],
    ],
    [
      '只能通过采购整体保存；数量单位必须与库存单位一致；尺寸mm/cm等值换算不代表张、只等数量单位可换算。',
    ],
  ),
  stock_items: module(
    '库存品',
    'stock_items',
    stockItemSchema,
    [
      ['id', '库存品稳定编号'],
      ['name', '库存品名称'],
      ['kind', 'raw=外购瓦楞纸板，finished=成品纸箱'],
      ['unit', '明确的数量单位，不猜测或跨单位累计'],
      ['document', '规格说明、长宽高、mm/cm或未知单位、楞型、配纸和备注'],
      ['product_id', '成品可关联产品id或null，原材料不关联成品产品'],
      ['version', '每次编辑或库存变动递增版本'],
      ['created_at', '建立时间'],
    ],
    [
      '库存余额=不可变流水delta_units之和；禁止直接写余额。',
      '已有引用时不能更改实际规格或数量单位。',
    ],
  ),
  purchase_receipts: module(
    '采购分批到货',
    'purchase_receipts',
    receiptSchema,
    [
      ['id', '到货批次UUID'],
      ['purchase_id', '关联采购单'],
      ['reference', '送货单号/批次号，同一采购单唯一'],
      ['date', '实际到货日期'],
      ['document', '旧入口独立批次；flowId关联arrival时仅为采购投影不能重复计数；保留版本、原单、冲销、替代和原因'],
      ['actor_id', '真实登录操作者编号'],
      ['actor_name', '操作者名称快照'],
      ['created_at', '实际记录时间'],
    ],
    ['正式更正使用purchase.receipt.preview/correct，复用页面服务；同一事务追加替代及冲销流水并重算累计到货，不修改原订购量/合同金额。requestId幂等、版本及库存校验，原批次身份合法复用。',
      '真实本机最高管理员可显式选择data-edit，仅通过purchase.receipt.data_edit_preview/data_edit及同一更正表单修正有效到货统计。原单和库存流水不变，business_audit的receipt-data-edit不可变记录保存原因、操作者、时间、原新值。receiptEvents统一派生有效数量和待核对差异；不通过伪造入库或删除历史消除差异。后续正式更正按原始入库数量计算库存影响并消除相应差异。'],
  ),
  stock_movements: module(
    '出入库流水',
    'stock_movements',
    movementSchema,
    [
      ['id', '流水UUID'],
      ['item_id', '关联库存品'],
      ['action', 'in入库/out出库/adjust盘点/purchase采购到货'],
      ['delta_units', '千分单位有符号变动量'],
      ['before_units', '操作前余额'],
      ['after_units', '操作后余额，不能负库存'],
      ['source_kind', 'manual或purchase_receipt，后端确定'],
      ['source_id', '到货批次UUID或null'],
      ['purchase_line_id', '采购来源明细或null'],
      ['customer_order_id', '可关联客户订单或null'],
      ['date', '业务日期'],
      ['notes', '出入库用途或盘点原因'],
      ['actor_id', '真实登录用户编号'],
      ['actor_name', '用户名称快照'],
      ['created_at', '记录时间'],
    ],
    [
      '不可编辑/删除流水；盘点提交实际余额，程序产生差额流水。',
      '流水页面按业务date字段查询，默认最近两自然月且含首尾当天；支持仓库/变动类型/关键词组合。旧记录仅隐藏，可用全部日期查看，不自动删除或归档，库存余额始终使用全部流水。',
      '库存变动必须经已注册业务服务；正式到货更正使用purchase.receipt.correct复用人工服务，保留原始、冲销及替代流水；不允许模型直接编辑库存余额或流水。',
    ],
  ),
};
