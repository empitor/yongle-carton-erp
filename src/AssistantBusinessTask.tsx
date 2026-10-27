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
  const done = task.steps.filter((s) => s.state === 'completed').length;
  return (
    <section className="ga-business-task" aria-label="业务任务执行进度">
      <details open={task.state !== 'completed'}>
        <summary>
          <ListChecks size={15} />
          <strong>{taskStates[task.state]}</strong>
          <span>
            {done}/{task.steps.length} 步
          </span>
        </summary>
        <p>{task.goal}</p>
        <small>
          任务 #{task.id.slice(0, 8)} · {task.stage}
        </small>
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
                      completed: s.verification ? '已完成 · 数据库已核验' : '已完成 · 服务器回执',
                      waiting: '等待原业务确认',
                      failed: '执行失败，可修正后继续',
                      uncertain: '结果待核实，禁止直接重放',
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
