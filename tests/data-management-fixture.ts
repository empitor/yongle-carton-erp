// 数据管理测试共用的准备：本机最高管理员、一条命令、一个客户一个产品一张订单、把服务端退回的错误照页面显示的样子转成中文。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { z, ZodError } from 'zod';
import { Store } from '../server/core/db.js';
import { localAdministratorActor } from '../server/core/local-administrator.js';
import { DataManagementService } from '../server/admin/data-management-service.js';
import { customerSchema, productSchema, orderSchema } from '../shared/core/domain.js';
import { userError } from '../shared/core/user-errors.js';
import { errorMessage } from '../shared/core/error-message.js';
import { superActor } from './assistant-fixture.js';

export const owner = () => localAdministratorActor(superActor());
/**
 * 命令结果里的第一条：各模块保存、单据流转给的那一行原样交回来（服务端的类型是各种记录的联合，重放时是存下的 JSON）。
 * 测试按“对象、带编号，明细是一行行对象”读出来，字段值交给断言去比。
 */
const resultRow = z.looseObject({
  id: z.number(),
  lines: z.array(z.looseObject({ id: z.number().optional() })).default([]),
});
export const firstResult = (response: { results: readonly unknown[] }) => resultRow.parse(response.results[0]);
/** 识别文件命令结果里的第一份：办成没有；办成的给识别文件（编号、版本，删除的没有版本） */
const workspaceRow = z.object({
  success: z.boolean(),
  result: z.looseObject({ id: z.string(), revision: z.number().optional() }).optional(),
});
export const firstWorkspace = (response: { results: readonly unknown[] }) => workspaceRow.parse(response.results[0]);
/** 一条数据管理命令：items 取每条记录的编号和版本，patch 原样交给服务端（按模块的规则校验，测试会故意给坏的） */
export const command = (module: string, action: string, items: readonly CommandItem[] = [], patch: unknown = {}) => ({
  requestId: randomUUID(),
  module,
  action,
  items: items.map(({ id, version }) => ({ id, version })),
  patch,
  reason: '虚构维护验收',
});
type CommandItem = { id: number | string; version?: number | string | null };
export function basics() {
  const store = new Store(':memory:'),
    service = new DataManagementService(store),
    who = owner();
  const customer = store.saveCustomer(customerSchema.parse({ name: '虚构开发客户' })),
    product = store.saveProduct(productSchema.parse({ name: '虚构开发纸箱' }));
  const order = store.saveOrder(
    orderSchema.parse({
      customerId: customer.id,
      orderDate: '2026-10-01',
      deliveryDate: '2026-10-27',
      status: '已发货',
      lines: [{ productId: product.id, quantity: 100, unitPriceCents: 123 }],
    }),
  );
  return { store, service, who, customer, product, order };
}

/**
 * 人看到的话：数据管理窗口发的命令校验没过时，服务端已经按编辑窗的叫法写成中文整句（data-management-service 的 readableIssues）；
 * 原始校验错误（助手发的）照 server/app.ts 写成“字段路径: 提示”再用 userError 转中文
 */
export function shownError(run: () => unknown) {
  try {
    run();
  } catch (e: unknown) {
    return userError(e instanceof ZodError ? e.issues.map((i) => i.path.join('.') + ': ' + i.message).join('；') : errorMessage(e));
  }
  assert.fail('应当被拦下');
}
