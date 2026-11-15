import { useRef, useState, type RefObject } from 'react';
import { ZodError } from 'zod';
import { flowInput, planDate, type FlowDocView, type FlowKind } from '../../shared/business/index';
import { errorMessage, userError } from '../../shared/core/index';
import { lifecycleOutcome } from '../recordkit/lifecycle';
import type { FlowUndoing } from './desk-windows';
import {
  archiveFlows,
  confirmPreview,
  createFlow,
  previewFlow,
  scheduleFlow,
  undoFlow,
  updateFlow,
  type FlowReview,
} from './flow-api';
import type { FlowEditing } from './flow-prefill';
import { actionNotice, confirmedMessage, savedMessage } from './flow-words';
import { detailLookups, latest, type LookupNeed } from './lookups';

/**
 * 单据办理里“点一下就去办”的那一步：同一时间只办一件（防连点），办理中按钮不让点；
 * 没办成的原因给窗口显示。前端校验没过（ZodError）逐项说清是哪一行哪个字段。
 * 不用 src/ui 的 useAction：要防重复、要格式化校验错误，原因也会由别处（读档案、批量结果）写进来。
 */
export function useDeskWork() {
  const working = useRef(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function work(job: () => Promise<void>) {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError('');
    try {
      await job();
    } catch (e) {
      // 编辑窗会同时把空着的必填项标红并滚过去
      setError(
        e instanceof ZodError
          ? [...new Set(e.issues.map((i) => userError(i.path.join('.') + ': ' + i.message)))].join('；')
          : errorMessage(e),
      );
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  return { busy, error, setError, work };
}

type Setter<T> = (value: T) => void;
/** 要调整排程的单据：生产任务、送货单 */
type Scheduled = FlowDocView<'task' | 'delivery'>;
/** 列表、详情、选择条要办的事：删除、归档、恢复，和要写原因确认的取消、撤销 */
export type FlowAsk = 'delete' | 'archive' | 'restore' | FlowUndoing['type'];

/** 办理动作要用的状态和改状态的函数（都在 useFlowDesk 里） */
export type DeskState = {
  kind: FlowKind;
  dialogOnly: boolean;
  editor: FlowEditing | null;
  editorKind: FlowKind;
  preview: FlowReview | null;
  action: FlowUndoing | null;
  reason: string;
  scheduling: Scheduled | null;
  newPlanDate: string;
  newPlanTime: string;
  saveRequest: RefObject<string>;
  scheduleRequest: RefObject<string>;
  setEditor: Setter<FlowEditing | null>;
  setPreview: Setter<FlowReview | null>;
  setView: Setter<FlowDocView | null>;
  setBatch: Setter<{ taskIds: number[] } | null>;
  setAction: Setter<FlowUndoing | null>;
  setReason: Setter<string>;
  setScheduling: Setter<Scheduled | null>;
  setNewPlanDate: Setter<string>;
  setNewPlanTime: Setter<string>;
  setDeleting: Setter<FlowDocView[] | null>;
  setSelected: Setter<number[]>;
  setNotice: Setter<string>;
  setError: Setter<string>;
  /** 从别的页面弹出时提示在页面底部，单据页里显示在列表上方 */
  notify: Setter<string>;
  refresh: () => void;
  ensureLookups: (needs: LookupNeed[]) => Promise<unknown>;
  work: (job: () => Promise<void>) => Promise<void>;
};

/**
 * 存编辑窗里的单据：有编号是改已有的这张（带打开时的版本号），没有是新登记——
 * 单据编辑窗新建只剩没有采购单的到货（flow-prefill.ts），别的种类各有自己的窗口。
 */
function saveEditing(kind: FlowKind, editor: FlowEditing, requestId: string) {
  if (editor.id) return updateFlow(editor.id, { ...flowInput(kind, editor), requestId, version: editor.version });
  return createFlow('arrival', { ...flowInput('arrival', editor), requestId });
}

/** 单据的办理动作：保存、核对、确认、登记完工、撤销取消、归档恢复、删除、调整排程。 */
export function deskActions(d: DeskState) {
  const { kind, work } = d;
  const finish = (doc: FlowDocView, message: string) => {
    d.setEditor(null);
    d.setPreview(null);
    // 别的类型的单据（生产任务页里登记的完工）不在这一页的列表里，只提示，不开详情
    d.setView(d.dialogOnly || doc.kind !== kind ? null : doc);
    d.notify(message);
    d.refresh();
  };
  const save = () =>
    work(async () => {
      const k = d.editorKind,
        editor = d.editor;
      // 只有编辑窗开着时才有“保存”
      if (!editor) return;
      const result = await saveEditing(k, editor, d.saveRequest.current);
      finish(result, savedMessage({ kind: k, pageKind: kind, editor, result }));
    });
  const review = (r: FlowDocView) =>
    work(async () => {
      const [next] = await Promise.all([
        previewFlow(r.id),
        // 核对页要显示当前库存，先读最新的库存品；读不到时核对页照常打开，下面会再读。
        d.ensureLookups([...detailLookups(r), ['items', true]]).catch(() => null),
      ]);
      d.setPreview(next);
      d.setView(null);
    });
  /** 登记完工要用最新的任务、产品和库存；taskIds 为空时列出全部没做完的任务。 */
  const openCompletion = (taskIds: number[]) =>
    work(async () => {
      await d.ensureLookups(latest(['tasks', 'products', 'items'])).catch((e: unknown) => d.setError(errorMessage(e)));
      d.setBatch({ taskIds });
    });
  const confirm = () =>
    work(async () => {
      const preview = d.preview;
      // 只有核对窗开着时才有“确认”
      if (!preview) return;
      // 核对时单据、库存或关联档案被别人改了：窗口直接换成最新的核对内容，说清楚再看一遍，不留着旧的
      const result = await confirmPreview(preview, async (next) => {
        // 档案读不到也照样换成最新的核对内容（窗口里提示正在读取，useFlowDesk 按要用的档案会再读）
        await d.ensureLookups([...detailLookups(preview.document), ['items', true]]).catch(() => null);
        d.setPreview(next);
      });
      finish(result, confirmedMessage(preview.document.kind));
    });
  return { save, review, openCompletion, confirm, ...batchActions(d), ...scheduleActions(d) };
}

/** 撤销、取消一张一张地办：每张的结果（没办成的带原因） */
async function undoEach(action: FlowUndoing, reason: string) {
  const results: { id: number; number: string; kind: string; success: boolean; message?: string }[] = [];
  for (const r of action.rows) {
    const row = { id: r.id, number: r.number, kind: r.kind };
    try {
      await undoFlow(r.id, action.type, { version: r.version, reason, acknowledged: true });
      results.push({ ...row, success: true });
    } catch (e) {
      results.push({ ...row, success: false, message: errorMessage(e) });
    }
  }
  return results;
}

/**
 * 撤销、取消（一张或几张）、归档恢复、删除。撤销、取消：本机管理员和业务账号一样走单据自己的接口
 * （/flow/:id/reverse、/cancel），和仓库页同一条路，修改历史只记一条、不挂“数据管理”。本机管理员带超级管理员模式，
 * 生产任务、完工的撤销照样能做；服务端的检查（版本、下游单据、库存够不够扣回）两条路本来就是同一个 FlowService。
 */
function batchActions(d: DeskState) {
  const perform = () =>
    d.work(async () => {
      const action = d.action;
      // 只有确认窗开着时才有“确定”
      if (!action) return;
      const results = await undoEach(action, d.reason);
      const failed = results.filter((r) => !r.success),
        done = results.filter((r) => r.success);
      // 一张都没办成：窗口留着，原因显示在窗口里，改了原因可以再试
      if (!done.length && failed.length === 1) {
        d.setError(failed[0].message || '没有办成，请稍后再试。');
        return;
      }
      d.setAction(null);
      d.setView(null);
      d.setSelected([]);
      d.refresh();
      if (done.length) d.setNotice(actionNotice(action.type, done));
      if (failed.length) d.setError(failed.map((r) => (r.number || '单据') + '：' + r.message).join('；'));
    });
  const ask = (type: FlowAsk, r: FlowDocView[]) => {
    // 删除走数据管理的删除窗口（先看影响、再确认），不在这里办
    if (type === 'delete') return d.setDeleting(r);
    if (type === 'archive' || type === 'restore') {
      // 和档案同一个批量接口、同一套说法（src/recordkit/lifecycle.ts）；没办成的留着勾选，原因说一次
      void d.work(async () => {
        const results = await archiveFlows(type, r);
        const outcome = lifecycleOutcome(type, results, (id) => r.find((x) => x.id === id)?.number || '单据', '张');
        d.setView(null);
        d.setSelected(outcome.failed.map((x) => x.id));
        d.refresh();
        if (outcome.notice) d.notify(outcome.notice);
        else d.setError(outcome.problem);
      });
      return;
    }
    d.setReason('');
    d.setError('');
    d.setAction({ type, rows: r });
  };
  return { perform, ask };
}

/** 调整排程（窗口里改）和排产板上拖动改日期：只改计划，不动实际业务和库存。 */
function scheduleActions(d: DeskState) {
  /** 按这张单现在的计划日期、时间预填，换一个新的请求号 */
  const startScheduling = (doc: Scheduled) => {
    d.setError('');
    d.setScheduling(doc);
    d.setNewPlanDate(planDate(doc));
    d.setNewPlanTime(doc.plannedTime || '');
    d.scheduleRequest.current = crypto.randomUUID();
  };
  const saveSchedule = () =>
    void d.work(async () => {
      const doc = d.scheduling;
      // 只有调整排程窗开着时才有“保存”
      if (!doc) return;
      await scheduleFlow(doc.id, {
        plannedDate: d.newPlanDate,
        plannedTime: d.newPlanTime || null,
        expectedVersion: doc.version,
        requestId: d.scheduleRequest.current,
      });
      d.setScheduling(null);
      d.notify('计划日期已改到 ' + d.newPlanDate + '，实际业务和库存没有变。');
      d.refresh();
    });
  const reschedule = (task: Pick<FlowDocView, 'id' | 'number' | 'version'>, plannedDate: string) =>
    void d.work(async () => {
      await scheduleFlow(task.id, { plannedDate, expectedVersion: task.version, requestId: crypto.randomUUID() });
      d.setNotice(task.number + ' 已改到 ' + plannedDate + '，实际业务和库存没有变。');
      d.refresh();
    });
  return { startScheduling, saveSchedule, reschedule };
}
