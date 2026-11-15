import type { Dispatch, SetStateAction } from 'react';
import type { AiProgress } from '../../shared/ai/index';
import { errorMessage } from '../../shared/core/index';
import {
  importStateLabels,
  type DraftOperation,
  type ImportList,
  type ImportMapping,
  type ImportWorkspaceView as Workspace,
} from '../../shared/import/index';
import { taskPhase, type FileMode } from './fileStatus';
import { analyzeWorkspace, readImports, readWorkspace, recognizeArrivalFile, workspaceAction } from './workspace-api';

/**
 * AI 导入页对文件办的事：刷新列表、读一份、识别和修改、取消。状态放在 useOrderWorkspace，
 * 这里拿它交出来的 ctx（引用和设值函数，都不随渲染变）办事，所以 effect 里存着的也能用。
 */
export type WorkspaceCtx = {
  status: { current: ImportList | null };
  cache: { current: Record<string, Workspace> };
  selected: { current: string };
  /** 正在取消、归档的文件：这时回来的识别结果和出错都不要 */
  cancelled: Set<string>;
  /** 正在识别到货单的文件：刷新列表时不动它们的进度 */
  arrivalJobs: Set<string>;
  setStatus: (s: ImportList) => void;
  select: (id: string) => void;
  setJob: (id: string, label: string | null) => void;
  setError: (id: string, message: string) => void;
  setProgress: Dispatch<SetStateAction<Record<string, AiProgress>>>;
  accept: (w: Workspace) => void;
  forget: (ids: string[]) => void;
  setNotice: (text: string) => void;
  setFatal: (text: string) => void;
};
/** 对一份文件办一件事的请求：凭证、打开时的版本号、识别的进度回调 → 办完的工作区 */
type WorkspaceSend = (token: string, revision: number, onProgress: (p: AiProgress) => void) => Promise<Workspace>;

export const tokenOf = (ctx: WorkspaceCtx) => ctx.status.current?.csrfToken || '';
const TIMEOUT_TEXT = '本机前端等待超过630秒；请检查上游超时或重新加载识别结果。';
/** 浏览器等超时（AbortSignal.timeout）抛的错误的名字 */
const isTimeout = (e: unknown) => e instanceof Error && e.name === 'TimeoutError';

export async function load(ctx: WorkspaceCtx, id: string) {
  try {
    ctx.accept(await readWorkspace(id));
  } catch (e) {
    ctx.setError(id, errorMessage(e));
  }
}

/** 重读文件列表，按每份的任务状态更新进度和出错；识别完还没读结果的读一次 */
export async function refresh(ctx: WorkspaceCtx) {
  const s = await readImports();
  ctx.status.current = s;
  ctx.setStatus(s);
  for (const file of s.workspaces) {
    if (ctx.arrivalJobs.has(file.id)) continue;
    const phase = taskPhase(file);
    if (file.mode === 'arrival') {
      ctx.setJob(file.id, phase.kind === 'running' ? phase.label : null);
      continue;
    }
    if (phase.kind === 'running') {
      ctx.setError(file.id, '');
      ctx.setJob(file.id, phase.label);
      const progress = file.task.progress;
      if (progress) ctx.setProgress((x) => ({ ...x, [file.id]: progress }));
    } else if (phase.kind === 'finished') {
      ctx.setJob(file.id, null);
      if (file.task.error) ctx.setError(file.id, file.task.error);
      if (file.hasDraft && !ctx.cache.current[file.id]?.draft) void load(ctx, file.id);
    }
  }
  return s;
}

export async function selectFirst(ctx: WorkspaceCtx, s: ImportList) {
  ctx.select(s.workspaces[0]?.id || '');
  if (s.workspaces[0]) await load(ctx, s.workspaces[0].id);
}

/** 识别时每秒走一下“已等几秒”；返回停表的函数 */
function startClock(ctx: WorkspaceCtx, id: string) {
  ctx.setProgress((x) => ({ ...x, [id]: { stage: 'connecting', receivedChars: 0, elapsedMs: 0 } }));
  const started = Date.now();
  const clock = setInterval(
    () => ctx.setProgress((x) => ({ ...x, [id]: { ...x[id], elapsedMs: Date.now() - started } })),
    1000,
  );
  return () => clearInterval(clock);
}

/**
 * 对一份文件办一件事（send 发请求），办完重读列表；没办成把原因记在这份文件上，返回 null。
 * clock：当场识别，办的时候走“已等几秒”。
 */
export async function act(ctx: WorkspaceCtx, id: string, send: WorkspaceSend, label = '处理中', clock = false) {
  const w = ctx.cache.current[id] || (await readWorkspace(id));
  ctx.setJob(id, label);
  ctx.setError(id, '');
  const stop = clock ? startClock(ctx, id) : null;
  try {
    const result = await send(tokenOf(ctx), w.revision, (p) => ctx.setProgress((x) => ({ ...x, [id]: p })));
    if (!ctx.cancelled.has(id)) ctx.accept(result);
    await refresh(ctx);
    return result;
  } catch (e) {
    if (!ctx.cancelled.has(id)) ctx.setError(id, isTimeout(e) ? TIMEOUT_TEXT : errorMessage(e));
    await refresh(ctx).catch(() => {
      // 没办成的原因已经记在这份文件上了；列表这次没重读到，下一次定时、切回页面时再读
    });
    return null;
  } finally {
    stop?.();
    ctx.setJob(id, null);
  }
}

/** 对一份文件办的事：保存修改、保存客户与产品选择、撤回、重新识别、改识别类型、关联到货单（办完重读列表，见 act） */
export function workspaceCommands(ctx: WorkspaceCtx) {
  const send = (id: string, label: string, request: WorkspaceSend, clock = false) => act(ctx, id, request, label, clock);
  return {
    /** 保存本地修改（和上次保存的比改了的格子） */
    saveEdits: (id: string, operations: DraftOperation[]) =>
      send(id, '保存修改', (token, expectedRevision) => workspaceAction(token, id, 'edit', { expectedRevision, operations })),
    saveMapping: (id: string, mapping: ImportMapping) =>
      send(id, '保存客户与产品选择', (token, expectedRevision) =>
        workspaceAction(token, id, 'mapping', { expectedRevision, mapping }),
      ),
    /** 撤回上一次保存的修改 */
    undo: (id: string) =>
      send(id, '撤回修改', (token, expectedRevision) => workspaceAction(token, id, 'undo', { expectedRevision })),
    /** 重新识别订单：覆盖已有结果，当场识别、边收边显示进度 */
    reanalyze: (id: string) =>
      send(
        id,
        '重新识别中',
        (token, expectedRevision, onProgress) => analyzeWorkspace(token, id, { expectedRevision, force: true }, onProgress),
        true,
      ),
    setMode: (id: string, mode: FileMode) =>
      send(id, '切换识别类型', (token, expectedRevision) => workspaceAction(token, id, 'mode', { expectedRevision, mode })),
    /** 关联到登记好的到货单（docId 为 null 是解除），可以顺带记下到货原件 */
    linkArrival: (id: string, docId: number | null, sourceId?: string | null) =>
      send(id, '关联到货单', (token, expectedRevision) =>
        workspaceAction(token, id, 'arrival/link', {
          expectedRevision,
          docId,
          ...(sourceId !== undefined ? { sourceId } : {}),
        }),
      ),
  };
}

/** 订单识别：没识别过的排进识别队列（不再先问外发）。 */
export async function recognize(ctx: WorkspaceCtx, ids: string[]) {
  if (!ctx.status.current?.ai.ready) return;
  for (const id of ids) {
    if (ctx.cancelled.has(id)) continue;
    const w = await readWorkspace(id).catch(() => null);
    if (!w || w.draft || ['queued', 'running', 'backoff'].includes(w.task?.state || '')) continue;
    ctx.accept(w);
    await act(
      ctx,
      id,
      (token, expectedRevision) => workspaceAction(token, id, 'enqueue', { expectedRevision }),
      importStateLabels.queued,
    );
  }
}

export async function recognizeArrival(ctx: WorkspaceCtx, id: string, force = false) {
  if (ctx.arrivalJobs.has(id)) return null;
  ctx.arrivalJobs.add(id);
  ctx.setError(id, '');
  ctx.setJob(id, '识别到货单中');
  try {
    const result = await recognizeArrivalFile(tokenOf(ctx), id, force, (p) => {
      ctx.setProgress((x) => ({ ...x, [id]: p }));
      ctx.setJob(id, '到货识别中 · ' + (p.receivedChars || 0) + ' 字符');
    });
    await load(ctx, id);
    await refresh(ctx);
    return result;
  } catch (e) {
    ctx.setError(id, errorMessage(e));
    await load(ctx, id);
    return null;
  } finally {
    ctx.arrivalJobs.delete(id);
    ctx.setJob(id, null);
  }
}

export async function cancel(ctx: WorkspaceCtx, id: string) {
  ctx.cancelled.add(id);
  const w = await readWorkspace(id);
  try {
    ctx.accept(await workspaceAction(tokenOf(ctx), id, 'cancel', { expectedRevision: w.revision }));
  } finally {
    ctx.setJob(id, null);
    ctx.cancelled.delete(id);
    await refresh(ctx);
  }
}
