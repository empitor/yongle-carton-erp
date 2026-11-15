import { useRef, useState } from 'react';
import { completableTask, type CompletionPreview as CompletionPlan, type FlowApi } from '../../shared/business/index';
import { errorMessage, today } from '../../shared/core/index';
import type { Allocation, Material } from './CompletionSections';
import { completionRow, type CompletionRow, type CompletionTask } from './CompletionTasks';
import { completionInput, type Distribution } from './completion-input';
import { executeCompletion, previewCompletion } from './flow-api';
import type { UntaskedRow } from './UntaskedCompletions';

/** 登记完工的结果（r.pending 为 true 是只登记、待核对入库，否则已入库） */
export type CompletionResult = FlowApi['POST /flow/production-completion/execute']['response'];

/** 能登记完工的任务，按计划生产日先后排，最该做完的在上面 */
function openTasks(tasks: readonly CompletionTask[]) {
  const plan = (t: CompletionTask) => t.plannedDate || t.date || '';
  return tasks.filter(completableTask).sort((a, b) => (plan(a) < plan(b) ? -1 : plan(a) > plan(b) ? 1 : 0));
}
/** 打开时的任务行：从页头进来列出全部、都不勾；从任务进来只列这几张、都勾上 */
function firstRows(open: CompletionTask[], taskIds: number[]): CompletionRow[] {
  return taskIds.length
    ? open.filter((t) => taskIds.includes(t.id)).map((t, i) => completionRow(t, i, true))
    : open.map((t, i) => completionRow(t, i, false));
}

/**
 * 登记完工窗口的状态和登记：填的内容、看过的领料分配（preview）、出错和办理中。改了任何内容都调 changed：
 * 作废已看过的领料分配，换新的请求号。一行一步登记；几行（任务、不挂任务的）共用纸板时先看分配结果再确认。
 */
export function useProductionBatch(o: { tasks: readonly CompletionTask[]; taskIds: number[]; done: (r: CompletionResult) => void }) {
  const open = openTasks(o.tasks);
  const [rows, setRows] = useState(() => firstRows(open, o.taskIds)),
    [untasked, setUntasked] = useState<UntaskedRow[]>([]),
    [date, setDate] = useState(today()),
    [operator, setOperator] = useState(''),
    [allocation, setAllocation] = useState<Allocation>('shared-proportional'),
    // 批次备注：记到这次生成的每张完工单上，会显示在成品库存的批次里
    [notes, setNotes] = useState(''),
    [materials, setMaterials] = useState<Material[]>([{ stockId: '', issued: '', returned: '0' }]),
    [distribution, setDistribution] = useState<Distribution>({}),
    [preview, setPreview] = useState<CompletionPlan | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  // pending：只登记、稍后核对入库。和直接入库是两次不同的登记，请求编号分开（重复提交同一种才算同一次）
  const request = useRef(crypto.randomUUID()),
    pendingRequest = useRef(crypto.randomUUID());
  const chosen = rows.filter((r) => r.checked).sort((a, b) => a.order - b.order);
  const changed = () => {
    setPreview(null);
    request.current = crypto.randomUUID();
    pendingRequest.current = crypto.randomUUID();
  };
  const lines = chosen.length + untasked.length;
  const needsReview = lines > 1 && !preview;
  /**
   * 登记：pending 是“先登记，稍后核对入库”，同一套预览和拆分，存成待入库的完工单、不动库存，不用先看领料怎么分
   * （每张的用料核对入库时再看）；直接入库时几张任务共用纸板先看分配结果再确认。
   */
  const submit = async (pending: boolean) => {
    setBusy(true);
    setError('');
    try {
      const fields = { date, operator, chosen, untasked, allocation, notes, materials, distribution };
      const input = completionInput(fields, (pending ? pendingRequest : request).current, pending);
      const checked = (!pending && preview) || (await previewCompletion(input));
      if (!pending && needsReview) setPreview(checked);
      else o.done(await executeCompletion(input, checked.previewDigest));
    } catch (e) {
      setError(errorMessage(e));
      setPreview(null);
    } finally {
      setBusy(false);
    }
  };
  return {
    picking: !o.taskIds.length,
    others: open.filter((t) => !rows.some((r) => r.id === t.id)),
    rows, setRows, untasked, setUntasked, date, setDate, operator, setOperator, allocation, setAllocation,
    notes, setNotes, materials, setMaterials, distribution, setDistribution, preview, error, busy,
    chosen,
    changed,
    ready: lines > 0 && untasked.every((u) => u.productId),
    needsReview,
    submit,
  };
}
/** 登记完工窗口的状态和登记（useProductionBatch 的返回） */
export type ProductionBatch = ReturnType<typeof useProductionBatch>;
