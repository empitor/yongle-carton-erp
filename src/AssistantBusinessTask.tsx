import { CheckCircle2, Clock3, LoaderCircle, AlertCircle, Play, ListChecks } from 'lucide-react';
import { taskStates, type AssistantBusinessTask } from '../shared/assistant-task';
export default function AssistantBusinessTaskPanel({
  task,
  busy,
  resume,
  newTask,
  pendingNew,
  diagnostics,
  history = [],
  activate,
}: {
  task: AssistantBusinessTask | null | undefined;
  busy: boolean;
  resume: () => void;
  newTask: () => void;
  pendingNew: boolean;
  diagnostics: () => void;
  history?: { id: string; goal: string; state: string }[];
  activate: (id: string) => void;
}) {
  if (!task) return null;
  const done = task.steps.filter((s) => ['completed', 'superseded'].includes(s.state)).length;
  return (
    <section className="ga-business-task" aria-label="业务任务执行进度">
      <details open={task.state !== 'completed'}>
        <summary>
          <ListChecks size={15} />
          <strong>
            {task.execution
              ? {
                  working: '正在执行',
                  needs_input: '等待业务决定',
                  completed: '已核验完成',
                  blocked: '执行受阻，进度已保存',
                }[task.execution.state]
              : taskStates[task.state]}
          </strong>
          <span>
            {done}/{task.steps.length} 步
          </span>
        </summary>
        <p>{task.goal}</p>
        <small>{task.stage}</small>
        {task.budget && (
          <div className="ga-budget" aria-label="本轮Agent预算">
            <p>
              模型 {task.budget.used.modelCalls}/{task.budget.limits.modelCalls || '持续'} · 工具{' '}
              {task.budget.used.toolCalls}/{task.budget.limits.toolCalls || '持续'}
            </p>
            <p>
              只读 {task.budget.readOperations} · 页面交互 {task.budget.used.pageInteractions}/
              {task.budget.limits.pageInteractions || '持续'} · 业务写入/预占{' '}
              {task.budget.used.businessWrites}/{task.budget.limits.businessWrites || '持续'}
            </p>
            <p>
              工具输出 {task.budget.toolOutputChars.toLocaleString()} 字符 · 约{' '}
              {task.budget.estimatedToolOutputTokens.toLocaleString()} Token（估算，字符数÷3）
            </p>
            <p>
              {task.budget.providerUsage.requests
                ? `Provider真实用量：输入 ${task.budget.providerUsage.inputReports ? task.budget.providerUsage.inputTokens : '未提供'} / 输出 ${task.budget.providerUsage.outputReports ? task.budget.providerUsage.outputTokens : '未提供'} Token（${task.budget.providerUsage.requests}/${task.budget.used.modelCalls} 次请求有报告）`
                : 'Provider未提供真实Token用量；上方仅为工具输出估算。'}
            </p>
            {!!task.budget.providerUsage.cachedReports && (
              <p>
                输入缓存命中 {task.budget.providerUsage.cachedInputTokens}{' '}
                Token（包含在输入用量中，不重复累加）
              </p>
            )}
            {!!task.budget.providerUsage.reasoningReports && (
              <p>其中推理 {task.budget.providerUsage.reasoningTokens} Token（包含在输出用量中）</p>
            )}
            {task.budget.stopReason && <p>{task.budget.stopReason}</p>}
          </div>
        )}
        {!!history.length && (
          <select
            aria-label="切换保留业务任务"
            disabled={busy}
            value=""
            onChange={(e) => activate(e.target.value)}
          >
            <option value="">切换保留的任务…</option>
            {history.map((t) => (
              <option key={t.id} value={t.id}>
                {t.goal.slice(0, 30)} · {t.id.slice(0, 8)}
              </option>
            ))}
          </select>
        )}
        <ol>
          {task.steps.map((s) => (
            <li key={s.id} data-state={s.state}>
              {s.state === 'completed' ? (
                <CheckCircle2 size={14} />
              ) : s.state === 'running' && busy ? (
                <LoaderCircle size={14} className="spin" />
              ) : ['failed', 'uncertain'].includes(s.state) ? (
                <AlertCircle size={14} />
              ) : (
                <Clock3 size={14} />
              )}
              <div>
                <strong>{s.label}</strong>
                <small>
                  {
                    {
                      planned: '待完成',
                      running: busy ? '正在执行' : '已中断，继续前核验',
                      completed:
                        s.completion?.kind === 'draft'
                          ? '草稿已保存 · 尚不代表正式提交'
                          : s.completion?.kind === 'business'
                            ? '正式业务结果已核验'
                            : s.completion?.kind === 'interaction'
                              ? '页面交互已返回'
                              : s.verification
                                ? '已完成 · 数据库已核验'
                                : '已完成 · 服务器回执',
                      waiting:
                        s.tool === 'page.act'
                          ? '页面交互已返回，等待该步业务核验'
                          : '等待原业务确认',
                      failed: '执行失败，可修正后继续',
                      uncertain: '结果待核实，禁止直接重放',
                      superseded: '已替代 · 后续成功结果已核验',
                    }[s.state]
                  }
                </small>
                {s.error && <p>{s.error}</p>}
              </div>
            </li>
          ))}
        </ol>
      </details>
      <div className="ga-task-actions">
        {task.state !== 'completed' && (
          <button disabled={busy} onClick={resume}>
            <Play size={13} />
            核验并继续
          </button>
        )}
        <button disabled={busy} onClick={newTask}>
          {pendingNew ? '下一条将开始新任务' : '开始新任务'}
        </button>
        <button disabled={busy} onClick={diagnostics}>
          下载协议诊断
        </button>
      </div>
    </section>
  );
}
