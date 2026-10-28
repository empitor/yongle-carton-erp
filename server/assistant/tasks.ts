import { createHash, randomUUID } from 'node:crypto';
import type { Store } from '../db.js';
import type { Actor } from '../auth.js';
import { ImportError } from '../import/errors.js';
import {
  taskPlanSchema,
  type AssistantBusinessTask,
  type BusinessTaskStep,
} from '../../shared/assistant-task.js';
import type { AssistantTools } from './tools.js';
import { mergeDecisions, userDecisions } from './task-memory.js';
const now = () => new Date().toISOString();
const byteLimit = (name: string, fallback: number) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(name + '必须为非负安全整数；0表示不设大小上限');
  return value;
};
const canonical = (v: any): any =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .filter(
              (k) =>
                ![
                  'requestId',
                  'expectedRevision',
                  'expectedVersion',
                  'version',
                  'previewId',
                ].includes(k),
            )
            .map((k) => [k, canonical(v[k])]),
        )
      : v;
export const durableCallKey = (name: string, args: any, scope: any = {}) =>
  createHash('sha256')
    .update(JSON.stringify(canonical({ name, args, scope })))
    .digest('hex');
const receiptOnly = (v: any) => {
  if (!v) return v;
  if (v.workspace || v.task)
    return {
      message: v.message,
      url: v.url,
      workspaceId: v.workspace?.id,
      revision: v.workspace?.revision,
      documentTaskId: v.task?.id,
      state: v.task?.state,
      orderId: v.order?.id,
    };
  const text = JSON.stringify(v);
  return text.length <= 180000
    ? v
    : { summary: '结果较大，继续时按关联记录读取', id: v.id, number: v.number };
};
/** 与业务预览回执同库；成功业务写入和步骤完成由commitPreview在同一事务提交。 */
export class AssistantTaskLedger {
  private readonly taskBytes = byteLimit('ERP_AGENT_TASK_BYTES', 16_000_000);
  private readonly archiveBytes = byteLimit('ERP_AGENT_ARCHIVE_BYTES', 64_000_000);
  constructor(readonly store: Store) {}
  rememberInput(
    threadId: string,
    actor: Actor,
    messageId: string,
    text: string,
    files: { id: string; name: string }[] = [],
    restoreLegacy = true,
  ) {
    const prior = this.get(threadId, actor);
    const task = this.begin(threadId, actor, text);
    const memory = (task.memory ||= { decisions: [], turns: [], workspaceIds: [] });
    if (prior && !prior.memory && restoreLegacy) {
      const first = this.store.db
        .prepare(
          "SELECT rowid FROM assistant_messages WHERE thread_id=? AND role='user' AND created_at<=? ORDER BY rowid DESC LIMIT 1",
        )
        .get(threadId, task.createdAt);
      const until =
        this.history(threadId, actor)
          .filter((t) => t.createdAt >= task.createdAt)
          .map((t) => t.createdAt)
          .sort()[0] || '9999';
      if (first)
        for (const row of this.store.db
          .prepare(
            "SELECT id,text FROM assistant_messages WHERE thread_id=? AND role='user' AND rowid>=? AND created_at<? AND id<>? ORDER BY rowid LIMIT 100",
          )
          .all(threadId, first.rowid, until, messageId)) {
          const turn = { id: String(row.id), text: String(row.text) };
          memory.turns.push(turn);
          mergeDecisions(
            memory,
            userDecisions(turn.text, turn.id),
            /改为|更正|纠正|以.*为准/.test(turn.text),
          );
        }
      for (const step of task.steps)
        for (const wid of step.scope?.workspaceIds || [])
          if (!memory.workspaceIds.includes(wid)) memory.workspaceIds.push(wid);
    }
    if (!memory.turns.some((t) => t.id === messageId)) memory.turns.push({ id: messageId, text });
    memory.files ||= [];
    for (const f of files)
      if (!memory.files.some((x) => x.id === f.id)) memory.files.push({ id: f.id, name: f.name });
    mergeDecisions(memory, userDecisions(text, messageId), /改为|更正|纠正|以.*为准/.test(text));
    return this.put(threadId, actor, task);
  }
  rememberModel(threadId: string, actor: Actor, raw: any) {
    if (!raw || !Array.isArray(raw.decisions)) return;
    const task = this.get(threadId, actor);
    if (!task?.memory) return;
    for (const item of raw.decisions.slice(0, 30)) {
      if (
        !item ||
        !/^[a-zA-Z][a-zA-Z0-9.]{0,60}$/.test(item.key) ||
        JSON.stringify(item.value ?? null).length > 2000
      )
        continue;
      const source = task.memory.turns.find((t) => t.id === item.messageId);
      const quote = typeof item.quote === 'string' ? item.quote.slice(0, 1000) : '';
      const verified =
        source && quote && source.text.includes(quote)
          ? userDecisions(source.text, source.id).find(
              (d) =>
                d.key === item.key &&
                d.scope === (item.scope || 'task') &&
                JSON.stringify(d.value) === JSON.stringify(item.value),
            )
          : undefined;
      mergeDecisions(task.memory, [
        {
          key: item.key,
          scope: /^(task|all|order:[1-6])$/.test(item.scope) ? item.scope : 'task',
          value: item.value ?? null,
          status: verified ? 'confirmed' : item.status === 'unknown' ? 'unknown' : 'inferred',
          source: verified?.source || { kind: 'model', quote },
        },
      ]);
    }
    return this.put(threadId, actor, task);
  }
  bindWorkspaces(threadId: string, actor: Actor, ids: string[]) {
    const task = this.get(threadId, actor);
    if (!task?.memory) return;
    for (const id of ids)
      if (!task.memory.workspaceIds.includes(id)) task.memory.workspaceIds.push(id);
    return this.put(threadId, actor, task);
  }
  supersede(threadId: string, actor: Actor, oldId: string, replacementId: string) {
    const task = this.get(threadId, actor),
      old = task?.steps.find((s) => s.id === oldId),
      replacement = task?.steps.find((s) => s.id === replacementId);
    if (
      !task ||
      !old ||
      !replacement ||
      old.id === replacement.id ||
      !['failed', 'planned', 'waiting'].includes(old.state) ||
      replacement.state !== 'completed' ||
      !replacement.completion?.verified
    )
      return;
    old.state = 'superseded';
    old.supersededBy = replacement.id;
    old.verification = { replacementVerified: true, at: now(), replacementId };
    return this.put(threadId, actor, task);
  }
  get(threadId: string, actor: Actor): AssistantBusinessTask | null {
    const r = this.store.db
      .prepare('SELECT document FROM assistant_threads WHERE id=? AND user_id=?')
      .get(threadId, actor.id);
    if (!r) throw new ImportError('任务不属于当前账号或会话。', 403);
    return JSON.parse(String(r.document)).businessTask || null;
  }
  private put(threadId: string, actor: Actor, task: AssistantBusinessTask) {
    task.updatedAt = now();
    if (this.taskBytes > 0 && Buffer.byteLength(JSON.stringify(task), 'utf8') > this.taskBytes)
      throw new ImportError('任务记录过大，请保留结果后开始新任务。', 409);
    const r = this.store.db
      .prepare(
        "UPDATE assistant_threads SET document=json_set(document,'$.businessTask',json(?)),updated_at=? WHERE id=? AND user_id=?",
      )
      .run(JSON.stringify(task), now(), threadId, actor.id);
    if (!r.changes) throw new ImportError('任务会话已删除。', 409);
    return task;
  }
  begin(threadId: string, actor: Actor, goal: string, newTask = false) {
    let task = this.get(threadId, actor);
    if (newTask && task) {
      const history = [...this.history(threadId, actor).filter((t) => t.id !== task!.id), task];
      if (
        this.archiveBytes > 0 &&
        Buffer.byteLength(JSON.stringify(history), 'utf8') > this.archiveBytes
      )
        throw new ImportError('本会话任务档案达到上限，请新建会话；原任务保留。');
      this.store.db
        .prepare(
          "UPDATE assistant_threads SET document=json_set(document,'$.taskArchive',json(?)) WHERE id=? AND user_id=?",
        )
        .run(JSON.stringify(history), threadId, actor.id);
      this.store.db
        .prepare('UPDATE assistant_previews SET expires_at=0 WHERE thread_id=? AND result IS NULL')
        .run(threadId);
      task = null;
    }
    if (task) return task;
    return this.put(threadId, actor, {
      id: randomUUID(),
      goal: goal.slice(0, 1000),
      state: 'running',
      stage: '准备业务步骤',
      createdAt: now(),
      updatedAt: now(),
      steps: [],
    });
  }
  history(threadId: string, actor: Actor): AssistantBusinessTask[] {
    const r = this.store.db
      .prepare('SELECT document FROM assistant_threads WHERE id=? AND user_id=?')
      .get(threadId, actor.id);
    if (!r) throw new ImportError('任务不属于当前账号或会话。', 403);
    const d = JSON.parse(String(r.document));
    return d.taskArchive || (d.previousBusinessTask ? [d.previousBusinessTask] : []);
  }
  activate(threadId: string, actor: Actor, taskId: string) {
    const current = this.get(threadId, actor),
      history = this.history(threadId, actor),
      selected = history.find((t) => t.id === taskId);
    if (current?.id === taskId) return current;
    if (!selected) throw new ImportError('任务不存在或不属于当前会话。', 403);
    const next = history.filter((t) => t.id !== taskId);
    if (current) next.push(current);
    if (selected.state === 'running') {
      selected.state = 'paused';
      selected.stage = '已恢复保留任务，继续前核验服务器结果';
    }
    this.store.db
      .prepare(
        "UPDATE assistant_threads SET document=json_set(document,'$.taskArchive',json(?),'$.businessTask',json(?)) WHERE id=? AND user_id=?",
      )
      .run(JSON.stringify(next), JSON.stringify(selected), threadId, actor.id);
    return selected;
  }
  plan(threadId: string, actor: Actor, raw: unknown, available: (tool: string) => unknown) {
    const v = taskPlanSchema.parse(raw),
      task = this.begin(threadId, actor, v.goal);
    for (const s of v.steps) {
      if (s.tool.startsWith('task.')) throw new ImportError('任务步骤不能递归调用任务管理工具。');
      available(s.tool);
      const key = s.args ? durableCallKey(s.tool, s.args) : undefined;
      if (
        task.steps.some(
          (x) => x.tool === s.tool && ((key && x.key === key) || (!key && x.label === s.label)),
        )
      )
        continue;
      task.steps.push({
        id: randomUUID(),
        tool: s.tool,
        label: s.label,
        args: s.args,
        key,
        state: 'planned',
        updatedAt: now(),
      });
    }
    task.goal = v.goal;
    task.state = 'running';
    task.execution = { state: 'working' };
    task.stage = '计划已保存，尚未执行剩余步骤';
    return this.put(threadId, actor, task);
  }
  stage(
    threadId: string,
    actor: Actor,
    call: { name: string; args: any; stepId?: string },
    goal: string,
    scope: any,
    async = false,
  ) {
    const task = this.begin(threadId, actor, goal),
      key = durableCallKey(call.name, call.args, scope);
    let step = task.steps.find((x) => x.key === key);
    if (!step && call.stepId) {
      step = task.steps.find((x) => x.id === call.stepId);
      if (!step || step.tool !== call.name) throw new ImportError('工具步骤不属于当前任务。', 409);
      if (
        step.attemptedAt &&
        JSON.stringify(step.args?.outcome) !== JSON.stringify(call.args?.outcome)
      )
        throw new ImportError('已尝试页面步骤不能更换核验目标。', 409);
      if (step.state === 'completed') throw new ImportError('已完成步骤不能更换参数重放。', 409);
    }
    if (!step)
      step = task.steps.find(
        (x) =>
          x.tool === call.name &&
          x.state === 'planned' &&
          (!x.args || durableCallKey(call.name, x.args, scope) === key),
      );
    if (!step) {
      const target = (a: any) =>
        JSON.stringify(
          canonical({
            module: a?.module || a?.input?.module,
            id: a?.id || null,
            items: a?.items?.map?.((x: any) => x.id),
          }),
        );
      const failed = task.steps.filter(
        (x) =>
          x.tool === call.name &&
          x.state === 'failed' &&
          !x.async &&
          target(x.args) === target(call.args),
      );
      if (failed.length === 1) {
        step = failed[0];
        step.state = 'planned';
        step.error = undefined;
      }
    }
    if (!step) {
      step = {
        id: randomUUID(),
        key,
        tool: call.name,
        label: call.name,
        args: call.args,
        state: 'planned',
        updatedAt: now(),
        async,
      };
      task.steps.push(step);
    }
    if (step.state !== 'completed') {
      step.key = key;
      step.args = structuredClone(call.args);
      step.scope = scope;
      step.async = async;
    }
    this.put(threadId, actor, task);
    return structuredClone(step);
  }
  saveBudget(
    threadId: string,
    actor: Actor,
    goal: string,
    budget: import('../../shared/assistant-task.js').AgentBudgetView,
  ) {
    const task = this.get(threadId, actor) || this.begin(threadId, actor, goal);
    task.budget = budget;
    return this.put(threadId, actor, task);
  }
  update(threadId: string, actor: Actor, id: string, patch: Partial<BusinessTaskStep>) {
    const task = this.get(threadId, actor),
      step = task?.steps.find((x) => x.id === id);
    if (!task || !step) throw new ImportError('任务步骤已失效。', 409);
    Object.assign(step, patch, { updatedAt: now() });
    task.stage = step.label;
    task.state =
      patch.state === 'waiting'
        ? 'waiting'
        : patch.state === 'failed' || patch.state === 'uncertain'
          ? 'paused'
          : 'running';
    if (patch.result !== undefined) {
      step.result = receiptOnly(patch.result);
      task.lastResult = step.label;
    }
    return this.put(threadId, actor, task);
  }
  done(threadId: string, actor: Actor, id: string, result: any, previewId?: string) {
    const step = this.get(threadId, actor)?.steps.find((s) => s.id === id);
    const formal =
      !!previewId ||
      !!result?.order?.id ||
      !!result?.workspace?.imported?.orderId ||
      !!(result?.results?.length && result.results.every((r: any) => r.success && r.order?.id));
    const saved = this.update(threadId, actor, id, {
      state: 'completed',
      completion: {
        kind: formal
          ? 'business'
          : ['page.act', 'browser.act'].includes(step?.tool || '')
            ? 'interaction'
            : step?.tool.startsWith('order_import.')
              ? 'draft'
              : 'read',
        verified: true,
      },
      result,
      ...(previewId ? { previewId } : {}),
      error: undefined,
    });
    for (const old of saved.steps) {
      if (old.id === id || old.state !== 'failed' || old.tool !== step?.tool) continue;
      const sameScope =
        JSON.stringify(canonical(old.scope || {})) === JSON.stringify(canonical(step.scope || {}));
      if (sameScope && old.key === step.key) this.supersede(threadId, actor, old.id, id);
      else if (
        sameScope &&
        old.tool === 'order_import.edit' &&
        old.args?.operations?.length &&
        result?.workspace?.draft
      ) {
        const draft = result.workspace.draft;
        if (
          old.args.operations.every(
            (op: any) =>
              (op.op === 'set-header'
                ? draft.header[op.field]?.value
                : draft.lines.find((l: any) => l.id === op.lineId)?.fields[op.field]?.value) ===
              op.value,
          )
        )
          this.supersede(threadId, actor, old.id, id);
      }
    }
    return this.get(threadId, actor)!;
  }
  fail(threadId: string, actor: Actor, id: string, error: string, uncertain = false) {
    const step = this.get(threadId, actor)?.steps.find((x) => x.id === id);
    if (step?.state === 'completed' || step?.state === 'uncertain') return;
    return this.update(threadId, actor, id, {
      state: uncertain ? 'uncertain' : 'failed',
      error: error.slice(0, 600),
    });
  }
  needsBusinessProof(threadId: string, actor: Actor) {
    const task = this.get(threadId, actor);
    if (!task) return false;
    if (
      !/保存|创建|新建|新增|修改|更新|删除|清空|归档|恢复|导入|确认|入库|出库|领料|完工|发货|发出|送货|采购|下单/.test(
        task.goal,
      ) ||
      /^(?:打开|进入|导航|填写|选择|查看|查询|解释|说明|介绍|统计|汇总|列出)/.test(task.goal) ||
      /^(?:请问|想了解)?(?:如何|怎么|能否|是否)/.test(task.goal)
    )
      return false;
    if (!task.steps.length) return true; // 零业务回执不能证明业务目标已完成。
    return (
      task.steps.some(
        (s) =>
          ['page.act', 'browser.act'].includes(s.tool) &&
          s.completion?.kind === 'interaction' &&
          (['submit', 'click'].includes(s.args?.action) ||
            (s.args?.action === 'key' && s.args.key === 'Enter')),
      ) && !task.steps.some((s) => s.completion?.kind === 'business' && s.completion.verified)
    );
  }
  execution(
    threadId: string,
    actor: Actor,
    execution: NonNullable<AssistantBusinessTask['execution']>,
  ) {
    const task = this.get(threadId, actor);
    if (!task) return null;
    task.execution = execution;
    return this.put(threadId, actor, task);
  }
  finish(
    threadId: string,
    actor: Actor,
    reason: 'normal' | 'limit' | 'error' | 'protocol' | 'waiting' = 'normal',
  ) {
    const task = this.get(threadId, actor);
    if (!task) return null;
    const unfinished = task.steps.filter((x) => !['completed', 'superseded'].includes(x.state)),
      missingProof = this.needsBusinessProof(threadId, actor);
    // 最终回复正常结束、且没有仍可续办的 waiting/planned 步骤时，旧失败/不确定步骤
    // 只代表本轮已处理过的尝试，不能一直把任务挂在“未完成”。真实未完成会以
    // waiting/planned 步骤或 blocked 状态保留。
    if (reason === 'normal' && !missingProof && !unfinished.some((x) => x.state !== 'failed'))
      for (const step of unfinished) step.state = 'superseded';
    const pending = task.steps.filter((x) => !['completed', 'superseded'].includes(x.state));
    task.state =
      reason === 'waiting' || pending.some((x) => x.state === 'waiting')
        ? 'waiting'
        : reason !== 'normal' || pending.length || missingProof
          ? 'paused'
          : 'completed';
    task.execution = {
      state:
        task.state === 'completed'
          ? 'completed'
          : task.state === 'waiting'
            ? 'needs_input'
            : 'blocked',
      ...(task.execution?.questions?.length ? { questions: task.execution.questions } : {}),
      reason: task.execution?.reason,
    };
    task.stage =
      reason === 'limit'
        ? '本轮预算已到，已保存进度'
        : reason === 'protocol'
          ? '模型协议异常，步骤未重放'
          : reason === 'error'
            ? '请求中断，继续前核验'
            : reason === 'waiting'
              ? '等待必要的业务决定或原业务确认'
              : missingProof
                ? '页面交互已返回，业务结果仍待真实核验'
                : pending.length
                  ? '尚有未执行步骤'
                  : '所有已列步骤都有服务器结果';
    return this.put(threadId, actor, task);
  }
  private bootstrap(threadId: string, actor: Actor) {
    const message = this.store.db
      .prepare(
        "SELECT rowid,text,document FROM assistant_messages WHERE thread_id=? AND role='assistant' ORDER BY rowid DESC LIMIT 1",
      )
      .get(threadId);
    if (!message) return null;
    const meta = JSON.parse(String(message.document));
    if (
      !meta.error &&
      !meta.degraded &&
      !meta.events?.some((e: any) => e.state === '未执行') &&
      !String(message.text).startsWith('本轮工具调用已达上限')
    )
      return null;
    const goal = this.store.db
      .prepare(
        "SELECT text FROM assistant_messages WHERE thread_id=? AND role='user' AND rowid<? ORDER BY rowid DESC LIMIT 1",
      )
      .get(threadId, message.rowid)?.text;
    const task: AssistantBusinessTask = {
      id: randomUUID(),
      goal: String(goal || '恢复此前未完成业务').slice(0, 1000),
      state: 'paused',
      stage: '从此前成功执行回执恢复',
      createdAt: now(),
      updatedAt: now(),
      steps: [],
    };
    for (const executed of [...(meta.executions || []), ...(meta.plans || [])]) {
      const previewId = executed.previewId || executed.id;
      if (!previewId) continue;
      const row = this.store.db
        .prepare(
          'SELECT document,result FROM assistant_previews WHERE id=? AND thread_id=? AND user_id=?',
        )
        .get(previewId, threadId, actor.id);
      if (!row) continue;
      const plan = JSON.parse(String(row.document)).plan,
        a = plan.args;
      let args: any;
      if (plan.tool === 'records.propose_save')
        args = {
          module: a.module,
          ...(a.id ? { id: a.id } : {}),
          patch: Object.fromEntries(
            (a.fields || Object.keys(a.input)).map((k: string) => [k, a.input[k]]),
          ),
        };
      else if (plan.tool === 'flow.propose_confirmation') args = { id: a.id };
      else if (plan.tool === 'developer.execute' || plan.tool === 'management.execute')
        args = a.input;
      else if (plan.tool === 'inventory.propose_movement')
        args = {
          id: a.id,
          ...Object.fromEntries(
            ['action', 'quantity', 'date', 'notes'].map((k) => [k, a.input[k]]),
          ),
        };
      else args = { ...a };
      task.steps.push({
        id: randomUUID(),
        tool: plan.tool,
        label: plan.label,
        args,
        key: durableCallKey(plan.tool, args),
        state: row.result ? 'completed' : 'waiting',
        previewId,
        result: row.result ? receiptOnly(JSON.parse(String(row.result))) : undefined,
        updatedAt: now(),
      });
    }
    return task.steps.length ? this.put(threadId, actor, task) : null;
  }
  verify(threadId: string, actor: Actor, tools: AssistantTools) {
    const task = this.get(threadId, actor) || this.bootstrap(threadId, actor);
    if (!task) return null;
    for (const step of task.steps) {
      if (
        step.tool === 'page.act' &&
        step.state === 'completed' &&
        step.verification?.currentStateVerified &&
        !step.pageOutcome
      ) {
        step.state = 'uncertain';
        step.error = '旧版页面核验没有绑定每步独立目标，不能继续视为已完成。';
      }
      if (step.previewId) {
        const receipt = this.store.db
          .prepare(
            'SELECT result,document FROM assistant_previews WHERE id=? AND user_id=? AND thread_id=?',
          )
          .get(step.previewId, actor.id, threadId);
        if (receipt?.result) {
          step.state = 'completed';
          step.result = receiptOnly(JSON.parse(String(receipt.result)));
          const plan = JSON.parse(String(receipt.document)).plan;
          const flowModules: Record<string, string> = {
            task: 'production_tasks',
            production: 'production_records',
            arrival: 'arrivals',
            delivery: 'deliveries',
          };
          const module =
              plan.args.module ||
              (plan.args.input
                ? flowModules[plan.args.input.module] ||
                  (plan.args.input.module === 'stock_items'
                    ? plan.after?.results?.[0]?.kind === 'finished'
                      ? 'finished_inventory'
                      : 'raw_inventory'
                    : plan.args.input.module)
                : undefined) ||
              (plan.tool.startsWith('flow.')
                ? flowModules[plan.before?.kind]
                : plan.tool === 'inventory.propose_movement'
                  ? plan.before?.kind === 'raw'
                    ? 'raw_inventory'
                    : 'finished_inventory'
                  : plan.tool === 'purchase.propose_receipt'
                    ? 'purchases'
                    : undefined),
            id =
              plan.args.id ||
              step.result?.id ||
              step.result?.results?.[0]?.id ||
              plan.args.input?.items?.[0]?.id;
          let current: any;
          try {
            if (module && id) current = tools.read('records.get', { module, id }, actor);
          } catch {
            current = { message: '当前记录已归档、删除或不可见；已执行回执仍保留，不能重复写入' };
          }
          step.verification = { at: now(), receiptVerified: true, current };
        } else if (step.state === 'completed') {
          step.state = 'uncertain';
          step.error = '成功回执不存在，禁止重放；请先核对实际记录。';
        } else if (step.state === 'running' && !step.async) {
          step.state = 'planned';
          step.verification = {
            at: now(),
            receiptVerified: false,
            message: '原事务没有提交回执，可重新校验业务条件',
          };
        }
      } else if (step.state === 'running') {
        step.state = step.async ? 'uncertain' : 'planned';
        step.error = step.async
          ? '外部操作结果尚未核实，禁止自动重放；先读取关联文件任务。'
          : undefined;
      }
    }
    if (task.steps.some((s) => s.state === 'uncertain')) {
      task.state = 'paused';
      task.stage = '有待核验步骤，不能跳过或重放';
    }
    return this.put(threadId, actor, task);
  }
  context(threadId: string, actor: Actor) {
    const task = this.get(threadId, actor);
    if (!task) return null;
    return {
      ...task,
      memory: task.memory
        ? {
            decisions: task.memory.decisions,
            workspaceIds: task.memory.workspaceIds,
            files: task.memory.files,
            latestUserMessageId: task.memory.turns.at(-1)?.id,
          }
        : undefined,
      budget: task.budget
        ? { used: task.budget.used, limits: task.budget.limits, stopReason: task.budget.stopReason }
        : undefined,
      otherTasks: this.history(threadId, actor)
        .slice(-8)
        .map((t) => ({
          id: t.id,
          goal: t.goal,
          state: t.state,
          references: t.steps
            .filter((s) => s.completion?.kind === 'business' && s.completion.verified)
            .slice(-5)
            .map((s) => ({
              tool: s.tool,
              id: s.result?.id,
              orderId: s.result?.orderId,
              number: s.result?.number,
              outputs: s.result?.outputs
                ? Object.fromEntries(
                    Object.entries(s.result.outputs).map(([key, v]: any) => [
                      key,
                      { id: v?.id, number: v?.number },
                    ]),
                  )
                : undefined,
            })),
        })),
      steps: task.steps.map((s, i) => {
        const read = [
            'records.search',
            'records.get',
            'records.summarize',
            'overview.get',
          ].includes(s.tool),
          compact =
            read || i < task.steps.length - 10 || JSON.stringify(s.result || {}).length > 12000;
        return {
          ...s,
          result: compact
            ? {
                summary: '已保留结果，详情按关联ID读取',
                id: s.result?.id,
                number: s.result?.number,
                total: s.result?.total,
                workspaceId: s.result?.workspaceId,
                documentTaskId: s.result?.documentTaskId,
                outputs: s.result?.outputs
                  ? Object.fromEntries(
                      Object.entries(s.result.outputs).map(([key, v]: any) => [
                        key,
                        {
                          id: v?.id,
                          version: v?.version,
                          number: v?.number,
                          results: v?.results?.map((x: any) => ({ id: x.id, version: x.version })),
                          lines: v?.lines?.map((x: any) => ({
                            id: x.id,
                            stockItemId: x.stockItemId,
                            productId: x.productId,
                          })),
                        },
                      ]),
                    )
                  : undefined,
              }
            : s.result,
          ...(compact
            ? {
                verification: s.verification
                  ? { at: s.verification.at, receiptVerified: s.verification.receiptVerified }
                  : undefined,
              }
            : {}),
        };
      }),
    };
  }
  successfulPlan(threadId: string, actor: Actor, plan: any) {
    const task = this.get(threadId, actor);
    if (!task) return null;
    const signature = (p: any) => {
      const args = structuredClone(p.args);
      if (p.tool === 'records.propose_save' && !args.id) {
        delete args.input.notes;
        delete args.input.operator;
        delete args.fields;
      } else if (p.tool === 'inventory.propose_movement') delete args.input.notes;
      delete args.fields;
      return durableCallKey(p.tool, args);
    };
    for (const s of task.steps) {
      if (s.state !== 'completed' || !s.previewId) continue;
      const row = this.store.db
        .prepare(
          'SELECT document,result FROM assistant_previews WHERE id=? AND user_id=? AND thread_id=? AND result IS NOT NULL',
        )
        .get(s.previewId, actor.id, threadId);
      if (row && signature(JSON.parse(String(row.document)).plan) === signature(plan))
        return { ...s, result: JSON.parse(String(row.result)) };
    }
    return null;
  }
  recoverRunning() {
    for (const r of this.store.db
      .prepare(
        "SELECT id,user_id,document FROM assistant_threads WHERE json_extract(document,'$.businessTask.state')='running'",
      )
      .all()) {
      const t = JSON.parse(String(r.document)).businessTask as AssistantBusinessTask;
      t.state = 'paused';
      t.stage = '服务已重启，等待数据库核验后继续';
      this.store.db
        .prepare(
          "UPDATE assistant_threads SET document=json_set(document,'$.businessTask',json(?)) WHERE id=?",
        )
        .run(JSON.stringify(t), r.id);
    }
  }
}
