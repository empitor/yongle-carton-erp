import { useEffect, useRef, useState } from 'react';
import {
  Bot,
  ChevronDown,
  Eraser,
  Expand,
  LoaderCircle,
  Mic,
  Minimize2,
  Plus,
  Send,
  Square,
  Trash2,
  X,
  GripHorizontal,
} from 'lucide-react';
import { managementRequest, useAuthState } from './session';
import { SseParser } from '../shared/sse';
import { AI_HTTP_TIMEOUT_MS } from '../shared/ai-runtime';
import './global-assistant.css';
import { AttachmentCards, AttachmentPreview, attachmentSlots } from './AssistantAttachments';
import { useAssistantUploads } from './useAssistantUploads';
import { useAssistantSpeech } from './speech/useAssistantSpeech';
import { warehouseDeliveryHash } from '../shared/warehouse-delivery';
import { useFloatingAssistant } from './useFloatingAssistant';
import CartonSpirit from './CartonSpirit';
import { isErpNavigation } from '../shared/assistant-navigation';
import AssistantOrderTask from './AssistantOrderTask';
import AssistantBusinessTaskPanel from './AssistantBusinessTask';
import {
  attachmentAccept,
  officialDeepSeekEndpoint,
  type AssistantAttachment,
} from '../shared/assistant-attachments';
const modules: Record<string, string> = {
  orders: 'orders',
  customers: 'customers',
  products: 'products',
  suppliers: 'suppliers',
  purchases: 'purchases',
  warehouse: 'raw_inventory',
  arrivals: 'arrivals',
  production: 'production_tasks',
  deliveries: 'deliveries',
};
const text = (v: any) =>
  v == null ? '未填写' : typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v);
function Changes({ before, after }: { before: any; after: any }) {
  const keys = [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])].filter(
    (k) =>
      !['version', 'updatedAt', 'createdAt'].includes(k) &&
      JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k]),
  );
  const names: Record<string, string> = {
    name: '名称',
    notes: '备注',
    requirements: '加工要求/备注',
    phone: '电话',
    contact: '联系人',
    address: '地址',
    specification: '规格型号',
    lines: '产品/纸板明细',
    quantity: '数量',
    status: '状态',
    date: '日期',
    deliveryDate: '交货日期',
    orderDate: '下单日期',
    supplierId: '供应商编号',
    customerId: '客户编号',
    productId: '产品编号',
    unit: '计量单位',
    material: '材质/配纸',
    flute: '楞型',
    length: '长',
    width: '宽',
    height: '高',
    dimensionUnit: '尺寸单位',
    changes: '库存变化',
    materials: '领料/退料',
    goodQuantity: '合格数量',
    scrapQuantity: '报废数量',
  };
  return (
    <div className="ga-changes">
      {keys.map((k) => (
        <div key={k}>
          <strong>{names[k] || k}</strong>
          <del>{text(before?.[k])}</del>
          <ins>{text(after?.[k])}</ins>
        </div>
      ))}
    </div>
  );
}
export default function GlobalAssistant() {
  const auth = useAuthState(),
    userId = auth?.actor?.id,
    [open, setOpen] = useState(false),
    [large, setLarge] = useState(false),
    [state, setState] = useState<any>(null),
    [thread, setThread] = useState<any>(null),
    [message, setMessage] = useState(''),
    [newBusinessTask, setNewBusinessTask] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [progress, setProgress] = useState(''),
    [draft, setDraft] = useState(''),
    [partial, setPartial] = useState(''),
    [context, setContext] = useState<any>(null),
    [review, setReview] = useState<any>(null),
    [password, setPassword] = useState(''),
    [confirmation, setConfirmation] = useState(''),
    [executing, setExecuting] = useState(false),
    [executed, setExecuted] = useState<string[]>([]);
  const [previewFiles, setPreviewFiles] = useState<{
      files: AssistantAttachment[];
      id: string;
    } | null>(null),
    [includePrevious, setIncludePrevious] = useState(true),
    [dragging, setDragging] = useState(false);
  const [attachmentTextMode, setAttachmentTextMode] = useState<
    'original' | 'with-text' | 'text-only'
  >('with-text');
  const openAssistant = () => {
    setOpen(true);
    if (userId)
      void loadState()
        .then((s) => {
          if (!threadRef.current && s.threads[0]) void loadThread(s.threads[0].id);
        })
        .catch((e) => setError(e.message));
  };
  const floating = useFloatingAssistant(open, large, openAssistant);
  const history = useRef<HTMLDivElement>(null),
    controller = useRef<AbortController | null>(null),
    draftRef = useRef(''),
    sending = useRef(false),
    atBottom = useRef(true),
    threadRef = useRef<any>(null),
    userRef = useRef(userId);
  const creatingThread = useRef<Promise<any> | null>(null),
    fileInput = useRef<HTMLInputElement>(null);
  const uploads = useAssistantUploads(userId, threadRef, ensureThread, setError);
  const speech = useAssistantSpeech({
    userId,
    contextKey: thread?.id || 'new',
    disabled: busy || !open,
    onText: (text) => {
      setError('');
      setMessage((current) => (current.trim() ? current.replace(/\s*$/, ' ') : '') + text);
    },
    onError: (message) => setError(message),
  });
  userRef.current = userId;
  threadRef.current = thread;
  const loadState = () =>
    managementRequest<any>('/assistant').then((s) => {
      if (userRef.current !== userId) throw new Error('账号已切换，已丢弃旧账号响应。');
      setState(s);
      return s;
    });
  async function ensureThread() {
    if (threadRef.current) return threadRef.current;
    // 优先复用列表里最近的会话，避免用户只是打开助手或语音回填后
    // 因为当前未选中会话而每次发送都新建一个“新会话”。
    const existing = state?.threads?.[0];
    if (existing) {
      const loaded = await loadThread(existing.id);
      if (loaded) return loaded;
    }
    const owner = userId;
    if (!creatingThread.current)
      creatingThread.current = managementRequest('/assistant/threads', {}).finally(() => {
        creatingThread.current = null;
      });
    const created = await creatingThread.current;
    if (userRef.current !== owner) throw Error('账号已切换。');
    threadRef.current = created;
    setThread(created);
    void loadState();
    return created;
  }
  const loadThread = async (id: string) => {
    speech.cancel();
    const t = await managementRequest<any>('/assistant/threads/' + id);
    if (userRef.current !== userId) return null;
    setThread(t);
    uploads.restore(t.pendingAttachments || []);
    setExecuted(t.messages.filter((m: any) => m.executed).map((m: any) => m.executed.previewId));
    return t;
  };
  useEffect(() => {
    controller.current?.abort();
    setThread(null);
    setState(null);
    setError('');
    setDraft('');
    setPartial('');
    draftRef.current = '';
    setContext(null);
    setBusy(false);
    sending.current = false;
    setExecuting(false);
    setReview(null);
    setMessage('');
    setPassword('');
    setConfirmation('');
    setExecuted([]);
    setProgress('');
    setPreviewFiles(null);
    setIncludePrevious(true);
    creatingThread.current = null;
    if (userId)
      void loadState()
        .then((s) => s.threads[0] && loadThread(s.threads[0].id))
        .catch((e) => setError(e.message));
  }, [userId]);
  useEffect(() => {
    const route = () => {
        setContext(null);
      },
      record = (e: Event) => setContext((e as CustomEvent).detail);
    window.addEventListener('hashchange', route);
    window.addEventListener('erp-ai-record-context', record);
    return () => {
      window.removeEventListener('hashchange', route);
      window.removeEventListener('erp-ai-record-context', record);
    };
  }, []);
  useEffect(() => {
    if (atBottom.current) history.current?.scrollTo({ top: history.current.scrollHeight });
  }, [thread, draft, progress, open]);
  const newThread = async () => {
    speech.cancel();
    try {
      const created = await managementRequest('/assistant/threads', {});
      if (userRef.current !== userId) return;
      setThread(created);
      threadRef.current = created;
      uploads.reset();
      setIncludePrevious(true);
      setDraft('');
      setPartial('');
      draftRef.current = '';
      setError('');
      await loadState();
    } catch (e) {
      if (userRef.current !== userId) return;
      setError((e as Error).message);
    }
  };
  const removeThread = async () => {
    if (!thread || busy || executing || uploads.working) return;
    if (
      !window.confirm(
        '删除当前会话？本会话的聊天记录和附件将删除，未执行方案失效；正式业务数据和审计不受影响。',
      )
    )
      return;
    speech.cancel();
    const owner = userId;
    try {
      await managementRequest('/assistant/threads/' + thread.id + '/delete', {
        acknowledged: true,
      });
      if (userRef.current !== owner) return;
      const nextState = await loadState();
      const nextThread = nextState.threads[0];
      if (nextThread) await loadThread(nextThread.id);
      else {
        setThread(null);
        threadRef.current = null;
        setDraft('');
        setPartial('');
        draftRef.current = '';
        uploads.reset();
        setReview(null);
        setExecuted([]);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  };
  async function send(override?: string) {
    if (
      speech.active ||
      (!(override ?? message).trim() && !uploads.ready.length) ||
      busy ||
      uploads.working ||
      uploads.failed ||
      sending.current ||
      !state?.active
    )
      return;
    sending.current = true;
    setBusy(true);
    setError('');
    setDraft('');
    setPartial('');
    draftRef.current = '';
    setProgress('等待AI…');
    const content = override ?? message;
    const startNewTask = newBusinessTask;
    setNewBusinessTask(false);
    setMessage('');
    atBottom.current = true;
    const owner = userId;
    try {
      const current = await ensureThread();
      if (userRef.current !== owner) return;
      setThread({
        ...current,
        messages: [...current.messages, { id: crypto.randomUUID(), role: 'user', text: content }],
      });
      const currentState = await loadState();
      if (JSON.stringify(currentState.active) !== JSON.stringify(state.active)) {
        throw new Error('AI预设已变化，已加载新配置，请重新发送。');
      }
      const authState = await fetch('/api/auth/state').then((r) => r.json()),
        abort = new AbortController();
      if (userRef.current !== owner) return;
      controller.current = abort;
      const r = await fetch('/api/assistant/threads/' + current.id + '/chat', {
        method: 'POST',
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(AI_HTTP_TIMEOUT_MS * 9)]),
        headers: { 'Content-Type': 'application/json', 'X-ERP-Auth-Token': authState.csrf },
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          startNewTask,
          text: content,
          attachmentIds: uploads.ready.map((a) => a.id),
          usePreviousAttachments: includePrevious,
          attachmentTextMode: officialDeepSeekEndpoint(state.active.endpoint)
            ? 'text-only'
            : attachmentTextMode,
          profile: {
            id: state.active.id,
            endpoint: state.active.endpoint,
            model: state.active.model,
            apiStyle: state.active.apiStyle || 'chat-completions',
          },
          context: {
            page: location.hash,
            ...(context ? { module: context.module, id: context.id } : {}),
          },
        }),
      });
      if (!r.ok) {
        const d = await r.json();
        throw new Error(d.message || '请求失败');
      }
      if (!r.body) throw new Error('缺少回复流');
      let result = false,
        failed = '';
      const parser = new SseParser(({ event, data }) => {
        if (userRef.current !== owner) return;
        const d = JSON.parse(data);
        if (event === 'task') setThread((t: any) => (t ? { ...t, businessTask: d } : t));
        if (event === 'effect') {
          if (d.workspaceId)
            window.dispatchEvent(
              new CustomEvent('erp-ai-workspace-changed', {
                detail: { workspaceId: d.workspaceId },
              }),
            );
          if (d.type === 'business') window.dispatchEvent(new Event('erp-business-changed'));
          if (d.module === 'workspaces')
            window.dispatchEvent(new Event('erp-ai-workspace-list-changed'));
          if (d.type === 'navigate' && isErpNavigation(d.url)) location.hash = d.url;
        }
        if (event === 'draft') {
          setDraft(d.text);
          draftRef.current = d.text;
        }
        if (event === 'queue')
          setProgress(
            d.state === 'running'
              ? '正在生成…'
              : d.state === 'backoff'
                ? 'API限流，退避等待中…'
                : '等待AI空闲连接 · 排队 ' + d.position,
          );
        if (event === 'progress') setProgress('正在处理 · ' + (d.receivedChars || 0) + ' 字符');
        if (event === 'tool')
          setProgress(
            '工具 ' + d.name + ' · ' + (d.state === 'running' ? '读取/准备中' : '已返回'),
          );
        if (event === 'result') {
          setThread(d);
          uploads.restore(d.pendingAttachments || []);
          if (d.messages?.at(-1)?.executed) window.dispatchEvent(new Event('erp-business-changed'));
          const activeTask = d.orderWorkflow?.tasks?.find(
            (t: any) => t.id === d.orderWorkflow.activeId,
          );
          if (activeTask && d.messages?.at(-1)?.executed)
            window.dispatchEvent(
              new CustomEvent('erp-ai-workspace-changed', {
                detail: { workspaceId: activeTask.workspaceId },
              }),
            );
          result = true;
        }
        if (event === 'error') failed = d.message;
      });
      const reader = r.body.getReader(),
        decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          parser.push(decoder.decode(value, { stream: true }));
        }
        parser.push(decoder.decode());
        parser.finish();
      } finally {
        reader.releaseLock();
      }
      if (failed) throw new Error(failed);
      if (!result) throw new Error('回复连接中断，请重新载入历史核实执行结果，避免重复提交。');
      setDraft('');
      setPartial('');
      draftRef.current = '';
      await loadState();
    } catch (e) {
      const aborted = (e as Error).name === 'AbortError';
      const fallback = aborted ? '' : draftRef.current.trim();
      if (fallback) setPartial(fallback);
      setError(
        userRef.current !== owner
          ? '账号已切换，旧请求已停止。'
          : aborted
            ? '已停止回复；可重新载入历史查看最终状态。'
            : (e as Error).message,
      );
      if (threadRef.current?.id) {
        const current = await loadThread(threadRef.current.id).catch(() => null);
        if (current?.messages.at(-1)?.executed)
          window.dispatchEvent(new Event('erp-business-changed'));
        if (
          fallback &&
          current?.messages.some(
            (m: any) => m.role === 'assistant' && String(m.text).includes(fallback.slice(0, 40)),
          )
        )
          setPartial('');
      }
    } finally {
      if (userRef.current === owner) {
        sending.current = false;
        setBusy(false);
        setProgress('');
        controller.current = null;
      }
    }
  }
  async function execute() {
    const owner = userId;
    setExecuting(true);
    setError('');
    try {
      await managementRequest('/assistant/previews/' + review.id + '/execute', {
        acknowledged: true,
        secondConfirmation: review.highRisk,
        ...(review.highRisk ? { password } : {}),
        ...(review.tool === 'records.propose_permanent_delete'
          ? { permanentConfirmation: confirmation }
          : {}),
      });
      if (userRef.current !== owner) return;
      setExecuted((x) => [...x, review.id]);
      setReview(null);
      if (thread?.id) await loadThread(thread.id);
      window.dispatchEvent(new Event('erp-business-changed'));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPassword('');
      setConfirmation('');
      setExecuting(false);
    }
  }
  return (
    <aside data-global-assistant="true" className="global-assistant">
      {!open ? (
        <button
          ref={floating.elementRef}
          className={'ga-launcher' + (floating.moving ? ' ga-moving' : '')}
          aria-label="打开全局AI助手"
          aria-haspopup="dialog"
          aria-expanded={false}
          title="纸箱精灵 · 点击聊天，拖动换位置；方向键也可移动"
          style={floating.style}
          {...floating.bind}
          onClickCapture={floating.onClickCapture}
          onClick={openAssistant}
        >
          <CartonSpirit />
          {busy && <i aria-label="AI正在处理" />}
        </button>
      ) : (
        <section
          ref={floating.elementRef}
          className={
            'ga-panel' +
            (large ? ' ga-large' : '') +
            (floating.compact ? ' ga-compact' : '') +
            (dragging ? ' ga-dragging' : '') +
            (floating.moving ? ' ga-moving' : '')
          }
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes('Files')) {
              e.preventDefault();
              setDragging(true);
            }
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            if (busy || uploads.working || speech.active) return;
            void uploads.add([...e.dataTransfer.files]);
          }}
          role="dialog"
          aria-modal="false"
          aria-label="全局AI业务助手"
          style={floating.style}
        >
          <header
            className="ga-header"
            tabIndex={0}
            aria-label="拖动聊天窗口，方向键也可移动"
            {...floating.bind}
          >
            <Bot size={20} />
            <strong>全局业务助手</strong>
            <GripHorizontal size={16} />
            <div>
              <button
                aria-label={large ? '恢复窗口' : '展开窗口'}
                onClick={() => {
                  setLarge((v) => !v);
                }}
              >
                {large ? <Minimize2 size={16} /> : <Expand size={16} />}
              </button>
              <button aria-label="缩小聊天窗口" onClick={() => setOpen(false)}>
                <ChevronDown size={17} />
              </button>
              <button aria-label="关闭聊天窗口" onClick={() => setOpen(false)}>
                <X size={17} />
              </button>
            </div>
          </header>
          {!userId ? (
            <p className="ga-empty">请先使用右上角原有管理账号登录。聊天和工具权限按账号隔离。</p>
          ) : (
            <>
              <div className="ga-toolbar">
                <select
                  aria-label="全局助手会话"
                  value={thread?.id || ''}
                  disabled={busy || executing || uploads.working}
                  onChange={(e) => {
                    setPartial('');
                    draftRef.current = '';
                    if (!e.target.value) {
                      void newThread();
                      return;
                    }
                    void loadThread(e.target.value);
                  }}
                >
                  <option value="">新会话</option>
                  {state?.threads.map((t: any) => (
                    <option key={t.id} value={t.id}>
                      {t.title}
                    </option>
                  ))}
                </select>
                <button
                  aria-label="新建助手会话"
                  disabled={busy || executing || uploads.working}
                  onClick={newThread}
                >
                  <Plus size={16} />
                </button>
                <button
                  aria-label="清空当前聊天"
                  disabled={!thread || busy || executing || uploads.working}
                  onClick={async () => {
                    if (
                      window.confirm(
                        '清空当前账号的这段聊天及本会话附件？未执行方案将失效，正式业务及审计保留。',
                      )
                    ) {
                      speech.cancel();
                      try {
                        const owner = userId,
                          next = await managementRequest(
                            '/assistant/threads/' + thread.id + '/clear',
                            {
                              acknowledged: true,
                            },
                          );
                        if (userRef.current !== owner) return;
                        setThread(next);
                        uploads.reset();
                        setPartial('');
                        draftRef.current = '';
                        setReview(null);
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }
                  }}
                >
                  <Eraser size={16} />
                </button>
                <button
                  aria-label="删除当前会话"
                  disabled={!thread || busy || executing || uploads.working}
                  onClick={removeThread}
                >
                  <Trash2 size={16} />
                </button>
              </div>
              <div
                className="ga-history"
                ref={history}
                onScroll={(e) => {
                  const el = e.currentTarget;
                  atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
                }}
              >
                {!thread?.messages.length && (
                  <div className="ga-empty">
                    <h3>查询实际业务，处理日常工作</h3>
                    <p>例如：查找最近两个月未完成的订单，或查询某个型号的库存。</p>
                    <a href="#ai-settings?tab=prompts&assistant=1">管理全局助手提示词</a>
                  </div>
                )}
                {thread?.messages.map((m: any) => (
                  <article className={'ga-message ga-' + m.role} key={m.id}>
                    <small>{m.role === 'user' ? '你' : 'AI业务助手'}</small>
                    <div className="ga-text">{m.text}</div>
                    {!!m.attachments?.length && (
                      <AttachmentCards
                        slots={attachmentSlots(m.attachments)}
                        disabled={busy || uploads.working}
                        preview={(a) =>
                          setPreviewFiles({
                            files: m.attachments.filter((a: AssistantAttachment) => !a.deleted),
                            id: a.id,
                          })
                        }
                        reuse={(a) => {
                          uploads.reuse(a);
                        }}
                        remove={async (s) => {
                          if (
                            !window.confirm(
                              '删除此聊天附件原文？历史保留已删除标记，不影响ERP订单和其他模块原件。',
                            )
                          )
                            return;
                          await uploads.remove(s);
                          if (thread?.id) await loadThread(thread.id);
                        }}
                      />
                    )}
                    {m.events?.map((e: any, i: number) => (
                      <div className="ga-tool-result" key={i}>
                        {e.tool} · {e.state}
                        {e.message ? ' · ' + e.message : ''}
                        {e.count != null ? ' · ' + e.count + ' 条' : ''}
                      </div>
                    ))}
                    {m.links
                      ?.filter((l: any) => isErpNavigation(warehouseDeliveryHash(l.url)))
                      .map((l: any, i: number) => (
                        <a className="ga-record-link" key={i} href={warehouseDeliveryHash(l.url)}>
                          {l.label} ↗
                        </a>
                      ))}
                    {m.plans?.map((p: any) => (
                      <div className="ga-plan" key={p.id}>
                        <strong>{p.label}</strong>
                        <p>
                          {executed.includes(p.id)
                            ? '已提交业务服务 · 结果已保存'
                            : p.highRisk
                              ? auth?.actor?.localAdministrator
                                ? '关联或不可逆操作 · 核对具体影响'
                                : '高风险 · 需超级模式、再次密码及二次确认'
                              : '等待逐项核对 · 尚未执行'}
                        </p>
                        <button
                          disabled={
                            executed.includes(p.id) || busy || executing || Date.now() > p.expiresAt
                          }
                          onClick={() => {
                            setReview(p);
                            setPassword('');
                            setConfirmation('');
                            setError('');
                          }}
                        >
                          {executed.includes(p.id)
                            ? '已执行'
                            : Date.now() > p.expiresAt
                              ? '方案已过期'
                              : '查看修改内容并确认'}
                        </button>
                      </div>
                    ))}
                    {m.executed && (
                      <div className="ga-tool-result">
                        后端已返回实际执行结果 · {m.executed.tool}
                        {Object.hasOwn(m.executed, 'before') && (
                          <details>
                            <summary>查看本次修改</summary>
                            <Changes before={m.executed.before} after={m.executed.result} />
                          </details>
                        )}
                      </div>
                    )}
                  </article>
                ))}
                <AssistantOrderTask workflow={thread?.orderWorkflow} />
                <AssistantBusinessTaskPanel
                  task={thread?.businessTask}
                  history={thread?.businessTaskHistory}
                  busy={busy}
                  resume={() => void send('继续')}
                  newTask={() => {
                    setNewBusinessTask(true);
                    setMessage('');
                  }}
                  pendingNew={newBusinessTask}
                  activate={async (taskId) => {
                    try {
                      await managementRequest(
                        '/assistant/threads/' + thread.id + '/tasks/activate',
                        { taskId },
                      );
                      await loadThread(thread.id);
                      setNewBusinessTask(false);
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                  diagnostics={async () => {
                    try {
                      const d = await managementRequest(
                        '/assistant/diagnostics?threadId=' + thread.id,
                      );
                      const url = URL.createObjectURL(
                        new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' }),
                      );
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = 'assistant-protocol-diagnostics.json';
                      a.click();
                      setTimeout(() => URL.revokeObjectURL(url), 1000);
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                />
                {partial && (
                  <article className="ga-message ga-assistant">
                    <small>AI业务助手 · 回复未完整接收</small>
                    <div className="ga-text">{partial}</div>
                    <div className="ga-tool-result">
                      回复未完整接收，请查看聊天历史中的后端执行结果，避免重复提交。
                    </div>
                  </article>
                )}
                {busy && (
                  <article className="ga-message ga-assistant">
                    <small>正在处理</small>
                    <div className="ga-text">{draft || progress}</div>
                  </article>
                )}
              </div>
              {review && (
                <div className="ga-review">
                  <div>
                    <strong>{review.label} · 最后核对</strong>
                    <button
                      disabled={executing}
                      aria-label="关闭核对方案"
                      onClick={() => setReview(null)}
                    >
                      <X size={16} />
                    </button>
                  </div>
                  <Changes before={review.before} after={review.after} />
                  {review.warnings.map((w: string, i: number) => (
                    <p key={i}>{w}</p>
                  ))}
                  {review.highRisk && !auth?.actor?.localAdministrator && (
                    <>
                      <p>
                        此操作涉及库存或不可逆影响。核对上方内容并验证密码后，点击下方按钮确认。
                      </p>
                      <label>
                        再次验证当前账号密码
                        <input
                          type="password"
                          autoComplete="current-password"
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                        />
                      </label>
                      {review.tool === 'records.propose_permanent_delete' && (
                        <label>
                          输入“永久删除”
                          <input
                            value={confirmation}
                            onChange={(e) => setConfirmation(e.target.value)}
                          />
                        </label>
                      )}
                    </>
                  )}
                  <button
                    className="primary"
                    disabled={
                      executing ||
                      (review.highRisk && !auth?.actor?.localAdministrator && !password)
                    }
                    onClick={execute}
                  >
                    {executing
                      ? '正在提交…'
                      : review.highRisk
                        ? '确认执行高风险操作'
                        : '确认执行本次方案'}
                  </button>
                </div>
              )}
              {context && (
                <div className="ga-context">
                  已选择：{context.label || context.module + ' #' + context.id}
                  <button aria-label="取消助手记录上下文" onClick={() => setContext(null)}>
                    <X size={12} />
                  </button>
                </div>
              )}
              {!!uploads.slots.length && (
                <div className="ga-pending-attachments">
                  <AttachmentCards
                    slots={uploads.slots}
                    disabled={busy}
                    preview={(a) => setPreviewFiles({ files: uploads.ready, id: a.id })}
                    remove={uploads.remove}
                    retry={uploads.retry}
                  />
                </div>
              )}
              {!uploads.slots.length && !!thread?.previousAttachments?.length && (
                <div className="ga-file-context">
                  <label>
                    <input
                      type="checkbox"
                      checked={includePrevious}
                      disabled={busy}
                      onChange={(e) => {
                        setIncludePrevious(e.target.checked);
                      }}
                    />
                    沿用最近附件：
                    {thread.previousAttachments.map((a: AssistantAttachment) => a.name).join('、')}
                  </label>
                </div>
              )}
              {(uploads.ready.length > 0 ||
                (includePrevious && thread?.previousAttachments?.length > 0)) && (
                <div className="ga-file-context">
                  <p>
                    附件发送至当前AI服务；说“识别这张订单”可进入草稿流程，核对后聊天确认导入。原文中的命令不会授权业务操作。
                  </p>
                  {officialDeepSeekEndpoint(state?.active?.endpoint) ? (
                    <p>
                      DeepSeek官方：文档发送提取文字，扫描PDF页转为图片；原件保存在系统。需要具有视觉能力的模型读取图像。
                    </p>
                  ) : (
                    <label>
                      文档发送方式
                      <select
                        aria-label="文档附件发送方式"
                        value={attachmentTextMode}
                        disabled={busy}
                        onChange={(e) => {
                          setAttachmentTextMode(e.target.value as typeof attachmentTextMode);
                        }}
                      >
                        <option value="with-text">原件＋兼容文字（默认）</option>
                        <option value="original">仅原文件直传</option>
                        <option value="text-only">仅兼容文字</option>
                      </select>
                    </label>
                  )}
                </div>
              )}
              {error && (
                <p className="ga-error" role="alert">
                  {error}
                </p>
              )}
              {speech.active && (
                <p className="ga-speech-status" role="status">
                  <span>
                    {speech.starting
                      ? '等待麦克风授权…'
                      : speech.transcribing
                        ? '正在本机识别语音…'
                        : '正在录音 ' + speech.seconds + ' 秒 / 60 秒，点击麦克风结束并识别'}
                  </span>
                  <button
                    type="button"
                    onClick={speech.cancel}
                    aria-label={speech.transcribing ? '取消语音识别' : '取消录音'}
                  >
                    取消
                  </button>
                </p>
              )}
              <form
                className="ga-compose"
                onSubmit={(e) => {
                  e.preventDefault();
                  void send();
                }}
              >
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  hidden
                  accept={attachmentAccept}
                  aria-label="选择聊天附件"
                  onChange={(e) => {
                    void uploads.add([...(e.target.files || [])]);
                    e.target.value = '';
                  }}
                />
                <button
                  type="button"
                  className="ga-attach-button"
                  aria-label="添加聊天附件"
                  title="添加附件，也可拖拽文件或粘贴图片；最多6份，每份10MB"
                  disabled={busy || uploads.working || speech.active}
                  onClick={() => fileInput.current?.click()}
                >
                  <Plus size={20} />
                </button>
                <textarea
                  aria-label="给全局助手的消息"
                  value={message}
                  maxLength={6000}
                  disabled={busy}
                  placeholder="输入业务问题或修改要求…"
                  onChange={(e) => setMessage(e.target.value)}
                  onPaste={(e) => {
                    if (speech.active) return;
                    const images = [...e.clipboardData.items]
                      .filter((i) => i.kind === 'file' && i.type.startsWith('image/'))
                      .map((i) => i.getAsFile())
                      .filter((f): f is File => !!f);
                    if (images.length) {
                      e.preventDefault();
                      void uploads.add(
                        images.map(
                          (f, i) =>
                            new File(
                              [f],
                              '剪贴板-' +
                                Date.now() +
                                '-' +
                                i +
                                '.' +
                                (f.type === 'image/jpeg'
                                  ? 'jpg'
                                  : f.type === 'image/webp'
                                    ? 'webp'
                                    : 'png'),
                              { type: f.type },
                            ),
                        ),
                      );
                    }
                  }}
                />
                <button
                  type="button"
                  className={'ga-attach-button' + (speech.recording ? ' ga-mic-recording' : '')}
                  aria-label={speech.recording ? '停止录音并识别' : '语音输入'}
                  aria-pressed={speech.recording}
                  title={
                    !speech.supported
                      ? '当前浏览器或访问方式不支持本地录音'
                      : speech.recording
                        ? '停止录音并识别'
                        : '语音输入（本机识别，识别结果只填入输入框，不自动发送）'
                  }
                  disabled={busy || speech.starting || speech.transcribing || !speech.supported}
                  onClick={() => {
                    setError('');
                    if (speech.recording) void speech.stop();
                    else void speech.start();
                  }}
                >
                  {speech.transcribing || speech.starting ? (
                    <LoaderCircle className="spin" size={19} />
                  ) : speech.recording ? (
                    <Square size={17} />
                  ) : (
                    <Mic size={19} />
                  )}
                </button>
                {busy ? (
                  <button
                    type="button"
                    aria-label="停止全局助手回复"
                    onClick={() => {
                      controller.current?.abort();
                      if (thread?.id)
                        void managementRequest(
                          '/assistant/threads/' + thread.id + '/cancel',
                          {},
                        ).catch(() => {});
                    }}
                  >
                    <Square size={17} />
                  </button>
                ) : (
                  <button
                    className="primary"
                    aria-label="发送给全局助手"
                    disabled={
                      (!message.trim() && !uploads.ready.length) ||
                      uploads.working ||
                      uploads.failed ||
                      !state?.active?.hasApiKey ||
                      speech.active
                    }
                  >
                    <Send size={18} />
                  </button>
                )}
              </form>
            </>
          )}
        </section>
      )}
      {previewFiles && (
        <AttachmentPreview
          files={previewFiles.files}
          initialId={previewFiles.id}
          close={() => setPreviewFiles(null)}
        />
      )}
    </aside>
  );
}
