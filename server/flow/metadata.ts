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
      reference: '供应商送货单号/到货批次，供应商内唯一',
      sourceId: '原始文件UUID或null，后端保留原字节和SHA-256',
      lines:
        '多种纸板：stockId关联原料；purchaseLineId可空；item记录名称、规格、长宽、mm/cm、材质、楞型；quantity为实收整张；statedQuantity/area为单据原值；unitPrice最多四位小数；priceBasis为area/quantity；differenceReason记录差异',
    },
  ],
  [
    'production_tasks',
    '生产任务',
    taskSchema,
    {
      productId: '引用产品档案',
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
      lines:
        '多产品/多订单；orderId/orderLineId关联稳定订单明细，stockId引用同产品规格及单位成品，quantity为本次发货数量，notes独立备注',
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
          correctionOf: '更正引用原已冲销单据，仅超级模式可用',
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
      permission: 'business:edit；冲销需要已验证密码的超级管理员模式',
      aiEnabled: false,
      states: ['draft', 'confirmed', 'cancelled', 'reversed'],
      rules: [
        '草稿不影响库存；预览绑定用户、会话、版本、来源哈希、完整计划摘要和10分钟有效期',
        '确认、单据、库存流水、进度与审计同一数据库事务；请求幂等',
        '确认后不直接编辑或删除，只通过权限核验的冲销与显式更正草稿，保留原始记录',
      ],
    },
  ]),
);
