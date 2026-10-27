import { z } from 'zod';
import { customerSchema, productSchema, orderSchema } from '../../shared/domain.js';
import { Store, InputError } from '../db.js';
import { validAssistantGrant } from './assistant-approval.js';
import { isDeveloperActor } from '../developer-capability.js';
import type { Actor } from '../auth.js';

export const writableEntities = ['customers', 'products', 'orders'] as const;
export type WritableEntity = (typeof writableEntities)[number];
export type BusinessCommand =
  | { entity: WritableEntity; action: 'create'; input: unknown }
  | { entity: WritableEntity; action: 'update'; id: unknown; input: unknown };

// 上下文只能由后端建立，不能从请求正文、Excel 或模型输出读取。
export type WriteContext = {
  source: 'manual-ui' | 'ai' | 'import' | 'reviewed-assistant';
  approval?: object;
  operatorId: string | null;
  superAdminMode?: boolean;
  developerActor?: Actor;
};
export class BusinessAccessError extends Error {}
export class NotFoundError extends Error {}

export function createBusinessService(store: Store) {
  return {
    execute(command: BusinessCommand, context: WriteContext) {
      // 此通用接口不接受AI/导入来源。人工审核后的导入仅通过business/import-execution的绑定预览与事务入口。
      if (
        context.source !== 'manual-ui' &&
        !(
          context.source === 'reviewed-assistant' &&
          validAssistantGrant(context.approval, context.operatorId)
        )
      )
        throw new BusinessAccessError('AI 与批量导入写入尚未启用，请先完成账号权限、审核与审计。');
      const entity = z.enum(writableEntities).parse(command.entity);
      const action = z.enum(['create', 'update']).parse(command.action);
      const id =
        action === 'update'
          ? z.coerce
              .number()
              .int()
              .positive()
              .parse('id' in command ? command.id : undefined)
          : undefined;
      if (
        id &&
        !(entity === 'customers'
          ? store.customer(id, context.superAdminMode)
          : entity === 'products'
            ? store.product(id, context.superAdminMode)
            : store.order(id, context.superAdminMode))
      )
        throw new NotFoundError(entity === 'orders' ? '订单不存在' : '记录不存在');
      const version = id
        ? z.object({ version: z.number().int().positive() }).parse(command.input).version
        : undefined;
      switch (entity) {
        case 'customers':
          return store.saveCustomer(
            customerSchema.parse(command.input),
            id,
            version,
            context.superAdminMode,
          );
        case 'products':
          return store.saveProduct(
            productSchema.parse(command.input),
            id,
            version,
            context.superAdminMode,
          );
        case 'orders':
          return store.saveOrder(
            orderSchema.parse(command.input),
            id,
            version,
            context.superAdminMode,
            isDeveloperActor(context.developerActor),
          );
        default:
          throw new InputError('不支持的业务操作');
      }
    },
  };
}
