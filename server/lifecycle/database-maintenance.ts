import { z } from 'zod';
import type { Store } from '../core/index.js';
import type { Actor } from '../core/index.js';
import { exists, isLocalAdministrator, one, rows } from '../core/index.js';
import { AppError, assertPreviewCurrent } from '../core/index.js';
import { beforeRecordDeleted, deletionRemove, deletionUpdate } from '../core/index.js';
import type { DeletionContext, DeletionRow } from '../core/index.js';
import { audit, isSuperMode, rememberDeletedRecord, superModeDenied } from '../core/index.js';
import { inventoryEffectText } from './deletion-summary.js';
import { textOf } from './deletion-impact.js';
import { businessTables, planDeletion, quote } from './deletion-plan.js';
import { recomputeAfterFlowDeletion } from '../flow/index.js';
import { snapshotBeforeDestructive } from '../core/index.js';
import { onceByRequest, operationRequest, replayRequest, requestDone } from '../core/index.js';
import { deletionRequestSchema, deletionResultSchema, deletionSelection, flowKinds } from '../../shared/business/index.js';

const DELETE_REQUEST = 'database-delete';
/** 删之前按 rowid 取整行记进审计：哪张表都有可能，按“列名 → 值”读 */
const wholeRow = z.record(z.string(), z.unknown());
const draftState = rows.flow_documents.pick({ kind: true, status: true });
/** 删除的防重复提交：同一个人、同一会话、同一内容才原样返回 */
const deleteRequest = (v: z.infer<typeof deletionRequestSchema>, actor: Actor, binding: string) =>
  operationRequest(DELETE_REQUEST, v.requestId, actor, v, binding);
type DeletionRequest = z.output<typeof deletionRequestSchema>;
/** 权限和内容都核对过的一次删除：谁删、删什么、防重复提交的请求 */
type CheckedDeletion = { actor: Actor; v: DeletionRequest; request: ReturnType<typeof deleteRequest> };
/**
 * 删除引擎（受控数据库维护）：删除不是归档/冲销。这里管谁能删、预览和真删；删哪些、解除哪些引用在 deletion-plan.ts 算，
 * 由数据库外键和各模块登记的删除规则决定（server/core/deletion-rules.ts）；改、删每一行都交给表的主人写，这里不直接写别的模块的表。
 * 影响清单怎么显示、库存说明要的数在 deletion-impact.ts；管理员改订单时连带改单据在业务汇总的 order-edit-cascade.ts。
 */
export class DatabaseMaintenanceService {
  constructor(readonly store: Store) {}
  /**
   * 谁能删：本机最高管理员什么都能删。不在本机（服务器上从域名访问）时和本机一致，但多两道门：
   * 要超级管理员模式，提交时再输本人密码（路由里核验）。
   * 生产任务、到货、完工、送货还没核对的单据没动库存也没进账，有编辑权限就能删，不用密码。
   */
  deletionAccess(who: Actor | null | undefined, raw: unknown): { actor: Actor; draftsOnly: boolean } {
    // 删除提交还带着请求编号和范围摘要，这里只看选了哪些
    const s = z.object(deletionSelection.shape).safeParse(raw);
    const chosen = s.success ? s.data : null;
    const flowModule = !!chosen && flowKinds.some((k) => k === chosen.module);
    const draftsOnly =
      !!chosen &&
      flowModule &&
      chosen.items.every((i) => {
        const r = one(this.store.db, draftState, 'SELECT kind,status FROM flow_documents WHERE id=?', i.id);
        return !!r && r.kind === chosen.module && r.status === 'draft';
      });
    if (who && (isLocalAdministrator(who) || isSuperMode(who))) return { actor: who, draftsOnly };
    if (draftsOnly && who?.permissions.includes('business:edit')) return { actor: who, draftsOnly };
    if (!who) throw new AppError('请先登录管理账号。', 401, 'authentication');
    // 选的全是还没核对的单据：缺的是编辑权限（只读、财务账号），和超级管理员模式无关，按实际原因说
    if (draftsOnly)
      throw new AppError('删除还没核对的单据要有业务编辑权限，当前账号没有这个权限。', 403, 'permission');
    // 其余要超级管理员模式：进不了模式的账号（业务员、只读、财务）直接说没有权限，不叫人去系统维护；
    // 没进模式的超级管理员提示去“系统维护”进入。分法和类别见 server/core/permissions.ts 的 superModeDenied
    throw flowModule
      ? superModeDenied(who, '删除已核对的单据', {
          permission: who.permissions.includes('business:edit') ? '还没核对的单据可以直接删' : undefined,
          superMode: '还没核对的单据有编辑权限就能直接删',
        })
      : superModeDenied(who, '删除客户、产品、订单、采购单和库存品');
  }
  private deletionActor(who: Actor | null | undefined, raw: unknown): Actor {
    return this.deletionAccess(who, raw).actor;
  }
  preview(raw: unknown, who: Actor | null | undefined) {
    this.deletionActor(who, raw);
    const p = planDeletion(this.store, raw);
    return {
      selection: p.selection,
      digest: p.digest,
      impact: p.impact,
      hasIndependentImpact: p.hasIndependentImpact,
      // 被删单据有几笔出入库流水要按“库存处理方式”处理；0 表示没动过库存，不用选
      inventoryChoice: p.inventoryChoice,
      // 库存怎么变：按实际删的对象说（这张采购单、这家供应商、这个原材料库存），笔数和影响清单对得上。
      // “库存怎么处理”的选项文字界面按删的对象自己取（shared/business/deletion-words.ts），不在这里给
      inventoryEffect: inventoryEffectText({
        module: p.selection.module,
        count: p.selection.items.length,
        policy: p.selection.inventoryPolicy,
        ...p.inventory,
      }),
    };
  }
  /**
   * 同一请求编号已经删过（比如网络断了重试）：原样返回上次的结果。
   * 要放在权限判断前面：删完后单据已经不在库里，再按现在的库判断“是不是只删还没核对的单据”，
   * 会把同一个人的重试误判成没权限。请求号按账号分开：没登录、这个账号没用这个号删过，都返回 null，
   * 照常走权限判断和删除（没登录由权限判断报 401）；删过的仍要求同一会话、同一内容。
   */
  replay(raw: unknown, who: Actor | null | undefined, binding: string) {
    const parsed = deletionRequestSchema.safeParse(raw);
    if (!parsed.success || !who) return null;
    if (!requestDone(this.store, DELETE_REQUEST, who, parsed.data.requestId)) return null;
    if (!binding) throw new AppError('登录会话无效。', 403);
    return replayRequest(this.store, deleteRequest(parsed.data, who, binding), deletionResultSchema);
  }
  /** 删除：先拍一份破坏前快照（拍不成就不删），再按预览时的范围删。对外只有这一个删除入口 */
  delete(raw: unknown, who: Actor | null | undefined, binding: string) {
    const replayed = this.replay(raw, who, binding);
    if (replayed) return replayed;
    const checked = checkedRequest(this, raw, who, binding);
    snapshotBeforeDestructive(this.store, 'delete');
    return deleteOnce(this.store, checked);
  }
}

/**
 * 拍过破坏前快照的凭证：只有 take 真拍了快照才拿得到（构造函数和字段都是私有的，别处造不出来）。
 * 不另拍快照的删除（deleteAfterSnapshot）要它。
 */
export class TakenSnapshot {
  private constructor(private readonly store: Store) {}
  static take(store: Store, reason: string) {
    snapshotBeforeDestructive(store, reason);
    return new TakenSnapshot(store);
  }
  /** 拍的是不是这个业务库 */
  covers(store: Store) {
    return this.store === store;
  }
}

/**
 * 调用方在同一次操作里已经拍过破坏前快照时的删除（本机管理员改订单连带删整张送货单：业务汇总的 service.ts 改订单前
 * 用 TakenSnapshot.take 拍了一份）：核对和删除跟 delete 一样，只是不再拍第二份。要本库的快照凭证，没拍过就调不了。
 */
export function deleteAfterSnapshot(
  engine: DatabaseMaintenanceService,
  raw: unknown,
  who: Actor | null | undefined,
  binding: string,
  snapshot: TakenSnapshot,
) {
  if (!snapshot.covers(engine.store)) throw new Error('删除前的快照不是这个业务库拍的，没有删除。');
  const replayed = engine.replay(raw, who, binding);
  if (replayed) return replayed;
  return deleteOnce(engine.store, checkedRequest(engine, raw, who, binding));
}

/** 谁删、删什么：权限和请求内容都核对过的一次删除 */
function checkedRequest(
  engine: DatabaseMaintenanceService,
  raw: unknown,
  who: Actor | null | undefined,
  binding: string,
): CheckedDeletion {
  const { actor } = engine.deletionAccess(who, raw),
    v = deletionRequestSchema.parse(raw);
  if (!binding) throw new AppError('登录会话无效。', 403);
  return { actor, v, request: deleteRequest(v, actor, binding) };
}
function deleteOnce(store: Store, { actor, v, request }: CheckedDeletion) {
  return onceByRequest(store, request, () => applyDeletion(store, v, actor), deletionResultSchema);
}
/** 真删：范围和预览时一样才删；改、删都交给表的主人，删完核对外键 */
function applyDeletion(store: Store, v: DeletionRequest, actor: Actor): z.output<typeof deletionResultSchema> {
  const p = planDeletion(store, { module: v.module, items: v.items, inventoryPolicy: v.inventoryPolicy });
  if (p.hasIndependentImpact || v.deletionDigest) assertPreviewCurrent(v.deletionDigest, p.digest);
  store.db.exec('PRAGMA defer_foreign_keys=ON');
  const at = new Date().toISOString();
  const ctx: DeletionContext = {
    actor,
    at,
    mark: { at, actorId: actor.id, requestId: v.requestId },
    updated: (t) => p.updates.filter((u) => u.table === t).map((u) => u.row),
  };
  // 改、删都交给表的主人（修订记录、所属单据的版本号由主人处理）
  for (const { table, row, value } of p.updates) deletionUpdate(store, ctx, table, row, value);
  for (const { table, row } of p.deletions) removeRow(store, ctx, v, { table, row });
  // 删掉、改过的单据挂着的订单重算生产、发货进度
  recomputeAfterFlowDeletion(
    store,
    [...p.deletions, ...p.updates].filter((r) => r.table === 'flow_documents'),
  );
  if (exists(store.db, 'PRAGMA foreign_key_check'))
    throw new AppError('外键重算校验失败，整个删除已回滚。', 409);
  return {
    module: v.module,
    action: 'delete',
    count: v.items.length,
    deleted: true,
    impact: p.impact,
    results: v.items.map((r) => ({ id: r.id, deleted: true })),
  };
}
/**
 * 删一行：业务记录另记审计和“删掉的记录”、取消归档、让别的模块先配合，再交给表的主人删。
 * 不通知财务：被删的单据、库存流水由财务下次补扫时自己发现，标成“来源已删除”
 */
function removeRow(store: Store, ctx: DeletionContext, v: DeletionRequest, { table, row }: { table: string; row: DeletionRow }) {
  const { actor } = ctx;
  if (businessTables.has(table)) {
    const entity = table === 'flow_documents' ? 'flow_' + String(row.kind) : table;
    // 影响范围只取了关联要用的列，审计要整行：按 rowid 再取一次（业务表没有大文件列）
    const full = one(store.db, wholeRow, 'SELECT rowid AS __rowid,* FROM ' + quote(table) + ' WHERE rowid=?', row.__rowid);
    audit(store, actor, {
      action: 'delete',
      entity,
      id: Number(row.id),
      document: { before: full, inventoryPolicy: v.inventoryPolicy, requestId: v.requestId },
    });
    rememberDeletedRecord(store, actor, entity, {
      id: Number(row.id),
      number: textOf(row.number),
      name: textOf(row.name),
    });
    store.unarchive(entity, Number(row.id));
    beforeRecordDeleted(store, ctx, entity, Number(row.id));
  }
  deletionRemove(store, ctx, table, row);
}
