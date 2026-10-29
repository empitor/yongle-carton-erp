import { useState, useRef, useEffect } from 'react';
import {
  Upload,
  Trash2,
  RefreshCw,
  Undo2,
  CheckCircle2,
  Save,
  FileText,
  LoaderCircle,
  X,
  ShieldCheck,
} from 'lucide-react';
import { evaluateDraft } from '../shared/order-draft';
import { precisionTotal } from '../shared/precision';
import { useAuthState, managementRequest } from './session';
import { formatDimensions } from '../shared/product-details';
import { useOrderWorkspace } from './import/useOrderWorkspace';
import FilePreview from './import/FilePreview';
import OrderDraftTable from './import/OrderDraftTable';
import BatchImportDialog from './BatchImportDialog';
import OrderChat from './import/OrderChat';
import AuthPanel from './AuthPanel';
import ImportFailures from './import/ImportFailures';
import ArrivalDraftPanel from './import/ArrivalDraftPanel';
import { DraftHeader } from './import/DraftUI';
import DeveloperEditor from './DeveloperEditor';
import { AI_HTTP_TIMEOUT_MS } from '../shared/ai-runtime';
import './order-import.css';
export default function OrderImportPage() {
  const [manage, setManage] = useState(false);
  const importAuth = useAuthState(),
    developer = !!(importAuth?.actor?.developerMode || importAuth?.actor?.localAdministrator);
  const api = useOrderWorkspace(),
    input = useRef<HTMLInputElement>(null);
  const [checked, setChecked] = useState<string[]>([]),
    [modal, setModal] = useState<{
      kind: 'delete' | 'authorize' | 'review' | 'trash' | 'import';
      ids: string[];
    } | null>(null),
    [agreed, setAgreed] = useState(false);
  const [importPreview, setImportPreview] = useState<any>(null),
    [importBusy, setImportBusy] = useState(false),
    [importError, setImportError] = useState('');
  const [showFailures, setShowFailures] = useState(false);
  const [batchImport, setBatchImport] = useState(false);
  const w = api.workspace,
    d = api.draft,
    id = api.selected,
    ops = api.operations(id),
    unsaved = ops.length > 0,
    busy = !!api.jobs[id],
    files = api.status?.workspaces || [],
    currentMode = w?.mode || 'order',
    pending = files.filter(
      (f) =>
        (f.mode || 'order') === 'order' &&
        !f.hasDraft &&
        !f.imported &&
        !['running', 'queued', 'backoff'].includes(f.task?.state || ''),
    ),
    evaluation = d ? evaluateDraft(d) : null;
  useEffect(
    () => setChecked((c) => c.filter((id) => files.some((f) => f.id === id))),
    [files.map((f) => f.id).join(',')],
  );
  const batchTargets = checked.length
    ? checked.filter((id) => pending.some((f) => f.id === id))
    : pending.map((f) => f.id);
  const open = (kind: 'delete' | 'authorize' | 'review' | 'trash' | 'import', ids: string[]) => {
    setAgreed(false);
    setModal({ kind, ids });
  };
  const recognize = (ids: string[]) => {
    if (!api.status?.active) {
      api.setFatal('请先在AI设置中启用一个预设');
      return;
    }
    open('authorize', ids);
  };
  const confirmReanalyze = () =>
    window.confirm('重新识别会覆盖当前草稿和人工修改，并重新请求AI。是否继续？');
  const reanalyzeFile = (f: (typeof files)[number]) => {
    if (!api.status?.active) {
      api.setFatal('请先在AI设置中启用一个预设');
      return;
    }
    if (f.imported) return;
    if ((f.mode || 'order') === 'arrival') {
      if (f.id !== id) {
        void api.choose(f.id);
        return;
      }
      window.dispatchEvent(new Event('erp-arrival-recognize'));
      return;
    }
    if (!f.hasDraft) {
      recognize([f.id]);
      return;
    }
    // 已识别成功但外发授权被撤销时，先重新授权，不能直接重新识别。
    if (f.id === id && w && !w.consent) {
      open('authorize', [f.id]);
      return;
    }
    if (confirmReanalyze()) void api.reanalyze(f.id);
  };
  const reanalyzeCurrent = () => {
    if (!api.status?.active) {
      api.setFatal('请先在AI设置中启用一个预设');
      return;
    }
    if (!id) return;
    // 已识别成功但外发授权被撤销时，先重新授权。
    if (w && !w.consent) {
      open('authorize', [id]);
      return;
    }
    if (confirmReanalyze()) void api.reanalyze(id);
  };
  const switchFilingMode = async (f: (typeof files)[number], mode: 'order' | 'arrival') => {
    if ((f.mode || 'order') === mode) return;
    if (
      !window.confirm('切换识别类型会保留已保存的草稿/关联，但未保存的识别内容会丢弃；确认切换吗？')
    )
      return;
    try {
      await api.setMode(f.id, mode);
    } catch (e) {
      api.setFatal((e as Error).message);
    }
  };
  const fileStatus = (f: (typeof files)[number]) => {
    if (f.imported)
      return (
        (f.imported.permanentlyDeleted ? '原正式订单已永久删除 · ' : '已导入 · ') +
        f.imported.orderNumber
      );
    if ((f.mode || 'order') === 'arrival') {
      return (
        api.jobs[f.id] ||
        (f.arrivalStatus === 'confirmed'
          ? '已入库 · ' + (f.arrivalNumber || '')
          : f.arrivalStatus === 'running'
            ? 'AI到货识别中'
            : f.arrivalStatus === 'failed'
              ? '到货识别失败 · 可查看错误档案'
              : f.arrivalStatus === 'cancelled'
                ? '已取消识别，旧结果保留'
                : f.arrivalDocId
                  ? '到货草稿待核对 · ' + (f.arrivalNumber || '')
                  : f.arrivalStatus === 'recognized'
                    ? '已识别到货单 · 待保存核对'
                    : '待识别到货单')
      );
    }
    const history = f.historyImport
      ? '曾处理 ' +
        f.historyImport.orderNumber +
        (f.historyImport.permanentlyDeleted
          ? '（已永久删除）'
          : f.historyImport.archived
            ? '（归档记录）'
            : '（有效）') +
        ' · '
      : '';
    return (
      history +
      (api.jobs[f.id] ||
        (f.task?.state === 'queued'
          ? '等待识别'
          : f.task?.state === 'backoff'
            ? '限流退避中'
            : f.task?.state === 'running'
              ? 'AI识别中'
              : f.task?.state === 'failed'
                ? '识别失败'
                : f.task?.state === 'cancelled'
                  ? '已取消'
                  : f.reviewed
                    ? '已核对'
                    : f.hasDraft
                      ? '待核对'
                      : '待识别'))
    );
  };
  const totalDone = files.filter((f) =>
      f.mode === 'arrival'
        ? ['recognized', 'draft', 'confirmed'].includes(f.arrivalStatus || '')
        : f.hasDraft,
    ).length,
    failed =
      files.filter((f) =>
        f.mode === 'arrival' ? f.arrivalStatus === 'failed' : f.task?.state === 'failed',
      ).length + api.uploads.filter((f) => f.state === 'failed').length;
  return (
    <div
      className="order-import"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        api.upload(Array.from(e.dataTransfer.files));
      }}
    >
      <header className="oi-workspace-head">
        <div>
          <h1>AI 智能订单导入</h1>
          <p>
            {api.status?.active ? (
              <>
                <span className="oi-status-dot" />
                {api.status.active.name} <b>{api.status.active.model}</b>
                <span>
                  {api.status?.inputMode === 'deepseek-compatible'
                    ? 'DeepSeek 文档兼容'
                    : '原件直读'}
                </span>
              </>
            ) : (
              <a href="#ai-settings">尚未启用AI，请配置服务</a>
            )}
          </p>
        </div>
        <div>
          <label className="oi-stream-toggle">
            <input
              type="checkbox"
              role="switch"
              aria-label="流式传输"
              checked={api.streamEnabled}
              disabled={Object.keys(api.jobs).length > 0}
              onChange={(e) => api.setStreamEnabled(e.target.checked)}
            />
            流式传输<small>Responses</small>
          </label>
          <AuthPanel />
          {developer && <button onClick={() => setManage(true)}>管理原件 / 任务 / 归档</button>}
          {manage && (
            <DeveloperEditor
              initialModule="workspaces"
              close={() => {
                setManage(false);
                void api.refresh();
              }}
            />
          )}
          {developer && id && (
            <button
              disabled={busy}
              onClick={async () => {
                try {
                  const r = await managementRequest<any>('/management/workspaces', {
                    action: 'fork',
                    items: [{ id }],
                  });
                  if (!r.results[0]?.success) throw Error(r.results[0]?.message || '复制失败');
                  await api.refresh();
                  api.choose(r.results[0].result.id);
                  api.setNotice(
                    '已复制为独立测试任务，可修改草稿或重新识别；有效正式订单仍有重复校验。',
                  );
                } catch (e) {
                  api.setNotice((e as Error).message);
                }
              }}
            >
              复制为新识别任务
            </button>
          )}
          <button onClick={() => void api.refresh()} title="刷新任务">
            <RefreshCw size={15} />
          </button>
          <button className="primary" onClick={() => input.current?.click()}>
            <Upload size={16} />
            上传文件
          </button>
          <input
            ref={input}
            type="file"
            aria-label="上传订单文件"
            multiple
            accept=".xls,.xlsx,.doc,.docx,.pdf,.jpg,.jpeg,.png"
            hidden
            onChange={(e) => {
              api.upload(Array.from(e.target.files || []));
              e.target.value = '';
            }}
          />
        </div>
      </header>
      <div className="oi-batch-bar">
        <div>
          <label>
            <input
              type="checkbox"
              aria-label="全选工作区文件"
              checked={!!files.length && files.every((f) => checked.includes(f.id))}
              onChange={(e) => setChecked(e.target.checked ? files.map((f) => f.id) : [])}
            />
            全选
          </label>
          <strong>{files.length + api.uploads.length}份文件</strong>
          <span>已识别 {totalDone}</span>
          <span>待识别 {pending.length}</span>
          <span>待核对 {files.filter((f) => f.hasDraft && !f.reviewed).length}</span>
          {api.status?.queue && (
            <span>
              识别并发 {api.status.queue.active}/{api.status.queue.limit} · 排队{' '}
              {api.status.queue.waiting}
            </span>
          )}
          <span className={failed ? 'oi-bad' : ''}>失败 {failed}</span>
          {Object.keys(api.jobs).length > 0 && (
            <span>
              <LoaderCircle className="spin" size={13} />
              处理中 {Object.keys(api.jobs).length}
            </span>
          )}
        </div>
        <div>
          {!!checked.length && (
            <button className="danger" onClick={() => open('delete', checked)}>
              批量删除（已选{checked.length}份）
            </button>
          )}
          <button
            disabled={
              !importAuth?.actor ||
              unsaved ||
              !checked.some((id) =>
                files.some(
                  (f) =>
                    f.id === id && (f.mode || 'order') === 'order' && f.hasDraft && !f.imported,
                ),
              )
            }
            onClick={() => setBatchImport(true)}
          >
            批量核对并导入
          </button>
          <button
            disabled={!batchTargets.length}
            onClick={() =>
              recognize(
                checked.length
                  ? checked.filter((id) => pending.some((f) => f.id === id))
                  : pending.map((f) => f.id),
              )
            }
          >
            批量识别{checked.length ? '所选 ' + checked.length + ' 份' : ''}
          </button>
          <button onClick={() => open('trash', [])}>
            归档记录{api.status?.archives?.length ? ' (' + api.status.archives!.length + ')' : ''}
          </button>
          <button onClick={() => setShowFailures(true)}>错误档案</button>
        </div>
      </div>
      {(api.fatal || api.errors[id]) && (
        <div className="oi-alert" role="alert">
          {api.fatal || api.errors[id]}
          <button
            onClick={() => {
              api.setFatal('');
              api.dismissError(id);
            }}
            aria-label="关闭提示"
          >
            <X size={14} />
          </button>
        </div>
      )}
      {api.notice && (
        <div className="oi-notice" role="status">
          {api.notice}
          <button onClick={() => api.setNotice('')} aria-label="关闭通知">
            <X size={13} />
          </button>
        </div>
      )}
      {busy && (
        <div className="oi-stream-progress" role="status" aria-live="polite">
          <LoaderCircle className="spin" size={14} />
          <span>
            {api.progress[id]?.stage === 'validating'
              ? '完整响应已结束，正在校验草稿'
              : api.progress[id]?.stage === 'receiving'
                ? '正在接收模型输出'
                : '等待AI处理原文件'}{' '}
            · 已接收 {api.progress[id]?.receivedChars || 0} 字符 · 已等待{' '}
            {Math.floor((api.progress[id]?.elapsedMs || 0) / 1000)} 秒
          </span>
          <small>完整响应校验通过后才保存</small>
        </div>
      )}
      <div className="oi-workspace-body">
        <aside className="oi-left">
          <div className="oi-file-list">
            <header>
              <strong>订单文件</strong>
              <span>XLS / Word / PDF / 图片</span>
            </header>
            {!files.length && !api.uploads.length && (
              <button className="oi-upload-empty" onClick={() => input.current?.click()}>
                <Upload size={22} />
                <b>选择或拖入订单</b>
                <span>每批20份 · 单文件10MB以内</span>
              </button>
            )}
            {api.uploads.map((f) => (
              <div className="oi-file-row pending" key={f.id}>
                <FileText size={16} />
                <div>
                  <b title={f.file.name}>{f.file.name}</b>
                  <small>
                    {f.state === 'queued'
                      ? '排队上传'
                      : f.state === 'uploading'
                        ? '保存原文件中'
                        : f.error}
                  </small>
                </div>
                {f.state === 'failed' && (
                  <>
                    <button
                      onClick={() => api.retryUpload(f.id)}
                      aria-label={'重试上传 ' + f.file.name}
                    >
                      <RefreshCw size={14} />
                    </button>
                    <button
                      onClick={() => api.discardUpload(f.id)}
                      aria-label={'移除失败上传 ' + f.file.name}
                    >
                      <X size={14} />
                    </button>
                  </>
                )}
              </div>
            ))}
            {files.map((f) => (
              <div key={f.id} className={'oi-file-row ' + (id === f.id ? 'active' : '')}>
                <input
                  type="checkbox"
                  aria-label={'选择文件 ' + f.fileName}
                  checked={checked.includes(f.id)}
                  onChange={(e) =>
                    setChecked((c) =>
                      e.target.checked ? [...c, f.id] : c.filter((x) => x !== f.id),
                    )
                  }
                />
                <button
                  className="oi-file-select"
                  onClick={() => {
                    void api.choose(f.id);
                  }}
                >
                  <b title={f.fileName}>{f.fileName}</b>
                  <small
                    className={
                      (
                        f.mode === 'arrival'
                          ? f.arrivalStatus === 'failed'
                          : f.task?.state === 'failed'
                      )
                        ? 'oi-bad'
                        : ''
                    }
                  >
                    {fileStatus(f)}
                  </small>
                </button>
                <select
                  className="oi-mode-select"
                  aria-label={'识别类型 ' + f.fileName}
                  value={f.mode || 'order'}
                  disabled={
                    (f.mode === 'arrival' &&
                      !!f.arrivalDocId &&
                      ['confirmed', 'cancelled', 'reversed'].includes(f.arrivalStatus || '')) ||
                    !!api.jobs[f.id] ||
                    ['running', 'queued', 'backoff'].includes(f.task?.state || '')
                  }
                  onChange={(e) => void switchFilingMode(f, e.target.value as 'order' | 'arrival')}
                >
                  <option value="order">订单识别</option>
                  <option value="arrival">到货单识别</option>
                </select>
                {(f.mode || 'order') === 'order' &&
                  (api.jobs[f.id] ||
                    ['running', 'queued', 'backoff'].includes(f.task?.state || '')) && (
                    <button
                      aria-label={'取消识别 ' + f.fileName}
                      title="取消任务"
                      onClick={() => void api.cancel(f.id)}
                    >
                      <X size={14} />
                    </button>
                  )}
                {!f.imported &&
                  !(
                    f.mode === 'arrival' &&
                    !!f.arrivalDocId &&
                    ['confirmed', 'cancelled', 'reversed'].includes(f.arrivalStatus || '')
                  ) &&
                  !api.jobs[f.id] &&
                  !['running', 'queued', 'backoff'].includes(f.task?.state || '') && (
                    <button
                      aria-label={'重新识别 ' + f.fileName}
                      title={
                        f.hasDraft
                          ? '重新识别（会覆盖当前草稿和人工修改）'
                          : '重新识别该文件（会重新请求API）'
                      }
                      onClick={() => reanalyzeFile(f)}
                    >
                      <RefreshCw size={14} />
                    </button>
                  )}
                <button
                  disabled={!developer}
                  onClick={async () => {
                    const current = await api.request<any>('/' + f.id);
                    await api.request('/' + f.id + '/archive', {
                      expectedRevision: current.revision,
                    });
                    await api.refresh();
                  }}
                >
                  归档
                </button>
                <button
                  className="oi-delete"
                  aria-label={'删除文件 ' + f.fileName}
                  title="删除工作区文件"
                  onClick={() => open('delete', [f.id])}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
          <FilePreview workspace={w} compatible={api.status?.inputMode === 'deepseek-compatible'} />
        </aside>
        <div className="oi-right">
          {currentMode === 'arrival' ? (
            <ArrivalDraftPanel
              key={id}
              workspace={w}
              fileId={id}
              aiStatus={api.status}
              setNotice={api.setNotice}
              refresh={api.refresh}
              recognizeArrival={api.recognizeArrival}
              linkArrival={api.linkArrival}
              assistantRequest={async (path, body, onProgress, signal) => {
                const result = await api.request<any>(
                  '/' + id + '/arrival/assistant' + path,
                  body,
                  onProgress,
                  signal,
                  path === '/chat' ? AI_HTTP_TIMEOUT_MS * 3 : AI_HTTP_TIMEOUT_MS,
                );
                if (body && !signal?.aborted) await api.load(id);
                return result;
              }}
            />
          ) : (
            <>
              <section className="oi-draft">
                <DraftHeader title={'订单草稿' + (w ? ' · ' + w.fileName : '')}>
                  {w?.confirmedRevision === w?.revision && w && (
                    <span className="oi-reviewed">
                      <CheckCircle2 size={13} />
                      已核对
                    </span>
                  )}
                  {w && !w.draft && !w.imported && (
                    <button className="primary" disabled={busy} onClick={() => recognize([id])}>
                      {busy
                        ? '正在识别…'
                        : w.task?.state === 'failed'
                          ? '重试识别'
                          : '识别当前文件'}
                    </button>
                  )}
                  {w && w.draft && !w.imported && (
                    <button disabled={busy} onClick={reanalyzeCurrent}>
                      {busy ? '正在识别…' : '重新识别'}
                    </button>
                  )}
                  {w && !w.imported && (
                    <button onClick={() => recognize([id])} disabled={busy}>
                      外发授权
                    </button>
                  )}
                  {w?.consent && (
                    <button
                      onClick={() => void api.action(id, 'revoke-consent', {}, '撤销授权')}
                      disabled={busy}
                    >
                      撤销授权
                    </button>
                  )}
                  {w && <small>修订 {w.revision}</small>}
                </DraftHeader>
                {w?.historyImport && (
                  <div className="oi-notice" role="status">
                    该文件此前处理过：订单 {w.historyImport.orderNumber}
                    {w.historyImport.permanentlyDeleted
                      ? '（已永久删除，可直接重新导入）'
                      : w.historyImport.archived
                        ? '（在业务归档记录）'
                        : '（当前有效）'}
                    。重新识别不受影响，正式入库时会再次检查重复。
                    {!w.historyImport.permanentlyDeleted && (
                      <a
                        href={
                          w.historyImport.archived
                            ? '#orders?archived=1'
                            : '#orders?order=' + w.historyImport.orderId
                        }
                      >
                        {w.historyImport.archived ? '去归档记录恢复或查看' : '查看原订单'}
                      </a>
                    )}
                  </div>
                )}
                <div className="oi-draft-content">
                  {w && d ? (
                    <OrderDraftTable
                      key={id}
                      workspace={{ ...w, evaluation }}
                      draft={d}
                      locked={busy || (!!w?.imported && !developer)}
                      change={(k, v, line) => api.change(id, k, v, line)}
                      onMapping={(m) => {
                        if (unsaved) {
                          api.setFatal('请先保存手工字段修改，再保存关联选择');
                          return;
                        }
                        void api.action(id, 'mapping', { mapping: m }, '保存关联');
                      }}
                    />
                  ) : (
                    <div className="oi-empty">
                      <FileText size={30} />
                      <p>{w ? '等待识别订单' : '选择左侧文件开始'}</p>
                      <span>AI识别后直接填写标准订单草稿，所有修改都可核对。</span>
                    </div>
                  )}
                </div>
                {w && d && (
                  <div className="oi-draft-bottom">
                    <div className="oi-order-totals">
                      <span>
                        数量 <b>{evaluation?.totalQuantity || '待确认'}</b>
                      </span>
                      <span>
                        {unsaved ? '金额预览' : '精确金额'}{' '}
                        <strong>{evaluation?.totalAmount || '待确认'}</strong>
                      </span>
                      <small>
                        {d.header.currency.value || '币种待确认'} ·{' '}
                        {d.header.taxMode.value || '税费待确认'}
                      </small>
                    </div>
                    <div className="oi-draft-actions">
                      <button
                        disabled={!unsaved || busy}
                        onClick={() => void api.action(id, 'edit', { operations: ops }, '保存修改')}
                      >
                        <Save size={14} />
                        保存修改{unsaved ? ' (' + ops.length + ')' : ''}
                      </button>
                      <button
                        disabled={!w.canUndo || busy || unsaved}
                        onClick={() => void api.action(id, 'undo', {}, '撤销修改')}
                      >
                        <Undo2 size={14} />
                        撤销
                      </button>
                      <details>
                        <summary>
                          核对事项{' '}
                          {evaluation?.issues.filter((i) => i.path !== 'products.optional')
                            .length || 0}
                          {w.changes.length ? ' / 修改 ' + w.changes.length + ' 项' : ''}
                        </summary>
                        <div className="oi-review-popover">
                          {w.changes.map((c, i) => (
                            <p key={i}>
                              <b>{c.label}</b>：{c.before || '空'} → {c.after || '空'}
                            </p>
                          ))}
                          {evaluation?.issues
                            .filter((i) => i.path !== 'products.optional')
                            .map((i, n) => (
                              <p key={n} className={i.severity === 'error' ? 'oi-bad' : ''}>
                                {i.message}
                              </p>
                            ))}
                          {[...new Set(d.warnings)]
                            .filter((s) => !evaluation?.issues.some((i) => i.message === s))
                            .map((s, i) => (
                              <p key={'w' + i}>{s}</p>
                            ))}
                        </div>
                      </details>
                    </div>
                  </div>
                )}
              </section>
              <OrderChat
                workspace={w}
                locked={busy || (!!w?.imported && !developer)}
                unsaved={unsaved}
                send={(message) => api.action(id, 'chat', { message }, '聊天核对中')}
              />
              <footer className="oi-review-bar">
                <div>
                  <ShieldCheck size={15} />
                  <span>
                    {w?.imported
                      ? (w.imported.permanentlyDeleted
                          ? '正式订单已永久删除，来源凭据保留：'
                          : '已导入正式订单 ') + w.imported.orderNumber
                      : unsaved
                        ? '有未保存修改'
                        : w?.confirmedRevision === w?.revision && w
                          ? '当前草稿已核对'
                          : '人工核对后确认草稿'}
                  </span>
                </div>
                <div>
                  {!importAuth?.actor?.localAdministrator && (
                    <button
                      disabled={!d || busy || unsaved || !!w?.imported}
                      onClick={() => open('review', [id])}
                    >
                      核对并确认
                    </button>
                  )}
                  {w?.imported?.permanentlyDeleted ? (
                    <span>不可从归档记录恢复</span>
                  ) : w?.imported ? (
                    <a
                      href={
                        w.imported.archived
                          ? '#orders?archived=1'
                          : '#orders?order=' + w.imported.orderId
                      }
                    >
                      查看正式订单 {w.imported.orderNumber}
                      {w.imported.archived ? '（已归档）' : ''}
                    </a>
                  ) : (
                    <button
                      className="primary"
                      disabled={!d || busy || unsaved || importBusy}
                      onClick={async () => {
                        setImportBusy(true);
                        setImportError('');
                        try {
                          const preview = await api.request<any>('/' + id + '/preview', {
                            expectedRevision: w!.revision,
                          });
                          setImportPreview(preview);
                          open('import', [id]);
                        } catch (error) {
                          api.setFatal((error as Error).message);
                        } finally {
                          setImportBusy(false);
                        }
                      }}
                    >
                      {importBusy ? '生成导入预览…' : '确认并导入 ERP'}
                    </button>
                  )}
                </div>
              </footer>
            </>
          )}
        </div>
      </div>
      {showFailures && <ImportFailures selectedId={id} close={() => setShowFailures(false)} />}
      {modal && (
        <div className="oi-modal-backdrop" role="presentation">
          <section
            className="oi-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="oi-dialog-title"
          >
            <button className="oi-modal-close" aria-label="关闭窗口" onClick={() => setModal(null)}>
              <X size={18} />
            </button>
            {modal.kind === 'delete' ? (
              <>
                <h2 id="oi-dialog-title">删除 {modal.ids.length} 份工作区文件？</h2>
                <p>{modal.ids.map((id) => files.find((f) => f.id === id)?.fileName).join('、')}</p>
                <p>
                  将取消正在运行的任务，并从当前工作区移除原件、未提交草稿、修改历史及该文件聊天。这是物理删除，不能恢复。不会删除正式ERP客户、产品或订单。
                </p>
                <div className="oi-modal-actions">
                  <button onClick={() => setModal(null)}>保留文件</button>
                  <button
                    className="danger"
                    onClick={async () => {
                      const ids = modal.ids;
                      setModal(null);
                      const removed = await api.removeMany(ids);
                      setChecked((c) => c.filter((id) => !removed.includes(id)));
                    }}
                  >
                    删除文件
                  </button>
                </div>
              </>
            ) : modal.kind === 'authorize' ? (
              <>
                <h2 id="oi-dialog-title">确认订单数据外发范围</h2>
                <p>以下 {modal.ids.length} 份文件将分别识别，不会合并。</p>
                <ul>
                  {modal.ids.map((id) => (
                    <li key={id}>{files.find((f) => f.id === id)?.fileName}</li>
                  ))}
                </ul>
                <p>
                  <b>发送至：</b>
                  {api.status?.active?.endpoint}
                  <br />
                  <b>模型：</b>
                  {api.status?.active?.model}
                </p>
                <p>
                  {api.status?.scope || '发送当前文件、草稿及本文件聊天；不发送ERP客户和产品档案。'}
                  调用可能产生模型费用。
                </p>
                <label className="oi-agreement">
                  <input
                    type="checkbox"
                    checked={agreed}
                    onChange={(e) => setAgreed(e.target.checked)}
                  />
                  我确认以上文件及后续本文件聊天可发送给所示服务，授权24小时，可撤销。
                </label>
                <div className="oi-modal-actions">
                  <button onClick={() => setModal(null)}>暂不发送</button>
                  <button
                    className="primary"
                    disabled={!agreed || !modal.ids.length}
                    onClick={async () => {
                      const ids = modal.ids;
                      setModal(null);
                      const drafted = ids.filter(
                        (fid) => files.find((f) => f.id === fid)?.hasDraft,
                      );
                      // 已有草稿的文件只重新授权，不自动重新识别；避免授权按钮
                      // 因草稿存在而被识别流程跳过、看起来没有反应。
                      if (!drafted.length) {
                        void api.recognize(ids);
                        return;
                      }
                      const results = await Promise.all(drafted.map((fid) => api.authorize(fid)));
                      if (results.every(Boolean))
                        api.setNotice('外发授权已重新确认；如需重新识别，请点“重新识别”。');
                    }}
                  >
                    {modal.ids.some((fid) => files.find((f) => f.id === fid)?.hasDraft)
                      ? '确认外发授权'
                      : '授权并继续'}
                  </button>
                </div>
              </>
            ) : modal.kind === 'import' && importPreview ? (
              <>
                <h2 id="oi-dialog-title">确认正式导入 ERP</h2>
                <p>
                  {importPreview.plan.source.fileName} · 草稿修订{' '}
                  {importPreview.plan.source.revision}
                </p>
                <p>
                  <b>客户：{importPreview.plan.customer.name}</b>（
                  {importPreview.plan.customer.mode === 'new' ? '新建客户' : '匹配已有客户'}）
                </p>
                <p>
                  币种：{importPreview.plan.order.currency}　订单日期：
                  {importPreview.plan.order.orderDate}　状态：
                  {importPreview.plan.order.status}　客户采购单号：
                  {importPreview.plan.order.externalPurchaseOrder || '未提供'}
                  　交货日期：{importPreview.plan.order.deliveryDate}
                </p>
                <div className="import-confirm-lines">
                  {importPreview.plan.order.lines.map((line: any, i: number) => (
                    <article key={i}>
                      <strong>
                        {i + 1}. {line.productName}
                      </strong>
                      <p>规格型号：{line.specification}</p>
                      <p>备注：{line.notes || '无'}</p>
                      {(line.taxRate || line.taxMode || line.deliveryDate) && (
                        <p>
                          明细税率：{line.taxRate || '未注明'}；{line.taxMode || '口径未注明'}
                          ；明细交期：{line.deliveryDate || '未单独注明'}
                        </p>
                      )}
                      <p>
                        数量 {line.quantity} {line.unit} × 单价 {line.unitPriceExact}{' '}
                        元；程序明细金额 {precisionTotal([line]).exact} 元
                      </p>
                      <p>
                        产品档案：{importPreview.plan.products[i].name}（
                        {importPreview.plan.products[i].mode === 'new' ? '新建' : '已有'}）
                      </p>
                      {importPreview.plan.products[i].mode === 'new' && (
                        <p>
                          新档案：{formatDimensions(importPreview.plan.products[i].input)}；
                          {importPreview.plan.products[i].input.material}；
                          {importPreview.plan.products[i].input.flute}；
                          {importPreview.plan.products[i].input.requirements || '无额外加工要求'}
                        </p>
                      )}
                    </article>
                  ))}
                </div>
                <p>
                  <b>程序计算合计：{importPreview.plan.total} 元</b>；税率{' '}
                  {importPreview.plan.order.taxRate || '未明确'}；{importPreview.plan.order.taxMode}
                </p>
                <p>
                  合同条件：{importPreview.plan.order.terms || '无'}　整单备注：
                  {importPreview.plan.order.notes || '无'}
                </p>
                <details>
                  <summary>查看全部核对提示（{importPreview.plan.warnings.length}项）</summary>
                  {importPreview.plan.warnings.map((warning: string, i: number) => (
                    <p key={i}>{warning}</p>
                  ))}
                </details>
                {!importAuth?.actor?.localAdministrator && (
                  <label className="oi-agreement">
                    <input
                      type="checkbox"
                      checked={agreed}
                      onChange={(e) => setAgreed(e.target.checked)}
                      disabled={importBusy}
                    />
                    我已核对全部明细、客户/产品匹配与新建计划、金额和税费，确认按此预览正式入库。
                  </label>
                )}
                {importError && (
                  <p role="alert" className="oi-bad">
                    {importError}
                  </p>
                )}
                <div className="oi-modal-actions">
                  <button disabled={importBusy} onClick={() => setModal(null)}>
                    返回核对
                  </button>
                  <button
                    className="primary"
                    disabled={(!importAuth?.actor?.localAdministrator && !agreed) || importBusy}
                    onClick={async () => {
                      setImportBusy(true);
                      try {
                        const receipt = await api.request<any>('/' + id + '/execute', {
                          previewId: importPreview.id,
                          acknowledged: true,
                        });
                        await api.load(id);
                        await api.refresh();
                        api.setNotice(
                          '已正式导入订单 ' + receipt.orderNumber + '，可点击“查看正式订单”。',
                        );
                        setModal(null);
                      } catch (error) {
                        setImportError((error as Error).message);
                      } finally {
                        setImportBusy(false);
                      }
                    }}
                  >
                    {importBusy ? '正在提交…' : '确认导入'}
                  </button>
                </div>
              </>
            ) : modal.kind === 'review' ? (
              <>
                <h2 id="oi-dialog-title">核对当前订单草稿</h2>
                <p>
                  {w?.fileName} · 修订 {w?.revision}
                </p>
                <div className="oi-review-summary">
                  <b>客户：{d?.header.buyerName.value || '待确认'}</b>
                  <span>
                    总数量 {evaluation?.totalQuantity}　精确金额 {evaluation?.totalAmount}
                  </span>
                  <span>交期 {d?.header.deliveryDate.value || '待确认'}</span>
                </div>
                <p>本次确认只保存当前草稿核对状态，不创建正式订单；修改字段或关联后确认失效。</p>
                <details>
                  <summary>查看 {evaluation?.issues.length || 0} 项核对事项</summary>
                  {evaluation?.issues.map((i, n) => (
                    <p key={n}>{i.message}</p>
                  ))}
                </details>
                <label className="oi-agreement">
                  <input
                    type="checkbox"
                    checked={agreed}
                    onChange={(e) => setAgreed(e.target.checked)}
                  />
                  我已对照原件核对，并了解仍有待处理事项。
                </label>
                <div className="oi-modal-actions">
                  <button onClick={() => setModal(null)}>继续修改</button>
                  <button
                    className="primary"
                    disabled={!agreed}
                    onClick={async () => {
                      setModal(null);
                      const result = await api.action(
                        id,
                        'confirm',
                        { acknowledged: true },
                        '记录核对',
                      );
                      if (result) api.setNotice('当前修订核对完成，未写入正式ERP');
                    }}
                  >
                    确认草稿
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2 id="oi-dialog-title">已归档工作区</h2>
                <p>归档记录仍保存原件、任务和草稿；历史软删除文件也保留在此，可恢复或直接删除。</p>
                {api.status?.archives?.length ? (
                  api.status.archives!.map((f) => (
                    <div className="oi-trash-row" key={f.id}>
                      <span>{f.fileName}</span>
                      <button
                        onClick={async () => {
                          await api.request('/' + f.id + '/open-archive', {});
                          await api.choose(f.id);
                          setModal(null);
                        }}
                      >
                        编辑
                      </button>
                      <button
                        onClick={async () => {
                          await api.restore(f.id);
                          setModal(null);
                        }}
                      >
                        恢复
                      </button>
                      <button className="danger" onClick={() => open('delete', [f.id])}>
                        删除
                      </button>
                    </div>
                  ))
                ) : (
                  <p>没有归档记录。</p>
                )}
              </>
            )}
          </section>
        </div>
      )}
      {batchImport && (
        <BatchImportDialog
          files={files.filter(
            (f) =>
              checked.includes(f.id) &&
              (f.mode || 'order') === 'order' &&
              f.hasDraft &&
              !f.imported,
          )}
          request={api.request}
          close={() => setBatchImport(false)}
          done={() => {
            void api.refresh();
            window.dispatchEvent(new Event('erp-business-changed'));
          }}
        />
      )}
    </div>
  );
}
