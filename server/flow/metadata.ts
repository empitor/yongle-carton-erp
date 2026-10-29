import { z } from 'zod';
import {
  arrivalSchema,
  taskSchema,
  productionSchema,
  deliverySchema,
} from '../../shared/physical-flow.js';
const definitions = [
  [
    'arrivals',
    '采购到货单',
    arrivalSchema,
    {
      supplierId: '引用供应商，收货方为本工厂',
      isPlan: 'true为待到货计划，不计实收/库存，禁止直接确认入库；实际收货转为false并保留planSnapshot',
      plannedDate: '到货计划预计日期；与实际到货date独立',
      plannedTime: '预计时间HH:mm或null，不伪造未知时间',
      actualTime: '实际到货时间HH:mm或null，历史无记录保持null，不能使用createdAt冒充',
      reference: '供应商送货单号/到货批次，供应商内唯一',
      sourceId: '原始文件UUID或null，后端保留原字节和SHA-256',
      lines:
        '多产品：stockId关联原料，purchaseLineId关联采购；quantity是本批实收总量，acceptedQuantity+rejectedQuantity=quantity，stockedQuantity<=acceptedQuantity；库存只增加stockedQuantity，采购累计按有效quantity。未填新验收默认全部合格入库，历史无验收字段为null；不混合数量单位，纸板按整张。item保留规格/材质/单位；unitPrice四位，priceBasis面积或数量，differenceReason记录差异',
    },
  ],
  [
    'production_tasks',
    '生产任务',
    taskSchema,
    {
      productId: '引用产品档案',
      plannedTime: '计划生产时间HH:mm，可留空；不登记实绩',
      plannedDate: '计划生产日期YYYY-MM-DD；历史缺失时沿用原date并明确标识。仅排程，不代表实际生产；实际开始/完工日期由已确认生产登记派生',
      quantity:
        '计划产量，非材料消耗；累计合格数达到计划数才算完工，百分比向下取整，禁止四舍五入提前完工',
      unit: '成品计量单位，关联生产登记必须一致',
      orderIds: '零个或多个客户订单，必须包含当前产品；不强制采购一对一关联',
    },
  ],
  [
    'production_records',
    '每日生产登记',
    productionSchema,
    {
      taskId: '可空，关联已确认生产任务',
      productId: '本次生产产品',
      finishedStockId: '与产品关联的成品库存品',
      materials: '每种材料登记stockId、issued实际整张领料、returned退料；净耗用=领料-退料',
      goodQuantity: '实际合格成品入库数量，不从面积或纸板数推算',
      scrapQuantity: '损耗报废成品数量，仅质量记录，不重复扣材料',
      operator: '实际生产人员，与登录提交人分别记录',
    },
  ],
  [
    'deliveries',
    '客户送货单',
    deliverySchema,
    {
      customerId: '客户档案编号，全部订单须属于该客户',
      plannedTime: '预计送货时间HH:mm，可未知；不代表实际送货',
      actualTime: '实际送货时间HH:mm，未知保留null；仅已确认单据为实际发货',
      plannedDate: '计划送货日期YYYY-MM-DD；历史缺失时沿用原date。可通过flow.schedule调整未发货草稿，实际日期date仅确认发货时生效',
      lines:
        '多产品/多订单；orderId/orderLineId关联稳定订单明细，stockId引用同产品规格及单位成品，quantity为本次发货数量，notes独立备注；正式核验保存产品、规格、客户料号、我方/客户订单号、单价及本批精确金额快照。历史缺少价格快照时导出显示未记录，不用当前合同价补写',
      allowOverdelivery: '默认false，仅已验证超级管理员可批准超订单数量；仍禁止负库存',
      overdeliveryReason: '超量原因，审批必填',
    },
  ],
] as const;
export const flowMetadata = Object.fromEntries(
  definitions.map(([id, label, schema, fields]) => [
    id,
    {
      label,
      table: 'flow_documents',
      inputSchema: z.toJSONSchema(schema),
      fields: [
        ...Object.entries({
          id: '稳定单据编号',
          kind: 'arrival/task/production/delivery类型',
          number: '系统单据号',
          date: '业务日期',
          status: '草稿/确认/取消/冲销状态',
          version: '乐观锁版本',
          document: '类型专属字段与业务快照JSON',
          actor_id: '实际登录登记者编号',
          actor_name: '登记者名称快照',
          created_at: '创建时刻',
          updated_at: '更新时刻',
        }).map(([path, description]) => ({
          path,
          description,
          storage: 'flow_documents.' + path,
          dataType: ['id', 'version'].includes(path) ? 'integer' : 'string',
          access: 'system',
          privacy: 'business',
        })),
        ...Object.entries({
          date: '实际业务日期YYYY-MM-DD',
          notes: '整单备注',
          correctionOf: '更正引用原已冲销单据；采购到货数量更正由purchase.receipt.correct按business:edit自动建立完整链，其他手工更正草稿沿原权限',
          ...fields,
        }).map(([path, description]) => ({
          path,
          description,
          storage: 'flow_documents.document',
          access: 'input',
          privacy: 'business',
          dataType: 'string|array|object|null',
        })),
      ],
      relations: 'flow_refs通过真实外键保留客户、供应商、产品、采购、客户订单/明细、库存和任务关系',
      permission: 'business:edit；采购到货数量正式更正与人工页面共用权限，无AI专属确认；单独冲销沿原超级管理员权限',
      aiEnabled: false,
      assistantTools: id === 'arrivals' ? ['arrival.plans', 'arrival.plan.save', 'arrival.receive', 'arrival.records', 'purchase.receipt.preview', 'purchase.receipt.correct', 'purchase.receipt.data_edit_preview', 'purchase.receipt.data_edit'] : [],
      states: ['draft', 'confirmed', 'cancelled', 'reversed'],
      rules: [
        '草稿不影响库存；预览绑定用户、会话、版本、来源哈希、完整计划摘要和10分钟有效期',
        '新实际到货统一经FlowService确认，旧OperationsService.receive委托同一事务，不再独立直接入库；purchase_receipts.flowId只是投影。到货记录统一读取receiptEvents，历史独立凭据只读兼容不补库存、不伪造时间/验收',
        '到货计划复用arrival草稿，同采购可分批，计划转实收使用原单据身份并由服务保存planSnapshot；正式更正保留计划关联及完整历史，不创建第二套计划数据库',
        '确认、单据、库存流水、进度与审计同一数据库事务；请求幂等',
        '确认后不直接编辑或删除，只通过权限核验的冲销与显式更正草稿，保留原始记录',
        '采购到货数量正式更正使用purchase.receipt.preview/correct，在单一事务追加冲销和替代流水、重算采购累计及库存并保留原批次/文件身份；不覆盖原始流水',
        '管理员历史到货数据编辑使用purchase.receipt.data_edit_preview/data_edit，真实本机会话能力校验；仅更新有效到货统计，审计保留原新值、原因、操作者及差异，库存不变',
        '生产与送货plannedDate为独立计划日期，flow.schedule与页面同服务按版本/权限/幂等事务更新；排程不产生实际生产、发货或库存',
      ],
    },
  ]),
);
