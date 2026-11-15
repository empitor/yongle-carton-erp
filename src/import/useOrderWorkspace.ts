import { useState, useEffect, useRef } from 'react';
import { emit, listen, hashParams } from '../ui/index';
import type { AiProgress } from '../../shared/ai/index';
import { errorMessage } from '../../shared/core/index';
import type { ImportList, ImportWorkspaceView as Workspace, OrderDraft } from '../../shared/import/index';
import { draftOperations, withFieldValue } from './draft-edits';
import { taskRunning, type FileMode } from './fileStatus';
import { useUploadQueue } from './useUploadQueue';
import {
  cancel,
  load,
  recognize,
  recognizeArrival,
  refresh,
  tokenOf,
  workspaceCommands,
  type WorkspaceCtx,
} from './workspace-actions';
import { removeMany, restore } from './workspace-removal';

const without = <T,>(map: Record<string, T>, ...ids: string[]) => {
  if (!ids.some((id) => id in map)) return map;
  const next = { ...map };
  for (const id of ids) delete next[id];
  return next;
};
const hashWorkspace = () => hashParams().get('workspace');
/** 地址里记下当前文件（助手按地址知道用户正在看哪份识别文件） */
function markInHash(id: string) {
  if (location.hash.split('?')[0] !== '#ai-import') return;
  const params = hashParams();
  params.set('workspace', id);
  history.replaceState(null, '', '#ai-import?' + params.toString());
}

/** 页面上的状态，和交给 workspace-actions 办事用的 ctx（只建一次，里面的引用和设值函数不变） */
function useWorkspaceState() {
  const [status, setStatus] = useState<ImportList | null>(null),
    [selected, setSelected] = useState(''),
    [cache, setCache] = useState<Record<string, Workspace>>({}),
    [drafts, setDrafts] = useState<Record<string, OrderDraft>>({}),
    [jobs, setJobs] = useState<Record<string, string>>({}),
    [errors, setErrors] = useState<Record<string, string>>({}),
    [progress, setProgress] = useState<Record<string, AiProgress>>({}),
    [notice, setNotice] = useState(''),
    [fatal, setFatal] = useState('');
  const [ctx] = useState<WorkspaceCtx>(() => {
    const cacheRef: WorkspaceCtx['cache'] = { current: {} },
      selectedRef = { current: '' };
    return {
      status: { current: null },
      cache: cacheRef,
      selected: selectedRef,
      cancelled: new Set(),
      arrivalJobs: new Set(),
      setStatus,
      select(id) {
        selectedRef.current = id;
        setSelected(id);
      },
      setJob: (id, label) => setJobs((x) => (label === null ? without(x, id) : { ...x, [id]: label })),
      setError: (id, message) => setErrors((x) => ({ ...x, [id]: message })),
      setProgress,
      accept(w) {
        if ((cacheRef.current[w.id]?.revision ?? -1) > w.revision) return;
        cacheRef.current = { ...cacheRef.current, [w.id]: w };
        setCache(cacheRef.current);
        const draft = w.draft;
        if (draft) setDrafts((d) => ({ ...d, [w.id]: structuredClone(draft) }));
      },
      forget(ids) {
        cacheRef.current = without(cacheRef.current, ...ids);
        setCache(cacheRef.current);
        setDrafts((d) => without(d, ...ids));
      },
      setNotice,
      setFatal,
    };
  });
  ctx.cache.current = cache;
  ctx.status.current = status;
  return { ctx, setDrafts, view: { status, selected, cache, drafts, jobs, errors, progress, notice, fatal } };
}

/** 进页面读列表并打开地址里的那份；跟着地址、助手和业务变化切换或重读；有识别在跑时定时重读 */
function useWorkspaceSync(ctx: WorkspaceCtx) {
  useEffect(() => {
    let live = true;
    refresh(ctx)
      .then((s) => {
        const first = s.workspaces.find((f) => f.id === hashWorkspace()) || s.workspaces[0];
        if (live && first) {
          ctx.select(first.id);
          void load(ctx, first.id);
        }
      })
      .catch((e: unknown) => {
        if (live) ctx.setFatal(errorMessage(e));
      });
    return () => {
      live = false;
    };
  }, [ctx]);
  useEffect(() => {
    const reread = () =>
      void refresh(ctx).catch(() => {
        // 后台重读：没读到就留着眼前这份，下一次定时、切回页面时再读
      });
    // 地址里的 workspace，或助手处理了哪个工作区，就切到那个工作区
    const update = (target = hashWorkspace()) => {
      if (target && /^[0-9a-f-]{36}$/.test(target)) {
        ctx.select(target);
        void load(ctx, target);
        reread();
      }
    };
    const fromHash = () => update();
    window.addEventListener('hashchange', fromHash);
    const stops = [
      listen('erp-ai-workspace-changed', (d) => update(d.workspaceId)),
      listen('erp-ai-workspace-list-changed', reread),
      // 业务数据变了（别处改了、切回这个页面时）：重读文件列表；已经打开的识别结果不覆盖
      listen('erp-business-changed', reread),
    ];
    const timer = setInterval(() => {
      if (ctx.status.current?.workspaces.some(taskRunning)) reread();
    }, 1500);
    return () => {
      window.removeEventListener('hashchange', fromHash);
      stops.forEach((stop) => stop());
      clearInterval(timer);
    };
  }, [ctx]);
}

/**
 * AI 导入页的数据：文件列表、选中的文件、每份文件的识别结果和本地修改、进行中的任务和提示。
 * 办的事在 workspace-actions.ts、workspace-removal.ts，请求在 workspace-api.ts，上传队列在 useUploadQueue.ts，
 * 本地修改的比对在 draft-edits.ts。uploadMode：新传的文件按哪种类型识别（从到货页跳过来时是到货单）。
 */
export function useOrderWorkspace(uploadMode: FileMode = 'order') {
  const { ctx, setDrafts, view } = useWorkspaceState();
  const modeRef = useRef(uploadMode);
  modeRef.current = uploadMode;
  useWorkspaceSync(ctx);
  const uploadQueue = useUploadQueue({
    token: () => ctx.status.current?.csrfToken ?? null,
    setNotice: ctx.setNotice,
    // 从到货页跳过来的：新传的文件直接按到货单识别（上传时带上类型）
    mode: () => modeRef.current,
    async onUploaded({ workspace }) {
      ctx.accept(workspace);
      if (!ctx.selected.current) ctx.select(workspace.id);
      await refresh(ctx);
    },
  });
  const { cache, drafts, ...shown } = view,
    selected = shown.selected;
  return {
    ...shown,
    workspace: cache[selected],
    draft: drafts[selected],
    setNotice: ctx.setNotice,
    setFatal: ctx.setFatal,
    dismissError: (id: string) => ctx.setError(id, ''),
    async choose(id: string) {
      ctx.select(id);
      markInHash(id);
      if (!ctx.cache.current[id]) await load(ctx, id);
    },
    /** “让 AI 改”：打开全局助手，它从地址里的 workspace 知道是哪份文件 */
    askAssistant(id: string) {
      markInHash(id);
      emit('erp-open-assistant');
    },
    load: (id: string) => load(ctx, id),
    refresh: () => refresh(ctx),
    /** 工作区凭证：导入订单的预览和执行要带 */
    token: () => tokenOf(ctx),
    ...uploadQueue,
    ...workspaceCommands(ctx),
    removeMany: (ids: string[], permanent = false) => removeMany(ctx, ids, permanent),
    restore: (id: string) => restore(ctx, id),
    cancel: (id: string) => cancel(ctx, id),
    recognize: (ids: string[]) => recognize(ctx, ids),
    recognizeArrival: (id: string, force = false) => recognizeArrival(ctx, id, force),
    operations: (id: string) => draftOperations(cache[id]?.draft, drafts[id]),
    /** 放弃还没保存的修改，回到最近一次保存的识别结果。 */
    discard: (id: string) => {
      const saved = ctx.cache.current[id]?.draft;
      if (saved) setDrafts((prev) => ({ ...prev, [id]: structuredClone(saved) }));
    },
    change: (id: string, key: string, value: string, lineId?: string) =>
      setDrafts((prev) => (prev[id] ? { ...prev, [id]: withFieldValue(prev[id], key, value, lineId) } : prev)),
  };
}
