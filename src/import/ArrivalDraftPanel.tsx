import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, FileText, LoaderCircle, Save, ShieldCheck } from 'lucide-react';
import { managementRequest, useAuthState } from '../session';
import { officialDeepSeekEndpoint } from '../../shared/assistant-attachments';
import {
  recognizedArrivalDraft,
  arrivalDraftIssues,
  arrivalTotals,
} from '../../shared/arrival-draft';
import { DraftHeader, DraftNotice } from './DraftUI';
import ArrivalDraftForm from './ArrivalDraftForm';
import ManagementDialog from '../ManagementDialog';
import DraftChat from './DraftChat';
import { arrivalReviewSchema } from '../../shared/arrival-assistant';
const reviewValue = (v: any) => {
  try {
    return JSON.stringify(arrivalReviewSchema.parse(v));
  } catch {
    return JSON.stringify(v);
  }
};

export default function ArrivalDraftPanel({
  workspace,
  fileId,
  aiStatus,
  setNotice,
  refresh,
  recognizeArrival,
  linkArrival,
  assistantRequest,
}: {
  assistantRequest: (
    path: string,
    body?: unknown,
    onProgress?: (p: any) => void,
    signal?: AbortSignal,
  ) => Promise<any>;
  workspace: any;
  fileId: string | null;
  aiStatus: any;
  setNotice: (text: string) => void;
  refresh: () => unknown;
  recognizeArrival: (id: string, force?: boolean) => Promise<any>;
  linkArrival: (id: string, docId: number | null, sourceId?: string | null) => Promise<any>;
}) {
  const auth = useAuthState(),
    canEdit =
      !!auth?.actor &&
      (auth.actor.superAdminMode || auth.actor.permissions.includes('business:edit'));
  const [data, setData] = useState<any>({ suppliers: [], purchases: [], items: [] }),
    [editor, setEditor] = useState<any>(null),
    [doc, setDoc] = useState<any>(null),
    [source, setSource] = useState<any>(null),
    [preview, setPreview] = useState<any>(null),
    [warnings, setWarnings] = useState<string[]>([]),
    [baseline, setBaseline] = useState(''),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [assistant, setAssistant] = useState<any>(null),
    [chatProgress, setChatProgress] = useState('');
  const mounted = useRef(true),
    pending = useRef(false),
    chatController = useRef<AbortController | null>(null),
    saveRequest = useRef(crypto.randomUUID());
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      chatController.current?.abort();
    };
  }, []);
  useEffect(() => () => chatController.current?.abort(), [auth?.actor?.id]);
  const loadData = () =>
    Promise.all([
      managementRequest<any[]>('/suppliers'),
      managementRequest<any[]>('/purchases'),
      managementRequest<any[]>('/warehouse/items'),
    ]).then(([suppliers, purchases, items]) => ({ suppliers, purchases, items }));
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError('');
    Promise.all([
      loadData(),
      workspace?.arrivalDocId ? managementRequest<any>('/flow/' + workspace.arrivalDocId) : null,
      workspace?.arrivalSourceId
        ? managementRequest<any>('/flow/sources/' + workspace.arrivalSourceId)
        : null,
      workspace?.arrivalSourceId && canEdit ? assistantRequest('') : null,
    ])
      .then(([metadata, saved, original, review]) => {
        if (!live) return;
        setData(metadata);
        setAssistant(review);
        setSource(original);
        setWarnings(
          original?.result ? recognizedArrivalDraft(original, metadata.suppliers).warnings : [],
        );
        if (saved) {
          setDoc(saved);
          setEditor(review?.draft || structuredClone(saved));
          setBaseline(reviewValue(saved));
        } else if (original?.result) {
          const recognized = recognizedArrivalDraft(original, metadata.suppliers);
          setEditor(review?.draft || recognized.draft);
          setWarnings(recognized.warnings);
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [
    workspace?.id,
    workspace?.arrivalDocId,
    workspace?.arrivalSourceId,
    auth?.actor?.id,
    canEdit,
  ]);
  useEffect(() => {
    const changed = () => {
      void loadData()
        .then((value) => {
          if (mounted.current) setData(value);
        })
        .catch(() => {});
    };
    window.addEventListener('erp-business-changed', changed);
    return () => window.removeEventListener('erp-business-changed', changed);
  }, []);
  const confirmed = doc?.status === 'confirmed',
    editable =
      (!!auth?.actor?.developerMode || !doc || (doc.status === 'draft' && !doc.archived)) &&
      !assistant?.readOnly;
  const dirty = !!editor && (!doc || reviewValue(editor) !== baseline),
    issues = editor ? arrivalDraftIssues(editor) : [],
    totals = editor ? arrivalTotals(editor.lines) : null;
  const change = (patch: any) => {
    setPreview(null);
    setEditor((v: any) => ({ ...v, ...patch }));
  };
  async function run(job: () => Promise<void>) {
    if (pending.current) return false;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await job();
      return true;
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
      return false;
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function recognize() {
    if (!fileId || !workspace || pending.current || !canEdit || !editable) return;
    const active = aiStatus?.active;
    if (!active) {
      setError('请先在AI设置中启用预设。');
      return;
    }
    const scope = officialDeepSeekEndpoint(active.endpoint)
      ? '图片发送原图；文档在本机提取兼容文字，扫描PDF转页图片；不执行OCR，排版或内嵌图片可能缺失，原件保留。'
      : '发送当前完整原件字节。';
    if (
      !window.confirm(
        (dirty ? '重新识别将覆盖未保存的修改。\n' : '') +
          '将向 ' +
          active.endpoint +
          ' 的 ' +
          active.model +
          ' 发送当前供应商到货文件及专用提示词。' +
          scope +
          '不会发送ERP档案库或库存库。是否继续？',
      )
    )
      return;
    await run(async () => {
      const result = await recognizeArrival(fileId, !!source?.result || !!editor);
      if (!result?.result) throw Error('到货识别未完成，请查看该文件的错误提示或错误档案。');
      if (!mounted.current) return;
      const next = recognizedArrivalDraft(result, data.suppliers, doc);
      setSource(result);
      setEditor(next.draft);
      setWarnings(next.warnings);
      setPreview(null);
      saveRequest.current = crypto.randomUUID();
      const state = await assistantRequest('');
      const persisted = await assistantRequest('', {
        expectedRevision: state.workspace.revision,
        draft: next.draft,
      });
      if (mounted.current) setAssistant(persisted);
    });
  }
  useEffect(() => {
    const handler = () => {
      void recognize();
    };
    window.addEventListener('erp-arrival-recognize', handler);
    return () => window.removeEventListener('erp-arrival-recognize', handler);
  });
  const acceptAssistant = (state: any) => {
    if (!mounted.current) return;
    setAssistant(state);
    setEditor(state.draft);
    setPreview(null);
    saveRequest.current = crypto.randomUUID();
  };
  async function syncCurrent() {
    const current = assistant || (await assistantRequest(''));
    const saved = await assistantRequest('', {
      expectedRevision: current.workspace.revision,
      draft: editor,
    });
    if (mounted.current) setAssistant(saved);
    return saved;
  }
  async function chat(message: string) {
    if (!editor || !fileId || !editable || !canEdit) return false;
    return run(async () => {
      const current = await syncCurrent();
      if (!mounted.current) return;
      const controller = new AbortController();
      chatController.current = controller;
      setChatProgress('正在核对当前到货草稿…');
      try {
        const active = aiStatus?.active;
        if (!active) throw Error('请先启用AI配置。');
        const state = await assistantRequest(
          '/chat',
          {
            message,
            expectedRevision: current.workspace.revision,
            requestId: crypto.randomUUID(),
            stream: true,
            profile: {
              id: active.id,
              endpoint: active.endpoint,
              model: active.model,
              apiStyle: active.apiStyle || 'chat-completions',
            },
          },
          (p) => {
            if (mounted.current)
              setChatProgress('到货助手处理中 · ' + (p.receivedChars || 0) + ' 字符');
          },
          controller.signal,
        );
        if (!controller.signal.aborted) acceptAssistant(state);
      } finally {
        chatController.current = null;
        if (mounted.current) setChatProgress('');
      }
    });
  }
  async function undoAssistant() {
    if (!assistant) return;
    await run(async () =>
      acceptAssistant(
        await assistantRequest('/undo', { expectedRevision: assistant.workspace.revision }),
      ),
    );
  }
  async function save() {
    if (!editor || !fileId || !canEdit) return;
    await run(async () => {
      await syncCurrent();
      if (issues.length) {
        setNotice('核对草稿已保存，仍有待完善字段；尚未建立到货业务单据或改变库存。');
        return;
      }
      const saved =
        auth?.actor?.developerMode && editor.id && (doc?.status !== 'draft' || doc?.archived)
          ? (
              await managementRequest<any>('/developer/execute', {
                requestId: saveRequest.current,
                module: 'arrival',
                action: 'update',
                items: [{ id: editor.id, version: doc.version }],
                patch: editor,
                reason: '开发者修正到货草稿',
              })
            ).results[0]
          : await managementRequest<any>(
              '/flow/' + (editor.id || 'arrival'),
              { ...editor, requestId: saveRequest.current },
              editor.id ? 'PUT' : 'POST',
            );
      await linkArrival(fileId, saved.id, saved.sourceId || source?.id || null);
      if (!mounted.current) return;
      setDoc(saved);
      setEditor(structuredClone(saved));
      setBaseline(reviewValue(saved));
      saveRequest.current = crypto.randomUUID();
      setNotice('到货草稿已保存，核对确认后才增加原材料库存。');
      window.dispatchEvent(new Event('erp-business-changed'));
      await refresh();
    });
  }
  async function review() {
    if (!doc || dirty || !canEdit) return;
    await run(async () => {
      const result = await managementRequest<any>('/flow/' + doc.id + '/preview', {});
      if (mounted.current) setPreview({ ...result, requestId: crypto.randomUUID() });
    });
  }
  async function confirm() {
    if (!preview || !fileId) return;
    await run(async () => {
      const result = await managementRequest<any>('/flow/' + preview.document.id + '/confirm', {
        previewId: preview.previewId,
        requestId: preview.requestId,
        acknowledged: true,
      });
      if (!mounted.current) return;
      setPreview(null);
      setDoc(result);
      setEditor(structuredClone(result));
      setBaseline(reviewValue(result));
      setNotice('已确认实收，原材料库存与入库流水已保存；没有创建销售订单或成品库存。');
      window.dispatchEvent(new Event('erp-business-changed'));
      await refresh();
    });
  }
  return (
    <>
      <section className="oi-draft oi-arrival-draft">
        <DraftHeader title={'到货单草稿' + (workspace ? ' · ' + workspace.fileName : '')}>
          {confirmed && (
            <span className="oi-reviewed">
              <CheckCircle2 size={13} />
              已入库
            </span>
          )}
          {!confirmed && editor && (
            <span className="sub">{dirty ? '待保存到货记录' : '已保存 · 待核对'}</span>
          )}
          {workspace && editable && (
            <button
              className={!editor ? 'primary' : ''}
              disabled={busy || loading || !canEdit}
              onClick={() => void recognize()}
            >
              {busy ? <LoaderCircle size={14} className="spin" /> : <FileText size={14} />}
              {busy ? '正在处理…' : editor ? '重新识别' : '识别到货单'}
            </button>
          )}
          {workspace && <small>修订 {workspace.revision}</small>}
        </DraftHeader>
        {error && <DraftNotice error>{error}</DraftNotice>}
        {source?.lastError && source?.result && (
          <DraftNotice>
            最近一次重新识别未成功，当前保留并显示上一次完整结果，请核对后再使用。
          </DraftNotice>
        )}
        {!canEdit && auth && (
          <DraftNotice>请使用有业务编辑权限的账号进行到货识别和入库。</DraftNotice>
        )}
        {warnings.length > 0 && (
          <details className="oi-standard-check">
            <summary>原件识别待核对 {warnings.length} 项</summary>
            {[...new Set(warnings)].map((w) => (
              <p key={w}>{w}</p>
            ))}
          </details>
        )}
        {issues.length > 0 && (
          <details className="oi-standard-check">
            <summary>草稿仍需完善 {issues.length} 项</summary>
            {issues.map((w) => (
              <p key={w}>{w}</p>
            ))}
          </details>
        )}
        <div className="oi-draft-content">
          {assistant?.changes?.length > 0 && (
            <details className="oi-arrival-changes">
              <summary>
                本次助手修改 {assistant.changes.length} 项{' '}
                <small>{assistant.changes.map((c: any) => c.field).join('、')}</small>
              </summary>
              {assistant.changes.map((c: any, i: number) => (
                <p key={i}>
                  <strong>{c.field}</strong>
                  <del>{String(c.before ?? '未填写')}</del>
                  <span>→</span>
                  <ins>{String(c.after ?? '未填写')}</ins>
                </p>
              ))}
            </details>
          )}
          {editor ? (
            <ArrivalDraftForm
              value={editor}
              data={data}
              locked={busy || loading || !canEdit || !editable}
              change={change}
            />
          ) : (
            <div className="oi-empty">
              <FileText size={30} />
              <p>
                {loading
                  ? '正在读取已保存的到货草稿…'
                  : workspace
                    ? '等待识别供应商到货单'
                    : '选择左侧文件开始'}
              </p>
              <span>供应商、纸板、面积和采购关联独立核对；识别和保存草稿不改变库存。</span>
            </div>
          )}
        </div>
        {editor && (
          <div className="oi-draft-bottom">
            <div className="oi-order-totals">
              <span>
                实收 <b>{totals?.quantity || '待确认'} 张</b>
              </span>
              <span>
                计算面积 <strong>{totals?.area} m²</strong>
              </span>
              <small>
                {totals?.unknownArea
                  ? totals.unknownArea + ' 行面积待确认，未计入'
                  : '根据尺寸计算；保留原单面积供核对'}
              </small>
            </div>
            <div className="oi-draft-actions">
              <button
                disabled={busy || loading || !dirty || !editable || !canEdit}
                onClick={() => void save()}
              >
                <Save size={14} />
                保存修改
              </button>
              {assistant?.canUndo && editable && (
                <button disabled={busy || !canEdit} onClick={() => void undoAssistant()}>
                  撤销助手修改
                </button>
              )}
              {dirty && doc && (
                <button
                  disabled={busy}
                  onClick={() => {
                    setEditor(structuredClone(doc));
                    setPreview(null);
                  }}
                >
                  撤销未保存修改
                </button>
              )}
              <small>{source?.fileName || workspace?.fileName} · 原件已保留</small>
            </div>
          </div>
        )}
      </section>
      <DraftChat
        identity={fileId || undefined}
        ready={!!editor && !!source?.result}
        messages={assistant?.messages || []}
        title="到货单助手"
        emptyText="识别到货单后，可核对张数、面积、匹配供应商与原材料档案。"
        placeholder="例如：第二项实收改成500张；查询并匹配供应商"
        locked={busy || loading || !canEdit || !editable}
        lockedLabel={confirmed ? '已入库' : !canEdit ? '需登录' : !editable ? '只读' : '处理中'}
        unsaved={false}
        send={chat}
      />
      {chatProgress && (
        <div className="oi-arrival-chat-status" role="status">
          {chatProgress}
        </div>
      )}
      <footer className="oi-review-bar oi-arrival-review">
        <div>
          <ShieldCheck size={15} />
          <span>
            {confirmed
              ? '已确认入库 · ' + doc.number
              : dirty
                ? '核对草稿待保存为到货记录'
                : doc
                  ? '当前到货草稿已保存，待人工核对'
                  : '识别后核对到货信息'}
          </span>
        </div>
        <div>
          {doc && <a href={'#arrivals?doc=' + doc.id}>查看到货记录</a>}
          {editable && (
            <button
              className="primary"
              disabled={busy || loading || !doc || dirty || issues.length > 0 || !canEdit}
              onClick={() => void review()}
            >
              核对并确认入库
            </button>
          )}
        </div>
      </footer>
      {preview && (
        <ManagementDialog title="确认实际到货并入库" close={() => setPreview(null)} busy={busy}>
          <div className="arrival-import-preview">
            <h3>
              {data.suppliers.find((s: any) => s.id === preview.document.supplierId)?.name ||
                preview.document.supplierName}{' '}
              · {preview.document.reference}
            </h3>
            <p>到货日期 {preview.document.date} · 只增加原材料库存，保存本次入库流水。</p>
            <div className="table-wrap">
              <table className="flow-table">
                <thead>
                  <tr>
                    <th>纸板 / 规格</th>
                    <th>实收数量</th>
                    <th>计算面积</th>
                    <th>采购 / 入库档案</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.lines.map((l: any, i: number) => (
                    <tr key={i}>
                      <td>
                        {l.item.name}
                        <small>{l.item.specification}</small>
                      </td>
                      <td>{l.quantity} 张</td>
                      <td>{l.area ?? '未知'} m²</td>
                      <td>
                        {l.purchaseNumber || '独立收货'}
                        <small>{l.stockId ? '已有档案 #' + l.stockId : '新建独立原材料档案'}</small>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {preview.warnings.map((w: string) => (
              <p className="flow-warning" key={w}>
                {w}
              </p>
            ))}
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <div className="modal-actions">
              <button disabled={busy} onClick={() => setPreview(null)}>
                返回修改
              </button>
              <button className="primary" disabled={busy} onClick={() => void confirm()}>
                {busy ? '正在提交…' : '确认实收并入库'}
              </button>
            </div>
          </div>
        </ManagementDialog>
      )}
    </>
  );
}
