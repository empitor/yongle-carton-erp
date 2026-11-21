import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { Store } from '../../core/index.js';
import type { Actor } from '../../core/index.js';
import { requirePermission, audit, exists, inSavepoint, operationRequest, replayRequest } from '../../core/index.js';
import { FlowService } from '../rules/service.js';
import { AppError, failureMessage } from '../../core/index.js';
import { completionResultSchema, productionCompletionSchema, type FlowDocView } from '../../../shared/business/index.js';
import { quantityUnits, quantityString } from '../../../shared/core/index.js';
import { today } from '../../../shared/core/index.js';
import { saveRequest } from '../../core/index.js';
import {
  allocate,
  checkFacts,
  matchMaterials,
  pickTasks,
  taskRows,
  type CompletionInput,
  type CompletionOptions,
  type CompletionRow,
} from './completion-plan.js';

/** 登记完工的防重复提交记录种类（人工预览后提交的 production-completion.ts 也按它查办过没有） */
export const COMPLETION_REQUEST = 'production-completion';

/** 登记完工的结果（结构在 shared/business/flow-results.ts；同一请求号再交时按它核对上次存下的结果） */
type CompletionResult = z.output<typeof completionResultSchema>;
type RegisteredRow = CompletionResult['results'][number];
/** 这次登记的方案：每行的合格、废品和分到的领料，整批的原料，是不是只登记待入库 */
type CompletionPlan = { rows: CompletionRow[]; materials: ReturnType<typeof matchMaterials>; pending: boolean };

// 复合编排只调用原生产/库存服务。整批先在回滚预演内预检，再由同一事务正式提交。
// 两种做法：直接登记并入库（默认）；pending 只登记、稍后核对入库——拆分、分摊、校验和成品库存对应完全一样，
// 每张任务照样走 FlowService.save('production') 存成待入库的完工单，只是不再逐张核对入库，不动库存。
/** 批量登记完工：一次登记几个生产任务的完工、按任务分配领料。人工“登记完工”和助手共用。 */
export class ProductionCompletion {
  readonly flow: FlowService;
  constructor(
    readonly store: Store,
    /** requireFacts：助手登记时完工日期和每个任务的实际产量都必须是用户说的，不按今天、剩余任务量默认。 */
    readonly options: CompletionOptions = {},
  ) {
    this.flow = new FlowService(store);
  }
  execute(raw: unknown, who: Actor): CompletionResult {
    const actor = requirePermission(who, 'business:edit'),
      v = productionCompletionSchema.parse(raw);
    checkFacts(this.options, v);
    // 完工是实际发生的事，日期不能填未来；直接入库和只登记同一条规则（单张完工核对入库时也这样拦）
    if (v.date && v.date > today()) throw new AppError('完工日期不能晚于今天。');
    // 只登记、稍后核对入库：存成待入库的完工单，不动库存
    const pending = v.pending === true;
    // 查和办分开：同号重试先原样返回，再按现在的任务和库存拆分领料；只有正式写入失败才记失败审计
    const requestId = v.requestId,
      request = operationRequest(COMPLETION_REQUEST, requestId, actor, v);
    const prior = replayRequest(this.store, request, completionResultSchema);
    if (prior !== undefined) return prior;
    const tasks = pickTasks(this.flow, v);
    const rows = taskRows(this.options, v, tasks);
    const materials = matchMaterials(this.flow, v, tasks, pending);
    allocate(v, rows, materials);
    try {
      return inSavepoint(this.store.db, () => {
        const result = this.register(v, actor, { rows, materials, pending });
        saveRequest(this.store, request, result);
        return result;
      });
    } catch (e) {
      // 实体名和别处单据统一（flow_production）；record_id 为空，不进修改历史
      audit(this.store, actor, {
        action: 'failed-completion',
        entity: 'flow_production',
        id: null,
        document: { requestId, message: failureMessage(e, '批量完工入库', '完工失败') },
      });
      throw e;
    }
  }
  /** 按方案逐行登记完工单，核对关联，拼出这次登记的结果 */
  private register(v: CompletionInput, actor: Actor, plan: CompletionPlan): CompletionResult {
    const { pending } = plan;
    let writes = 0;
    const results = plan.rows.map((row) => {
      const done = this.registerRow(v, actor, row, pending);
      writes += done.writes;
      return done.result;
    });
    if (exists(this.store.db, 'PRAGMA foreign_key_check'))
      throw new AppError('完工关联检查失败。', 409);
    return {
      count: writes,
      results,
      materials: plan.materials.map((m) => ({
        stockId: m.stockId,
        issued: quantityString(m.issued),
        returned: quantityString(m.returned),
      })),
      allocation: v.allocation,
      allocationBasis:
        v.allocation === 'shared-proportional'
          ? '按实际产量比例以最大余数法分配整张领料；表示领料归属，不推断切割布局'
          : '用户明确逐任务分配',
      verified: true,
      pending,
      inventoryChanged: !pending,
      message: pending
        ? `已登记${results.length}张完工，待核对入库`
        : `已正式完工入库${results.length}张完工单`,
    };
  }
  /** 登记一行：按产品对应成品库存、存成待入库的完工单，直接入库的再核对入库；返回这张完工单和写了几次 */
  private registerRow(v: CompletionInput, actor: Actor, row: CompletionRow, pending: boolean): { writes: number; result: RegisteredRow } {
    // 挂任务的按任务的产品；不挂任务的（打样、补做）按这一行填的产品
    const task = row.task;
    const product = this.store.product(row.productId);
    if (!product) throw new AppError(task ? '关联产品不可用。' : '产品不存在或已归档。', 409);
    // 成品库存由产品决定：一个产品只有一个（归档的也算），没有就按产品新建，已归档的自动恢复再入库。
    // 成品和生产任务的单位都只有“只”（数据库约束）
    const stock = this.flow.ops.finishedStockFor(product.id, actor, undefined, task ? '生产任务 ' + task.number : '完工（不挂任务）'),
      finished = stock.item;
    let writes = stock.created || stock.restored ? 1 : 0;
    const draft = this.flow.save('production', productionInput(v, actor, row, { productId: product.id, finishedStockId: finished.id }), actor);
    writes++;
    // 只登记：到这里就是一张待入库的完工单，之后逐张“核对入库”
    if (!pending) {
      const preview = this.flow.preview(draft.id, actor);
      this.flow.confirm(
        draft.id,
        { previewDigest: preview.previewDigest, requestId: randomUUID(), acknowledged: true },
        actor,
      );
      writes++;
    }
    const actual = verifiedProduction(this.flow.get(draft.id), row, pending);
    return {
      writes,
      result: {
        taskId: task?.id ?? null,
        productId: product.id,
        productionId: actual.id,
        number: actual.number,
        finishedStockId: finished.id,
        goodQuantity: actual.goodQuantity,
        scrapQuantity: actual.scrapQuantity,
        materials: actual.materials,
        verified: true,
      },
    };
  }
}

/** 这一行要存的完工单内容 */
function productionInput(v: CompletionInput, actor: Actor, row: CompletionRow, ids: { productId: number; finishedStockId: number }) {
  return {
    taskId: row.task?.id ?? null,
    productId: ids.productId,
    finishedStockId: ids.finishedStockId,
    // 只有人工批量完工会不传日期（页面会预填让人确认）；助手登记在上面已经要求必填
    date: v.date || today(),
    goodQuantity: quantityString(row.good),
    scrapQuantity: quantityString(row.scrap),
    operator: v.operator || actor.name,
    materials: row.materials,
    // 批次备注：这次登记写的一句，记到生成的每张完工单上（显示在成品库存的批次里）
    notes: v.notes,
  };
}

/** 存好（直接入库的已核对入库）的完工单要和这一行对得上：种类、状态、挂的任务、合格数 */
function verifiedProduction(actual: FlowDocView, row: CompletionRow, pending: boolean): FlowDocView<'production'> {
  if (
    actual.kind !== 'production' || actual.status !== (pending ? 'draft' : 'confirmed') ||
    actual.taskId !== (row.task?.id ?? null) ||
    quantityUnits(actual.goodQuantity) !== row.good
  )
    throw new AppError(pending ? '待入库完工单核验失败。' : '正式生产回执核验失败。', 409);
  return actual;
}
