import { useState, useEffect, useRef } from 'react';
import { SseParser } from '../../shared/sse';
import { AI_HTTP_TIMEOUT_MS, type AiProgress } from '../../shared/ai-runtime';
import {
  headerFields,
  lineFields,
  type ImportWorkspaceView as Workspace,
  type OrderDraft,
  type DraftOperation,
} from '../../shared/order-draft';
export type FileItem = {
  id: string;
  fileName: string;
  createdAt: string;
  task?: Workspace['task'];
  reviewed?: boolean;
  hasDraft?: boolean;
  mode?: 'order' | 'arrival';
  arrivalDocId?: number | null;
  arrivalSourceId?: string | null;
  arrivalStatus?: string;
  arrivalNumber?: string | null;
  imported?: Workspace['imported'];
  historyImport?: Workspace['imported'];
};
type Status = {
  scope?: string;
  inputMode?: 'raw-file' | 'deepseek-compatible';
  csrfToken: string;
  active: {
    id: string;
    name: string;
    endpoint: string;
    model: string;
    hasApiKey: boolean;
    apiStyle?: 'chat-completions' | 'responses';
  } | null;
  workspaces: FileItem[];
  trash: { id: string; fileName: string; removedAt: string }[];
  writesEnabled: boolean;
  queue?: { active: number; waiting: number; limit: number; configured: number };
};
type UploadItem = {
  id: string;
  file: File;
  state: 'queued' | 'uploading' | 'failed';
  error?: string;
};
export function useOrderWorkspace() {
  const [status, setStatus] = useState<Status | null>(null),
    [selected, setSelected] = useState(''),
    [cache, setCache] = useState<Record<string, Workspace>>({}),
    [drafts, setDrafts] = useState<Record<string, OrderDraft>>({}),
    [jobs, setJobs] = useState<Record<string, string>>({}),
    [errors, setErrors] = useState<Record<string, string>>({}),
    [uploads, setUploads] = useState<UploadItem[]>([]),
    [notice, setNotice] = useState(''),
    [fatal, setFatal] = useState('');
  const selectedRef = useRef(''),
    arrivalJobs = useRef(new Set<string>()),
    cacheRef = useRef(cache),
    statusRef = useRef(status),
    uploadQueue = useRef<UploadItem[]>([]),
    uploading = useRef(false),
    cancelled = useRef(new Set<string>());
  const [streamEnabled, setStreamEnabled] = useState(true),
    streamRef = useRef(true);
  streamRef.current = streamEnabled;
  const [progress, setProgress] = useState<Record<string, AiProgress>>({});
  cacheRef.current = cache;
  statusRef.current = status;
  const select = (id: string) => {
    selectedRef.current = id;
    setSelected(id);
  };
  async function request<T>(
    path: string,
    body?: unknown,
    onProgress?: (p: AiProgress) => void,
    signal?: AbortSignal,
    timeoutMs = AI_HTTP_TIMEOUT_MS,
  ): Promise<T> {
    const r = await fetch(
      '/api/ai/imports' + path,
      body === undefined
        ? {
            cache: 'no-store',
            signal: signal
              ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
              : AbortSignal.timeout(timeoutMs),
          }
        : {
            method: 'POST',
            signal: signal
              ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
              : AbortSignal.timeout(timeoutMs),
            headers: {
              'Content-Type': 'application/json',
              'X-ERP-AI-Token': statusRef.current?.csrfToken || '',
            },
            body: JSON.stringify(body),
          },
    );
    if (r.ok && r.headers.get('content-type')?.includes('text/event-stream')) {
      if (!r.body) throw new Error('本机响应缺少流式内容');
      const reader = r.body.getReader(),
        decoder = new TextDecoder('utf-8', { fatal: true });
      let result: T | undefined,
        hasResult = false;
      const parser = new SseParser(({ event, data }) => {
        const value = JSON.parse(data);
        if (event === 'progress') onProgress?.(value);
        else if (event === 'error')
          throw Object.assign(new Error(value.message || '流式识别失败'), { code: value.code });
        else if (event === 'result') {
          result = value;
          hasResult = true;
        }
      });
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          parser.push(decoder.decode(part.value, { stream: true }));
        }
        parser.push(decoder.decode());
        parser.finish();
        if (!hasResult) throw new Error('流式响应中断，未收到完整草稿；请重新加载确认状态');
        return result!;
      } catch (error) {
        await reader.cancel().catch(() => {});
        throw error;
      } finally {
        reader.releaseLock();
      }
    }
    const d = await r.json();
    if (!r.ok) throw new Error(d.message || '操作失败');
    return d;
  }
  async function refresh() {
    const s = await request<Status>('');
    statusRef.current = s;
    setStatus(s);
    for (const file of s.workspaces) {
      if (arrivalJobs.current.has(file.id)) continue;
      if (file.mode === 'arrival') {
        if (file.arrivalStatus === 'running') setJobs((x) => ({ ...x, [file.id]: 'AI到货识别中' }));
        else
          setJobs((x) => {
            const next = { ...x };
            delete next[file.id];
            return next;
          });
        continue;
      }
      if (['queued', 'backoff', 'running'].includes(file.task?.state || '')) {
        setErrors((x) => ({ ...x, [file.id]: '' }));
        setJobs((x) => ({
          ...x,
          [file.id]:
            file.task?.state === 'running'
              ? 'AI识别中'
              : file.task?.state === 'backoff'
                ? '限流退避中'
                : '等待中',
        }));
        if (file.task?.progress) setProgress((x) => ({ ...x, [file.id]: file.task!.progress! }));
      } else if (['ready', 'failed', 'cancelled'].includes(file.task?.state || '')) {
        setJobs((x) => {
          if (!x[file.id]) return x;
          const next = { ...x };
          delete next[file.id];
          return next;
        });
        if (file.task?.error) setErrors((x) => ({ ...x, [file.id]: file.task!.error! }));
        if (file.hasDraft && !cacheRef.current[file.id]?.draft) void load(file.id);
      }
    }
    return s;
  }
  function accept(w: Workspace) {
    if ((cacheRef.current[w.id]?.revision ?? -1) > w.revision) return;
    cacheRef.current = { ...cacheRef.current, [w.id]: w };
    setCache(cacheRef.current);
    if (w.draft) setDrafts((d) => ({ ...d, [w.id]: structuredClone(w.draft!) }));
  }
  async function load(id: string) {
    try {
      const w = await request<Workspace>('/' + id);
      accept(w);
    } catch (e) {
      setErrors((x) => ({ ...x, [id]: (e as Error).message }));
    }
  }
  useEffect(() => {
    let live = true;
    refresh()
      .then((s) => {
        const requested = new URLSearchParams(location.hash.split('?')[1] || '').get('workspace');
        const first = s.workspaces.find((f) => f.id === requested) || s.workspaces[0];
        if (live && first) {
          select(first.id);
          void load(first.id);
        }
      })
      .catch((e) => live && setFatal(e.message));
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    const update = (event?: Event) => {
      const target =
        event instanceof CustomEvent
          ? event.detail?.workspaceId
          : new URLSearchParams(location.hash.split('?')[1] || '').get('workspace');
      if (target && /^[0-9a-f-]{36}$/.test(target)) {
        select(target);
        void load(target);
        void refresh().catch(() => {});
      }
    };
    window.addEventListener('hashchange', update);
    window.addEventListener('erp-ai-workspace-changed', update);
    return () => {
      window.removeEventListener('hashchange', update);
      window.removeEventListener('erp-ai-workspace-changed', update);
    };
  }, []);
  useEffect(() => {
    const timer = setInterval(() => {
      if (
        statusRef.current?.workspaces.some((f) =>
          ['queued', 'backoff', 'running'].includes(f.task?.state || ''),
        )
      )
        void refresh().catch(() => {});
    }, 1500);
    return () => clearInterval(timer);
  }, []);
  async function choose(id: string) {
    select(id);
    if (location.hash.split('?')[0] === '#ai-import') {
      const params = new URLSearchParams(location.hash.split('?')[1] || '');
      params.set('workspace', id);
      history.replaceState(null, '', '#ai-import?' + params.toString());
    }
    if (!cacheRef.current[id]) await load(id);
  }
  async function action(
    id: string,
    path: string,
    extra: Record<string, unknown> = {},
    label = '处理中',
  ) {
    const w = cacheRef.current[id] || (await request<Workspace>('/' + id));
    setJobs((x) => ({ ...x, [id]: label }));
    setErrors((x) => ({ ...x, [id]: '' }));
    const ai = path === 'analyze' || path === 'chat';
    if (ai)
      setProgress((x) => ({ ...x, [id]: { stage: 'connecting', receivedChars: 0, elapsedMs: 0 } }));
    const progressStarted = Date.now(),
      clock = ai
        ? setInterval(
            () =>
              setProgress((x) => ({
                ...x,
                [id]: { ...x[id], elapsedMs: Date.now() - progressStarted },
              })),
            1000,
          )
        : null;
    try {
      const result = await request<Workspace>(
        '/' + id + '/' + path,
        {
          expectedRevision: w.revision,
          ...extra,
          ...(ai
            ? { stream: streamRef.current && statusRef.current?.active?.apiStyle === 'responses' }
            : {}),
        },
        (p) => setProgress((x) => ({ ...x, [id]: p })),
      );
      if (!cancelled.current.has(id)) accept(result);
      await refresh();
      return result;
    } catch (e) {
      if (!cancelled.current.has(id))
        setErrors((x) => ({
          ...x,
          [id]:
            (e as Error).name === 'TimeoutError'
              ? '本机前端等待超过630秒；请检查上游超时或重新加载草稿。'
              : (e as Error).message,
        }));
      await refresh().catch(() => {});
      return null;
    } finally {
      if (clock) clearInterval(clock);
      setJobs((x) => {
        const y = { ...x };
        delete y[id];
        return y;
      });
    }
  }
  async function processQueue() {
    if (uploading.current) return;
    uploading.current = true;
    try {
      while (uploadQueue.current.length) {
        const item = uploadQueue.current.shift()!;
        if (cancelled.current.has(item.id)) continue;
        setUploads((x) => x.map((y) => (y.id === item.id ? { ...y, state: 'uploading' } : y)));
        try {
          if (item.file.size > 10 * 1024 * 1024) throw new Error('文件不能超过10MB');
          const r = await fetch('/api/ai/imports/upload', {
            method: 'POST',
            signal: AbortSignal.timeout(AI_HTTP_TIMEOUT_MS),
            headers: {
              'Content-Type': 'application/octet-stream',
              'X-ERP-AI-Token': statusRef.current?.csrfToken || '',
              'X-File-Name': encodeURIComponent(item.file.name),
            },
            body: item.file,
          });
          const d = await r.json();
          if (!r.ok) throw new Error(d.message || '上传失败');
          accept(d.workspace);
          if (!selectedRef.current) select(d.workspace.id);
          setUploads((x) => x.filter((y) => y.id !== item.id));
          setNotice(
            d.duplicate
              ? '相同文件尚未处理，已恢复原任务'
              : d.workspace.historyImport
                ? '该文件此前处理过，已创建新的导入任务；历史记录和原订单凭据保留'
                : '已保留原件，尚未外发给AI',
          );
          await refresh();
        } catch (e) {
          setUploads((x) =>
            x.map((y) =>
              y.id === item.id ? { ...y, state: 'failed', error: (e as Error).message } : y,
            ),
          );
        }
      }
    } finally {
      uploading.current = false;
    }
  }
  function upload(files: File[]) {
    if (!statusRef.current) return;
    const items = files
      .slice(0, 20)
      .map((file) => ({ id: crypto.randomUUID(), file, state: 'queued' as const }));
    if (files.length > 20) setNotice('每批最多20个文件，其余文件请分批上传');
    setUploads((x) => [...x, ...items]);
    uploadQueue.current.push(...items);
    void processQueue();
  }
  function retryUpload(id: string) {
    const item = uploads.find((x) => x.id === id);
    if (item) {
      uploadQueue.current.push({ ...item, state: 'queued' });
      setUploads((x) => x.map((y) => (y.id === id ? { ...y, state: 'queued', error: '' } : y)));
      void processQueue();
    }
  }
  function discardUpload(id: string) {
    cancelled.current.add(id);
    setUploads((x) => x.filter((y) => y.id !== id));
  }
  async function remove(id: string) {
    const w = cacheRef.current[id] || (await request<Workspace>('/' + id));
    cancelled.current.add(id);
    try {
      await request('/' + id + '/remove', { expectedRevision: w.revision, acknowledged: true });
      setCache((c) => {
        const n = { ...c };
        delete n[id];
        cacheRef.current = n;
        return n;
      });
      setDrafts((d) => {
        const n = { ...d };
        delete n[id];
        return n;
      });
      const s = await refresh();
      if (selectedRef.current === id) {
        select(s.workspaces[0]?.id || '');
        if (s.workspaces[0]) await load(s.workspaces[0].id);
      }
      setNotice('已移出工作区，可在回收站恢复；正式业务数据未改动');
    } catch (e) {
      cancelled.current.delete(id);
      setErrors((x) => ({ ...x, [id]: (e as Error).message }));
    }
  }
  async function removeMany(ids: string[]) {
    ids.forEach((id) => cancelled.current.add(id));
    try {
      const prepared = await Promise.all(
        ids.map(async (id) => {
          try {
            return { id, revision: (await request<Workspace>('/' + id)).revision, error: '' };
          } catch (error) {
            return { id, revision: null, error: (error as Error).message };
          }
        }),
      );
      const items = prepared
        .filter((p) => p.revision !== null)
        .map((p) => ({ id: p.id, expectedRevision: p.revision! }));
      const result = items.length
        ? await request<{ results: { id: string; removed: boolean; message: string }[] }>(
            '/remove-many',
            { items, acknowledged: true },
          )
        : { results: [] as { id: string; removed: boolean; message: string }[] };
      result.results.push(
        ...prepared
          .filter((p) => p.revision === null)
          .map((p) => ({ id: p.id, removed: false, message: p.error })),
      );
      const removed = new Set(result.results.filter((r) => r.removed).map((r) => r.id));
      setCache((c) => {
        const n = { ...c };
        for (const id of removed) delete n[id];
        cacheRef.current = n;
        return n;
      });
      setDrafts((d) => {
        const n = { ...d };
        for (const id of removed) delete n[id];
        return n;
      });
      for (const r of result.results) if (!r.removed) cancelled.current.delete(r.id);
      const state = await refresh();
      if (
        removed.has(selectedRef.current) ||
        !state.workspaces.some((w) => w.id === selectedRef.current)
      ) {
        select(state.workspaces[0]?.id || '');
        if (state.workspaces[0]) await load(state.workspaces[0].id);
      }
      const failed = result.results.filter((r) => !r.removed);
      await Promise.all(
        failed.filter((r) => state.workspaces.some((w) => w.id === r.id)).map((r) => load(r.id)),
      );
      setNotice(
        '已删除' +
          removed.size +
          '份工作区文件' +
          (failed.length
            ? '；失败' +
              failed.length +
              '份：' +
              failed
                .map((r) => (cacheRef.current[r.id]?.fileName || r.id) + '：' + r.message)
                .join('；')
            : '，可在回收站恢复。'),
      );
      return [...removed];
    } catch (error) {
      ids.forEach((id) => cancelled.current.delete(id));
      setFatal((error as Error).message);
      await refresh().catch(() => {});
      return [];
    }
  }
  async function restore(id: string) {
    try {
      cancelled.current.delete(id);
      const w = await request<Workspace>('/' + id + '/restore', {});
      accept(w);
      select(id);
      await refresh();
      setNotice('文件与专属草稿已恢复');
    } catch (e) {
      setFatal((e as Error).message);
    }
  }
  async function cancel(id: string) {
    cancelled.current.add(id);
    const w = await request<Workspace>('/' + id);
    try {
      accept(await request<Workspace>('/' + id + '/cancel', { expectedRevision: w.revision }));
    } finally {
      setJobs((x) => {
        const y = { ...x };
        delete y[id];
        return y;
      });
      cancelled.current.delete(id);
      await refresh();
    }
  }
  async function recognize(ids: string[]) {
    const p = statusRef.current?.active;
    if (!p) return;
    for (const id of ids) {
      if (cancelled.current.has(id)) continue;
      const w = await request<Workspace>('/' + id).catch(() => null);
      if (!w) continue;
      if (w.draft || ['queued', 'running', 'backoff'].includes(w.task?.state || '')) continue;
      accept(w);
      const consent = await action(
        id,
        'consent',
        {
          accepted: true,
          presetId: p.id,
          endpoint: p.endpoint,
          model: p.model,
          apiStyle: p.apiStyle || 'chat-completions',
        },
        '确认外发',
      );
      if (consent && !w.draft && !cancelled.current.has(id))
        await action(id, 'enqueue', { stream: streamRef.current }, '等待中');
    }
  }
  async function authorize(id: string) {
    const p = statusRef.current?.active;
    if (!p) {
      setFatal('请先在AI设置中启用一个预设');
      return null;
    }
    return action(
      id,
      'consent',
      {
        accepted: true,
        presetId: p.id,
        endpoint: p.endpoint,
        model: p.model,
        apiStyle: p.apiStyle || 'chat-completions',
      },
      '确认外发',
    );
  }
  async function reanalyze(id: string) {
    return action(id, 'analyze', { force: true }, '重新识别中');
  }
  async function setMode(id: string, mode: 'order' | 'arrival') {
    return action(id, 'mode', { mode }, '切换识别类型');
  }
  async function linkArrival(id: string, docId: number | null, sourceId?: string | null) {
    return action(
      id,
      'arrival/link',
      { docId, ...(sourceId !== undefined ? { sourceId } : {}) },
      '关联到货草稿',
    );
  }
  async function recognizeArrival(id: string, force = false) {
    if (arrivalJobs.current.has(id)) return null;
    arrivalJobs.current.add(id);
    setErrors((x) => ({ ...x, [id]: '' }));
    setJobs((x) => ({ ...x, [id]: '识别到货单中' }));
    try {
      const result = await request<any>(
        '/' + id + '/arrival/recognize',
        {
          consent: true,
          stream: streamRef.current,
          force,
          policyVersion: 4,
          profile: statusRef.current?.active
            ? {
                id: statusRef.current.active.id,
                endpoint: statusRef.current.active.endpoint,
                model: statusRef.current.active.model,
                apiStyle: statusRef.current.active.apiStyle || 'chat-completions',
              }
            : undefined,
        },
        (p) => {
          setProgress((x) => ({ ...x, [id]: p }));
          setJobs((x) => ({ ...x, [id]: '到货识别中 · ' + (p.receivedChars || 0) + ' 字符' }));
        },
      );
      await load(id);
      await refresh();
      return result;
    } catch (e) {
      setErrors((x) => ({ ...x, [id]: (e as Error).message }));
      await load(id);
      return null;
    } finally {
      arrivalJobs.current.delete(id);
      setJobs((x) => {
        const next = { ...x };
        delete next[id];
        return next;
      });
    }
  }
  function operations(id: string): DraftOperation[] {
    const before = cache[id]?.draft,
      after = drafts[id];
    if (!before || !after) return [];
    const result: DraftOperation[] = [];
    for (const k of headerFields)
      if (before.header[k].value !== after.header[k].value)
        result.push({
          op: 'set-header',
          field: k,
          value: after.header[k].value,
          reason: '人工编辑',
        });
    for (const line of after.lines) {
      const old = before.lines.find((l) => l.id === line.id);
      if (old)
        for (const k of lineFields)
          if (old.fields[k].value !== line.fields[k].value)
            result.push({
              op: 'set-line',
              lineId: line.id,
              field: k,
              value: line.fields[k].value,
              reason: '人工编辑',
            });
    }
    return result;
  }
  function change(id: string, key: string, value: string, lineId?: string) {
    setDrafts((prev) => {
      const d = structuredClone(prev[id]);
      if (!d) return prev;
      const f = lineId
        ? (d.lines.find((l) => l.id === lineId)!.fields as any)[key]
        : (d.header as any)[key];
      f.value = value || null;
      f.certainty = 'user-modified';
      return { ...prev, [id]: d };
    });
  }
  return {
    status,
    streamEnabled,
    setStreamEnabled,
    progress,
    selected,
    workspace: cache[selected],
    draft: drafts[selected],
    jobs,
    errors,
    uploads,
    notice,
    fatal,
    setNotice,
    dismissError: (id: string) => setErrors((x) => ({ ...x, [id]: '' })),
    setFatal,
    choose,
    load,
    upload,
    retryUpload,
    discardUpload,
    action,
    remove,
    removeMany,
    restore,
    cancel,
    recognize,
    authorize,
    reanalyze,
    setMode,
    linkArrival,
    recognizeArrival,
    operations,
    change,
    refresh,
    request,
  };
}
