import { z } from 'zod';
import { fieldTitle } from '../core/index.js';
import { recordNames } from './labels.js';
export const dataManagementModules = [
  'customers',
  'products',
  'orders',
  'suppliers',
  'purchases',
  'stock_items',
  'arrival',
  'task',
  'production',
  'delivery',
] as const;
/**
 * 数据管理里不能新建的模块和原因：完工单只能经“登记完工”产生（一个入口，挂不挂任务都在那里），这里只能改、核对、撤销。
 * 服务端 server/admin/data-management-service.ts 拒收，界面 src/admin/DataManagementEditor.tsx 不显示“新建”。
 */
export const dataManagementNoCreate: Partial<Record<(typeof dataManagementModules)[number], string>> = {
  production: '登记完工请到生产页用“登记完工”。',
};
/** 模块名：和界面同一套叫法（shared/business/labels.ts） */
export const dataManagementNames: Record<string, string> = {
  ...recordNames,
  workspaces: 'AI识别工作区',
};
/**
 * 数据管理命令：改、归档、恢复、单据的确认、取消、撤销，新建。删除不在这里：页面和助手都走删除引擎
 * （POST /deletions/execute，助手 records.delete），影响范围、恢复快照、库存怎么处理都在那边。
 */
export const dataManagementCommandSchema = z.strictObject({
  requestId: z.uuid(),
  module: z.enum(dataManagementModules),
  action: z.enum(['create', 'update', 'archive', 'restore', 'confirm', 'cancel', 'reverse']),
  items: z
    .array(
      z.strictObject({ id: z.number().int().positive(), version: z.number().int().positive() }),
    )
    .max(100)
    .default([]),
  patch: z.record(z.string(), z.unknown()).default({}),
  patches: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  confirmDistinct: z.boolean().optional(),
  reason: z.string().trim().min(1).max(1000),
});
/**
 * 编辑窗里字段的中文名：栏目登记表（shared/core/field-names.ts）带单位的标题，和各编辑窗、详情一致；
 * 先按“上一层.字段”找（预估成本里的 material 不是材质），再按模块（单据的日期按单据种类叫），最后按字段。
 * 关联的客户、产品这些在编辑窗里是选择器，显示名称不显示编号；金额按元填（存的还是分，换算见
 * src/admin/DataManagementEditor.tsx 的 editableInput、submittedInput）。
 * 没登记的字段原样显示字段代码（tests/data-management-form.test.ts 守着每个可编辑字段都有中文名）。
 */
export function dataManagementFieldName(key: string, parent = '', module = '') {
  return fieldTitle(key, { record: module, parent }) || key;
}
