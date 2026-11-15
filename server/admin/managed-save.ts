import type { Store } from '../core/index.js';
import type { Actor } from '../core/index.js';
import { AppError, reviewedAssistantGrant } from '../core/index.js';
import { dataManagementNoCreate, flowDocNames, flowInput, type FlowKind } from '../../shared/business/index.js';
import { createBusinessService } from '../business/index.js';
import type { OperationsService } from '../operations/index.js';
import { documentInfoFields, updateDocumentInfo, type FlowService } from '../flow/index.js';
import { isFlowModule, recordSchemas, type ManagedModule } from './managed-records.js';
// 数据管理保存一条：先校验补丁里只有这个模块认得的字段，再交给各模块自己的保存服务（DataManagementService 用）。

/** 命令从哪来：数据管理窗口和借它的页面，或者人确认过的助手卡片 */
export type Origin = 'management-ui' | 'management-assistant';
/** 保存一条要的：哪个模块、谁办的（数据管理窗口发来的已标上入口）、从哪来 */
type SaveContext = { module: ManagedModule; actor: Actor; origin: Origin };
/** 档案和订单走业务汇总的保存服务（客户、产品、订单）；供应商、采购单、库存品走采购库存 */
const businessWritable = ['customers', 'products', 'orders'] as const;
const isBusinessWritable = (module: string): module is (typeof businessWritable)[number] =>
  businessWritable.some((m) => m === module);

export class ManagedSaves {
  constructor(
    readonly store: Store,
    readonly ops: OperationsService,
    readonly flow: FlowService,
  ) {}
  /** 保存一条（新建时 id 为空）：先校验补丁里只有这个模块认得的字段，再交给各模块自己的保存 */
  save(
    { module, actor, origin }: SaveContext,
    id: number | undefined,
    input: Record<string, unknown>,
    patch: Record<string, unknown>,
  ) {
    const normalized = isFlowModule(module) ? flowInput(module, input) : recordSchemas[module].parse(input);
    const unknownKeys = Object.keys(patch).filter((key) => !Object.hasOwn(normalized, key));
    if (unknownKeys.length)
      throw new AppError(
        '不支持修改字段：' + unknownKeys.join('、') + '。库存数量请登记盘点，状态请使用确认/冲销操作。',
      );
    if (isBusinessWritable(module))
      return createBusinessService(this.store).execute(
        id ? { entity: module, action: 'update', id, input } : { entity: module, action: 'create', input },
        {
          source: origin === 'management-assistant' ? 'reviewed-assistant' : 'manual-ui',
          ...(origin === 'management-assistant'
            ? { approval: reviewedAssistantGrant(actor.id) }
            : {}),
          operatorId: actor.id,
          superAdminMode: true,
          actor,
        },
      );
    if (module === 'suppliers') return this.ops.saveSupplier(input, actor, id);
    if (module === 'purchases') return this.ops.savePurchase(input, actor, id);
    if (module === 'stock_items') return this.ops.saveItem(input, actor, id);
    return this.saveFlow(module, input, actor, id, patch);
  }
  /**
   * 单据：新建、改待核对的单据和生产任务走单据保存；已生效的到货、送货、完工单只改说明（备注这类）的走说明编辑
   * （批量改备注照常能用），改数量、日期这类要用更正，整张没发生用撤销；已撤销、已取消、已被更正替代的不再改。
   */
  private saveFlow(
    kind: FlowKind,
    input: Record<string, unknown>,
    actor: Actor,
    id: number | undefined,
    patch: Record<string, unknown>,
  ) {
    const noCreate = dataManagementNoCreate[kind];
    if (!id && noCreate) throw new AppError(noCreate, 409);
    if (!id) return this.flow.save(kind, input, actor);
    const doc = this.flow.get(id);
    if (doc.status === 'draft' || kind === 'task') return this.flow.save(kind, input, actor, id);
    if (doc.status !== 'confirmed' || doc.replacedBy) throw new AppError('已撤销、已取消、已被更正替代的单据不能再改。', 409);
    const fields: readonly string[] = documentInfoFields[kind] ?? [];
    if (Object.keys(patch).every((key) => fields.includes(key)))
      return updateDocumentInfo(this.store, id, { expectedVersion: input.version, ...patch }, actor);
    const name = flowDocNames[kind];
    throw new AppError('已生效的' + name + '改数量请用“更正' + name + '”，只改备注这类用“编辑”；这张单整张没发生用撤销。', 409);
  }
}
