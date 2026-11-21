import type { Store } from '../core/index.js';
import type { Actor } from '../core/index.js';
import { AppError, reviewedAssistantGrant } from '../core/index.js';
import { dataManagementNoCreate, documentInfoFields, flowDocNames, flowInput, type FlowKind } from '../../shared/business/index.js';
import { createBusinessService } from '../business/index.js';
import type { OperationsService } from '../operations/index.js';
import { updateDocumentInfo, type FlowService } from '../flow/index.js';
import { inputSchemas, isFlowModule, recordSchemas, type ManagedModule } from './managed-records.js';
import { editedKeys, rejectedFields, unknownFields, type Current } from './input-fields.js';
import { rejectionText } from './field-rejection.js';
// 数据管理保存一条：先校验补丁里只有这个模块认得的字段，再交给各模块自己的保存服务（DataManagementService 用）。

/** 命令从哪来：数据管理窗口和借它的页面，或者人确认过的助手卡片 */
export type Origin = 'management-ui' | 'management-assistant';
/** 保存一条要的：哪个模块、谁办的（数据管理窗口发来的已标上入口）、从哪来，改的时候还有手里的那条（新建没有） */
type SaveContext = { module: ManagedModule; actor: Actor; origin: Origin; current?: Current };
/** 档案和订单走业务汇总的保存服务（客户、产品、订单）；供应商走采购库存，采购单、库存品走单据流转的保存入口 */
const businessWritable = ['customers', 'products', 'orders'] as const;
const isBusinessWritable = (module: string): module is (typeof businessWritable)[number] =>
  businessWritable.some((m) => m === module);

export class ManagedSaves {
  constructor(
    readonly store: Store,
    readonly ops: OperationsService,
    readonly flow: FlowService,
  ) {}
  /**
   * 保存一条（新建时 id 为空）：先按这个模块的录入规则校验，再查补丁里有没有它不收的栏目（不管在第几层：
   * 明细、纸板资料里多出来的一样拦，不然保存成功却悄悄少了这几项）。读出来的记录本来就带的栏目（已发数量、金额这类
   * 系统算出来的）照原样带回来放过，改了值或根本不认识的才拦。已生效的单据先看改了哪些录入的栏目（照原样带回的不算）：
   * 只改说明的走说明编辑，动了明细、日期这类的说请用更正（不说成改了算出来的栏目）。最后交给各模块自己的保存
   */
  save(
    { module, actor, origin, current }: SaveContext,
    id: number | undefined,
    input: Record<string, unknown>,
    patch: Record<string, unknown>,
  ) {
    if (isFlowModule(module)) flowInput(module, input);
    else recordSchemas[module].parse(input);
    const extra = new Set(unknownFields(patch, inputSchemas[module]).flatMap((p) => (p.length === 1 ? [p[0]] : [])));
    const edits = editedKeys(patch, current).filter((key) => !extra.has(key));
    const infoEdit = isFlowModule(module) && id ? this.infoEditOnly(module, id, edits) : false;
    const { changed, unknown } = rejectedFields(patch, inputSchemas[module], current?.record);
    if (changed.length || unknown.length) throw new AppError(rejectionText(module, { changed, unknown }));
    if (infoEdit && id) {
      const info = Object.fromEntries(edits.map((key) => [key, patch[key]]));
      return updateDocumentInfo(this.store, id, { expectedVersion: input.version, ...info }, actor);
    }
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
    if (module === 'purchases') return this.flow.stock.savePurchase(input, actor, id);
    if (module === 'stock_items') return this.flow.stock.saveItem(input, actor, id);
    return this.saveFlow(module, input, actor, id);
  }
  /**
   * 改单据之前先看能不能改：待核对的单据和生产任务照常改（返回 false）；已生效的到货、送货、完工单只改说明（备注这类）的
   * 走说明编辑（返回 true，批量改备注照常能用），改了明细、日期这类要用更正，整张没发生用撤销；
   * 已撤销、已取消、已被更正替代的不再改。edits 是改了的录入栏目（照原样带回的不算）。
   */
  private infoEditOnly(kind: FlowKind, id: number, edits: readonly string[]) {
    const doc = this.flow.get(id);
    if (doc.status === 'draft' || kind === 'task') return false;
    if (doc.status !== 'confirmed' || doc.replacedBy) throw new AppError('已撤销、已取消、已被更正替代的单据不能再改。', 409);
    const fields: readonly string[] = documentInfoFields[kind] ?? [];
    if (edits.every((key) => fields.includes(key))) return true;
    const name = flowDocNames[kind];
    throw new AppError('已生效的' + name + '改数量请用“更正' + name + '”，只改备注这类用“编辑”；这张单整张没发生用撤销。', 409);
  }
  /** 单据：新建（完工单不能在这里新建）、改待核对的单据和生产任务走单据保存 */
  private saveFlow(kind: FlowKind, input: Record<string, unknown>, actor: Actor, id: number | undefined) {
    const noCreate = dataManagementNoCreate[kind];
    if (!id && noCreate) throw new AppError(noCreate, 409);
    return id ? this.flow.save(kind, input, actor, id) : this.flow.save(kind, input, actor);
  }
}
