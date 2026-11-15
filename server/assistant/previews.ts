// 确认卡片：把生成的方案存起来、聊天里那张卡片的样子、删除卡片上改“库存怎么处理”、人点确认后执行、人点拒绝后作废。
// 助手的写入只有这一条路：出卡片（chat/tool-step.ts），人点确认，这里执行。业务类方案的写入、回执、操作记录、审计在同一个事务里；
// 流程类方案（导入、导出、改提示词……）各自的服务有自己的事务，等结果出来再记回执。
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Store } from '../core/index.js';
import type { Actor } from '../core/index.js';
import { AppError, failureMessage, inSavepoint, many, one, parseStoredJson, rows } from '../core/index.js';
import { audit, requirePermission } from '../core/index.js';
import { isLocalAdministrator } from '../core/index.js';
import { assertCardCurrent, destructivePlan, localOnlyPlan, localOnlyMessage, planModule, storedToolPlan, unconfirmedDeletion, type ToolPlan } from './plan-rules.js';
import { executeCardBody, inventoryPolicyBody, type PlanCard } from '../../shared/assistant/index.js';
import { errorMessage } from '../../shared/core/index.js';
import type { AssistantTools } from './tools.js';
import type { AssistantToolRegistry } from './tool-registry.js';
import type { AssistantConversations } from './conversation.js';
import { cardStates } from './chat/card-changes.js';
import { staleMessage } from './stale-card.js';
import { planCard } from './json-view.js';
import { asList, field } from './chat/result-fields.js';

const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
/** 卡片已经发出去执行、没有记下结果（还在执行，或者中途断了）时，再点确认回的话 */
export const CARD_UNKNOWN = '这一步上次已经发出去了，结果不明：可能已经做了，也可能没做。先查一下现在的情况再决定，这张卡片不会再执行。';

/** 流程类方案的执行（manager.ts 接上 chat/workflow-cards.ts 的 run） */
export type WorkflowRunner = (plan: ToolPlan, actor: Actor, binding: string, threadId: string, previewId: string) => unknown;
/** 存一张卡片要的：卡片编号、哪个会话、谁、哪个登录会话、多久过期、方案、出卡片时的数据版本（stamp） */
export type CardToSave = { id: string; threadId: string; actor: Actor; binding: string; expiresAt: number; plan: ToolPlan; stamp: unknown };
/** 执行时由聊天接口填：是否从代理入口进来、是否已核验本人密码；automatic 是测试开了自动确认（chat/agent-config.ts），出卡片后立刻替人点 */
export type CardReview = { proxy?: boolean; passwordVerified?: boolean; automatic?: boolean };

type PreviewRow = z.output<typeof rows.assistant_previews>;
/**
 * 存下来的卡片（assistant_previews.document）：方案和出卡片时的数据版本；执行出过错（failed）、发出去了（started）、
 * 数据变了作废（stale）时各记一笔。方案原样交出（摘要按存的方案算）；别的键原样留着。
 */
const storedPreview = z.looseObject({
  plan: storedToolPlan,
  stamp: z.unknown().optional(),
  failed: z.string().optional(),
  started: z.string().optional(),
  stale: z.string().optional(),
});
const previewOf = (row: PreviewRow) => parseStoredJson(storedPreview, row.document, 'assistant_previews.document（卡片 ' + row.id + '）');
/** 正在执行的一张卡片：记回执、操作记录、审计要的 */
type Running = { id: string; threadId: string; plan: ToolPlan; actor: Actor; automatic: boolean };
/** 聊天记录里放着这张卡片的位置：哪条消息、plans 里第几张 */
const placedCard = z.object({ seq: z.number(), key: z.number() });

export class AssistantPreviews {
  constructor(
    private readonly store: Store,
    private readonly tools: AssistantTools,
    private readonly registry: AssistantToolRegistry,
    private readonly conversations: AssistantConversations,
    private readonly runWorkflow: WorkflowRunner,
  ) {}
  /** 方案绑定的数据版本：业务类按涉及的记录算，执行前对不上就作废；流程类由各自的执行函数核对（比如导入按预览摘要） */
  private digest(plan: ToolPlan, actor: Actor) {
    return hash({ plan, stamp: plan.workflow ? null : this.tools.stamp(plan, actor) });
  }
  private row(id: string, actor: Actor, binding: string) {
    const row = one(this.store.db, rows.assistant_previews, 'SELECT * FROM assistant_previews WHERE id=? AND user_id=?', z.uuid().parse(id), actor.id);
    if (!row || row.session_binding !== binding) throw new AppError('方案不存在或不属于当前登录会话。', 403);
    return row;
  }
  /** 存一份待确认的方案；摘要绑定方案和当时的业务版本（stamp）。 */
  save(card: CardToSave) {
    const { plan, stamp } = card;
    this.store.db
      .prepare('INSERT INTO assistant_previews(id,thread_id,user_id,session_binding,expires_at,digest,document,result) VALUES(?,?,?,?,?,?,?,NULL)')
      .run(card.id, card.threadId, card.actor.id, card.binding, card.expiresAt, hash({ plan, stamp }), JSON.stringify({ plan, stamp }));
  }
  /**
   * 聊天里那张方案卡片看到的样子：方案本身，加上删除类方案只给卡片写说明用的标记（不参与核对，
   * 执行时删除引擎、聊天接口照旧各自核对）。
   */
  planView(previewId: string, expiresAt: number, plan: ToolPlan, current: Actor) {
    return {
      id: previewId,
      expiresAt,
      ...plan,
      // 改的是哪个模块：核对区按它列出改了什么（页面不猜）
      module: planModule(plan),
      ...(destructivePlan(plan)
        ? {
            destructive: true,
            highRisk: true,
            // 和人工删除一样：本机最高管理员以外要再输一次密码；还没核对的单据不用
            requiresPassword: !isLocalAdministrator(current) && !unconfirmedDeletion(this.store, plan),
            // 要不要超级管理员模式（records.delete 删已核对的单据和档案，本机最高管理员不用）；
            // 是不是只能在服务器本机做（一键清空、识别工作区的删除）
            requiresSuperMode:
              plan.tool === 'records.delete' &&
              !isLocalAdministrator(current) &&
              !unconfirmedDeletion(this.store, plan),
            localOnly: localOnlyPlan(plan),
          }
        : {}),
    };
  }
  /**
   * 人在删除确认卡片上改“库存怎么处理”：服务器按新选项把这份待确认方案重新生成一遍
   * （删除引擎重新算范围、库存说明和范围摘要），同一个方案换上新摘要，旧摘要作废。
   * 只认还没执行、没过期、属于当前登录会话的删除方案；原方案生成后记录、权限或库存已经变了的，照执行时的规则作废。
   * 执行时照旧核对摘要、版本、密码和超级管理员模式，一样都不放松（commit）。
   * 聊天记录里那张卡片也换成新方案，刷新后看到的和要执行的一致。返回新的卡片内容。
   * 方案、聊天里的卡片、审计在同一个事务里写：中途出错一起回滚，不会方案换了、卡片还是旧的。
   * 执行请求要带卡片上看到的这一版摘要（commit 里 assertCardCurrent 核对），旧卡片不能按新选项执行。
   */
  changeDeletionPolicy(id: string, raw: unknown, who: Actor | null | undefined, binding: string) {
    const actor = requirePermission(who, 'business:edit');
    const { inventoryPolicy } = inventoryPolicyBody.parse(raw);
    const row = this.row(id, actor, binding);
    if (row.result) throw new AppError('这份方案已经执行过了。', 409);
    if (row.expires_at < Date.now()) throw new AppError('方案已过期，请重新生成。', 409);
    const data = previewOf(row),
      plan = data.plan;
    if (plan.tool !== 'records.delete') throw new AppError('只有删除方案能选库存怎么处理。');
    this.registry.assertAvailable(plan.tool);
    if (row.digest !== this.digest(plan, actor))
      throw new AppError('相关业务记录、权限或库存已变化，请重新生成完整方案。', 409);
    const next = this.tools.deletionWithPolicy(plan, inventoryPolicy, actor),
      stamp = this.tools.stamp(next, actor),
      digest = hash({ plan: next, stamp });
    // 写进聊天记录、回给页面的是同一份，写之前按卡片的结构核对
    const view = checkedCard(this.planView(row.id, row.expires_at, next, actor));
    inSavepoint(this.store.db, () => {
      // 存下来的 stamp 也换成新方案的，和新摘要对得上
      const changed = this.store.db
        .prepare(
          'UPDATE assistant_previews SET digest=?,document=? WHERE id=? AND user_id=? AND result IS NULL AND digest=?',
        )
        .run(digest, JSON.stringify({ ...data, plan: next, stamp }), row.id, actor.id, row.digest).changes;
      if (!changed) throw new AppError('方案已变化，请刷新后再试。', 409);
      this.replaceShownCard(row, view);
      this.conversations.log(actor, row.thread_id, plan.tool, 'inventory-policy', { previewId: row.id, inventoryPolicy });
    });
    return view;
  }
  /** 聊天记录里放着这张卡片的地方换成新的样子（每条助手消息的 plans 里编号对得上的那几张，别的原样不动） */
  private replaceShownCard(row: PreviewRow, view: PlanCard) {
    const placed = many(
      this.store.db,
      placedCard,
      "SELECT m.seq,p.key FROM assistant_messages m, json_each(m.document,'$.plans') p WHERE m.thread_id=? AND m.role='assistant' AND json_type(m.document,'$.plans')='array' AND json_extract(p.value,'$.id')=?",
      row.thread_id,
      row.id,
    );
    const update = this.store.db.prepare('UPDATE assistant_messages SET document=json_set(document,?,json(?)) WHERE seq=?');
    for (const p of placed) update.run('$.plans[' + p.key + ']', JSON.stringify(view), p.seq);
  }
  /**
   * 执行一份方案：人在卡片上点了确认。review 由聊天接口填：是否从代理入口进来、是否已核验本人密码。
   * 删除类方案和人工删除一样：本机最高管理员以外要核验密码，还没核对的到货、生产任务、完工、送货单
   * （unconfirmedDeletion）不用；要不要超级管理员模式由删除引擎在执行时核对。
   * 一键清空和识别工作区的删除（localOnlyPlan）拒绝代理入口。
   * review.automatic：测试开了自动确认（chat/agent-config.ts），出卡片后立刻替人点；删除和清空不行。
   * 返回执行结果（各命令不同）；要等的执行返回等结果的 Promise。
   */
  commit(id: string, raw: unknown, who: Actor | null | undefined, binding: string, review: CardReview = {}): unknown {
    const actor = requirePermission(who, 'business:edit');
    const automatic = !!review.automatic;
    // 删除卡片上看到的范围摘要（deletionDigest）：卡片上能改库存处理方式，执行前核对人确认的就是现在这一版；密码由接口那层收
    const input = executeCardBody.omit({ password: true }).parse(raw);
    const row = this.row(id, actor, binding);
    const preview = previewOf(row),
      plan = preview.plan;
    // 人在卡片上确认的：卡片上看到的必须是现在这一版（已经执行过的也一样，不把别处按另一种选项执行的结果当成这次的）
    if (!automatic) assertCardCurrent(plan, input.deletionDigest, !!row.result);
    if (row.result) return parseStoredJson(z.unknown(), row.result, 'assistant_previews.result（卡片 ' + row.id + '）');
    assertRunnable(row, preview);
    this.registry.assertAvailable(plan.tool);
    this.assertReviewed(plan, actor, review);
    // 普通方案不追加AI专属密码或口令；原业务服务继续核验真实Actor。
    const running: Running = { id, threadId: row.thread_id, plan, actor, automatic };
    if (plan.workflow) {
      if (row.digest !== this.digest(plan, actor)) throw new AppError('方案内容对不上，请重新生成。', 409);
      this.begin(id);
      const pending = Promise.resolve().then(() => this.runWorkflow(plan, actor, binding, row.thread_id, id));
      return this.afterAsync(running, pending);
    }
    return this.commitBusiness(running, row, preview.stamp, binding);
  }
  /** 删除和清空：只能由人确认；只能在服务器本机做的拒绝代理入口；本机最高管理员以外核验本人密码（还没核对的单据不用） */
  private assertReviewed(plan: ToolPlan, actor: Actor, review: CardReview) {
    if (!destructivePlan(plan)) return;
    if (review.automatic) throw new AppError('删除和清空操作只能由人在确认卡片上确认后执行。', 403, 'review-required');
    if (review.proxy && localOnlyPlan(plan)) throw new AppError(localOnlyMessage(plan.tool), 403, 'proxy-deletion');
    if (!isLocalAdministrator(actor) && !review.passwordVerified && !unconfirmedDeletion(this.store, plan))
      throw new AppError('删除操作需要输入当前账号密码确认。', 403, 'step-up');
  }
  /** 业务类方案：数据核对、执行、记回执在同一个事务里；要等的执行先提交同步的那一段，等结果出来再记回执 */
  private commitBusiness(running: Running, row: PreviewRow, stamp: unknown, binding: string) {
    const { id, plan, actor } = running;
    let done: { result: unknown } | { pending: Promise<unknown> };
    try {
      done = inSavepoint(this.store.db, () => {
        // 出卡片以后相关数据变了：照旧拦，说清哪几条变了；卡片作废（带原因），结果交回助手按最新数据重新出一张
        if (row.digest !== this.digest(plan, actor)) throw new AppError(staleMessage(stamp, this.tools.stamp(plan, actor)), 409, 'card-stale');
        const result = this.tools.commit(plan, actor, binding);
        // 要等的执行（识别工作区的归档、删除）：同步的那一段先提交（放开事务），等结果出来再记回执
        if (result instanceof Promise) return { pending: Promise.resolve<unknown>(result) };
        this.record(running, result);
        return { result };
      });
    } catch (e) {
      if (e instanceof AppError && e.code === 'card-stale')
        this.store.db
          .prepare("UPDATE assistant_previews SET expires_at=0,document=json_set(document,'$.stale',?) WHERE id=? AND result IS NULL")
          .run(e.message, id);
      throw e;
    }
    if ('result' in done) return done.result;
    this.begin(id);
    return this.afterAsync(running, done.pending);
  }
  /**
   * 要等的执行开始了：在卡片上记下“已经发出去”，立刻落盘。执行还没回来（或进程中途断了）时再点确认，看到这个标记就不再执行。
   * 业务类的同步执行不用它：整个执行在同一个数据库事务里、中间不让出，第二次确认插不进来；失败了整个回滚，等于没做过。
   */
  private begin(id: string) {
    const marked = this.store.db
      .prepare("UPDATE assistant_previews SET document=json_set(document,'$.started',?) WHERE id=? AND result IS NULL AND json_extract(document,'$.started') IS NULL")
      .run(new Date().toISOString(), id);
    if (!marked.changes) throw new AppError(CARD_UNKNOWN, 409, 'card-unknown');
  }
  /** 等执行结果：一次几份的全部失败就报错（不记回执）；有成有败的照实记在结果里。没成的在卡片上记下原因，这张卡片不再执行 */
  private async afterAsync(running: Running, pending: Promise<unknown>) {
    let result: unknown;
    try {
      result = await pending;
      const results = (asList(field(result, 'results')) ?? []);
      const failed = results.filter((r) => !field(r, 'success'));
      if (failed.length && failed.length === results.length) throw new AppError(String(field(result, 'message') || '一份都没有执行成功。'), 409);
    } catch (e) {
      this.store.db
        .prepare("UPDATE assistant_previews SET document=json_set(document,'$.failed',?) WHERE id=? AND result IS NULL")
        .run(failureMessage(e, '助手确认卡片 ' + running.plan.tool, '执行出错'), running.id);
      throw e;
    }
    return inSavepoint(this.store.db, () => {
      this.record(running, result);
      return result;
    });
  }
  /** 执行之后记下：方案回执、助手操作记录、业务审计。聊天里不另写回执：卡片显示“已执行”，结果交回模型由它说明。 */
  private record(running: Running, result: unknown) {
    const { id, plan, actor } = running;
    this.store.db
      .prepare('UPDATE assistant_previews SET result=? WHERE id=? AND result IS NULL')
      // 工具没有返回值时记 JSON 的 null：undefined 绑不进数据库
      .run(JSON.stringify(result ?? null), id);
    const authorization = { mode: running.automatic ? 'test-auto-confirm' : 'confirmed-preview' };
    this.conversations.log(actor, running.threadId, plan.tool, 'executed', { previewId: id, result, authorization });
    audit(this.store, actor, {
      action: 'execute',
      entity: 'assistant_previews',
      id: null,
      document: { previewId: id, tool: plan.tool, before: plan.before, result, authorization },
    });
  }
  /** 人在卡片上点了拒绝：这份方案作废，不执行。已经执行过的不能再拒绝。 */
  reject(id: string, who: Actor | null | undefined, binding: string) {
    const actor = requirePermission(who, 'business:edit');
    const row = this.row(id, actor, binding);
    if (row.result) throw new AppError('这份方案已经执行过了。', 409);
    const preview = previewOf(row);
    if (preview.started) throw new AppError(CARD_UNKNOWN, 409, 'card-unknown');
    this.store.db.prepare('UPDATE assistant_previews SET expires_at=0 WHERE id=? AND result IS NULL').run(row.id);
    this.conversations.log(actor, row.thread_id, preview.plan.tool, 'rejected', { previewId: id, label: preview.plan.label });
    return { rejected: true };
  }
  /** 进程中断那一轮出的、还没显示给人的卡片作废：人看不到就没法确认；下一轮开头模型会知道它作废了（chat/card-changes.ts）。 */
  cancelUnshown(threadId: string) {
    this.store.db
      .prepare(
        `UPDATE assistant_previews SET expires_at=0 WHERE thread_id=? AND result IS NULL AND expires_at>0 AND id NOT IN (
           SELECT json_extract(p.value,'$.id') FROM assistant_messages m, json_each(m.document,'$.plans') p WHERE m.thread_id=?)`,
      )
      .run(threadId, threadId);
  }
  /** 这个会话里各张卡片现在的状态（会话视图给每张卡片标上，页面不用自己猜） */
  states(threadId: string) {
    return cardStates(this.store, threadId);
  }
}

/** 写进聊天记录的卡片按卡片的结构核对：卡片是服务端自己拼的，对不上是程序错，按服务端错误报（不当成提交的内容不对） */
function checkedCard(view: unknown) {
  try {
    return planCard(view);
  } catch (e: unknown) {
    throw new Error('确认卡片的样子和卡片结构对不上：' + errorMessage(e));
  }
}

/** 一张卡片只执行一次：执行失败过的、发出去了没有结果的、作废的、过期的都不再执行 */
function assertRunnable(row: PreviewRow, preview: z.output<typeof storedPreview>) {
  if (preview.failed) throw new AppError('这张卡片上次执行没有成功（' + preview.failed + '），不会再执行。还要办的话让助手重新出一张。', 409, 'card-failed');
  if (preview.started) throw new AppError(CARD_UNKNOWN, 409, 'card-unknown');
  if (row.expires_at === 0) throw new AppError('这份方案已经作废，没有执行。', 409);
  if (row.expires_at < Date.now()) throw new AppError('方案已过期，请重新生成。', 409);
}
