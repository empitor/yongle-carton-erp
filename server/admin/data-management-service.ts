import { randomUUID } from 'node:crypto';
import { z, ZodError } from 'zod';
import type { Store } from '../core/index.js';
import type { Actor } from '../core/index.js';
import { requireLocalAdministrator } from '../core/index.js';
import {
  dataManagementCommandSchema,
  dataManagementModules,
  dataManagementTemplate,
  flowEntity,
} from '../../shared/business/index.js';
import { isRecord, productPricePatch, today } from '../../shared/core/index.js';
import { managementCommandSchema } from '../../shared/admin/index.js';
import { audit, viaEntry } from '../core/index.js';
import { archivedOrConflict, changeLifecycle } from '../lifecycle/index.js';
import { OperationsService } from '../operations/index.js';
import { FlowService, archiveFlowDocuments } from '../flow/index.js';
import { AppError, failureMessage } from '../core/index.js';
import { exists, inSavepoint, operationRequest, replayRequest, saveRequest } from '../core/index.js';
import { orderLinesPriceEdit, readableIssues, wholeRecordWithout } from './record-edit-rules.js';
import { ManagedRecords, isFlowModule, type Listed, type ManagedModule, type Selected } from './managed-records.js';
import { ManagedSaves, type Origin } from './managed-save.js';

/** 页面发来的命令（managementCommandSchema，多认一项 entry）；助手的按 dataManagementCommandSchema，没有这一项 */
type Command = z.infer<typeof managementCommandSchema>;
/** 数据管理列表：模块、新建模板、每条记录（显示用的 record 和编辑窗用的 input） */
type Managed<M extends ManagedModule = ManagedModule> = {
  module: M;
  template: ReturnType<typeof dataManagementTemplate<M>>;
  records: Listed<M>[];
};
/** 一次命令：校验过的命令、办事的账号（数据管理窗口发来的已标上入口）、从哪来 */
type Run = { v: Command; actor: Actor; origin: Origin };
/** 选中的一条：编号和看到时的版本 */
type Item = Command['items'][number];
/**
 * 上次办完的结果（同一请求再来时原样交回）：模块、动作、条数，和每条的结果
 * （各模块保存、单据流转、归档给的，原样存成 JSON，这里只核对是 JSON，不再逐种核对）
 */
const priorResult = z.object({
  module: z.enum(dataManagementModules),
  action: dataManagementCommandSchema.shape.action,
  count: z.number().int().nonnegative(),
  results: z.array(z.json()),
});
/** 数据管理命令收到删除时的说法：删除只有删除功能一条路（页面的删除窗、助手的删除命令，都先看会一起处理的记录） */
const DELETE_ELSEWHERE = '数据管理命令不办删除，删除请用删除功能（先看会一起处理的记录，再确认删除）。';
/** 审计挂在哪张表上：单据记 flow_<模块>（和单据流转、删除记的一样，单据的修改历史按它查），别的模块就是表名 */
const auditEntity = (module: ManagedModule) => (isFlowModule(module) ? flowEntity(module) : module);

export class DataManagementService {
  readonly ops: OperationsService;
  readonly flow: FlowService;
  /** 读记录（列表、选中的几条） */
  readonly records: ManagedRecords;
  /** 保存一条（各模块自己的保存服务） */
  readonly saves: ManagedSaves;
  constructor(readonly store: Store) {
    this.ops = new OperationsService(store);
    this.flow = new FlowService(store);
    this.records = new ManagedRecords(store, this.flow);
    this.saves = new ManagedSaves(store, this.ops, this.flow);
  }
  /** 一个模块的新建模板和全部记录（含归档的）；模块写死的调用拿到这个模块的记录类型 */
  list<M extends ManagedModule>(module: M, who: Actor | null | undefined): Managed<M>;
  list(module: string, who: Actor | null | undefined): Managed;
  list(module: string, who: Actor | null | undefined): Managed {
    requireLocalAdministrator(who);
    const checked = z.enum(dataManagementModules).parse(module);
    return {
      module: checked,
      template: dataManagementTemplate(checked, today()),
      records: this.records.list(checked),
    };
  }
  /**
   * 执行一条数据管理命令：在一个事务里逐条办（create、applyAction），每条记审计，最后查外键、存防重放回执。
   * 同一请求编号再来原样返回。删除不在这里（命令结构里没有 delete），页面和助手都走删除引擎的 /deletions/execute。
   */
  execute(
    raw: unknown,
    who: Actor | null | undefined,
    binding: string,
    origin: Origin = 'management-ui',
  ) {
    const admin = requireLocalAdministrator(who);
    // 删除不在命令结构里：直接调接口带 delete 的，说一句中文告诉去哪删，不回英文的校验原文
    if (isRecord(raw) && raw.action === 'delete') throw new AppError(DELETE_ELSEWHERE);
    const v: Command = (origin === 'management-ui' ? managementCommandSchema : dataManagementCommandSchema).parse(raw);
    // 从数据管理窗口发来的（只有页面发来的命令认这个标记，助手的命令里没有这一项，带了也被拒收）：
    // 数据管理这个入口在这里标上，下层服务（单据流转、归档……）记的审计也都是数据管理；助手发来的账号已由助手入口标好
    const actor = v.entry ? viaEntry(admin, v.entry) : admin;
    if (!binding) throw new AppError('会话无效。', 403);
    if ((v.action === 'create') !== !v.items.length)
      throw new AppError('创建不选择旧记录，其他操作必须明确选定记录。');
    if (new Set(v.items.map((i) => i.id)).size !== v.items.length) throw new AppError('记录重复。');
    // 查和办分开：同号的重试、换了内容的拒绝不算办失败，不记失败审计
    const request = operationRequest('data-management', v.requestId, actor, { origin, ...v }, binding);
    const prior = replayRequest(this.store, request, priorResult);
    if (prior !== undefined) return prior;
    const run: Run = { v, actor, origin };
    try {
      return inSavepoint(this.store.db, () => {
        const response = this.runCommand(run);
        saveRequest(this.store, request, response);
        return response;
      });
    } catch (e) {
      throw this.failed(run, e);
    }
  }
  /** 新建一条，或对选中的每一条办这条命令（各记一条审计）；最后查外键 */
  private runCommand(run: Run) {
    const { v } = run;
    const results = v.action === 'create' ? [this.create(run)] : this.applyAll(run);
    if (exists(this.store.db, 'PRAGMA foreign_key_check'))
      throw new AppError('关联校验失败，全部回滚。', 409);
    return { module: v.module, action: v.action, count: results.length, results };
  }
  /** 新建一条，审计挂在新记录上 */
  private create(run: Run) {
    const { v, actor, origin } = run;
    const created = this.saves.save(
      { module: v.module, actor, origin, confirmDistinct: v.confirmDistinct },
      undefined,
      v.patch,
      v.patch,
    );
    audit(this.store, actor, {
      action: v.action,
      entity: auditEntity(v.module),
      id: created.id,
      document: { reason: v.reason, result: created, requestId: v.requestId, origin },
    });
    return created;
  }
  /** 对选中的每一条办这条命令：看到时的版本对不上就整批拒绝；每条记审计（改之前的样子和结果） */
  private applyAll(run: Run) {
    const { v, actor, origin } = run;
    const all = this.records.selected(
      v.module,
      v.items.map((i) => i.id),
    );
    return v.items.map((item) => {
      const selected = all.get(item.id);
      if (!selected || selected.record.version !== item.version)
        throw new AppError('记录已变化，请刷新。', 409);
      const result = this.applyAction(run, item, selected);
      audit(this.store, actor, {
        action: v.action,
        entity: auditEntity(v.module),
        id: item.id,
        document: { reason: v.reason, before: selected.record, result, requestId: v.requestId, origin },
      });
      return result;
    });
  }
  /**
   * 办失败：记一条失败审计，交出要抛的错。页面发来的校验没过换成通顺的中文整句（readableIssues）；
   * 助手发来的照旧交出原始校验结果，助手按每个字段的路径告诉模型缺什么（server/assistant/manager.ts）
   */
  private failed({ v, actor, origin }: Run, e: unknown) {
    const failure =
      origin === 'management-ui' && e instanceof ZodError ? new AppError(readableIssues(e.issues, v.module)) : e;
    audit(this.store, actor, {
      action: 'failed-' + v.action,
      entity: auditEntity(v.module),
      id: null,
      document: {
        requestId: v.requestId,
        origin,
        items: v.items,
        message: failureMessage(failure, '本机管理员数据修改 ' + v.module + ' ' + v.action, '校验失败'),
      },
    });
    return failure;
  }
  /**
   * 对选中的一条记录办这条命令（新建在 create 里）：改、单据的确认/撤销/取消/归档、档案的归档恢复。
   * 出入库、盘点不在这里：数据管理打开和库存页同一个“出入库 / 盘点”窗口，走 /warehouse/items/:id/move。
   */
  private applyAction(run: Run, item: Item, selected: Selected) {
    const { v, actor } = run;
    if (v.action === 'update') return this.update(run, item, selected);
    if (isFlowModule(v.module)) {
      if (v.action === 'confirm') {
        const preview = this.flow.preview(item.id, actor);
        return this.flow.confirm(
          item.id,
          { previewDigest: preview.previewDigest, requestId: randomUUID(), acknowledged: true },
          actor,
        );
      }
      if (v.action === 'reverse')
        return this.flow.reverse(item.id, { version: item.version, reason: v.reason, acknowledged: true }, actor);
      if (v.action === 'cancel')
        return this.flow.cancel(item.id, { version: item.version, reason: v.reason, acknowledged: true }, actor);
    }
    if (v.action === 'archive' || v.action === 'restore') {
      // 单据和档案归档同一份做法（server/core/archive.ts），这一条没办成就 409
      const body = { action: v.action, acknowledged: true, items: [item] };
      return archivedOrConflict(
        isFlowModule(v.module)
          ? archiveFlowDocuments(this.flow, body, actor)
          : changeLifecycle(this.store, v.module, body, actor),
      );
    }
    throw new AppError('该模块不支持此操作。');
  }
  /** 改一条：补丁盖到编辑窗内容上；改价先按 shared/core/precision.ts 的 priceEdit 判断补丁的意思，再交给保存（chosenExact 同一套规则） */
  private update({ v, actor, origin }: Run, item: Item, selected: Selected) {
    const before = selected.record,
      input = selected.input;
    const patch = { ...v.patch, ...v.patches?.[String(item.id)] };
    // 产品的记录才有参考单价（priceCents）
    const price =
      v.module === 'products' && 'priceCents' in before
        ? productPricePatch(patch, before, wholeRecordWithout(patch, input, 'priceExact'))
        : {};
    const lines =
      v.module === 'orders' && Array.isArray(patch.lines)
        ? { lines: orderLinesPriceEdit(patch.lines, before, input) }
        : {};
    return this.saves.save(
      { module: v.module, actor, origin, current: { input, record: before }, confirmDistinct: v.confirmDistinct },
      item.id,
      { ...input, ...patch, ...price, ...lines, version: item.version },
      patch,
    );
  }
}
