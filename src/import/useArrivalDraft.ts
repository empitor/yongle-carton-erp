import { useEffect, useRef, useState } from 'react';
import { emit, listen, useAuthState } from '../ui/index';
import { arrivalDraftIssues, arrivalTotals, type FlowDocView } from '../../shared/business/index';
import { errorMessage } from '../../shared/core/index';
import type { ArrivalSource, ImportWorkspaceView as Workspace } from '../../shared/import/index';
import { confirmedMessage, confirmPreview, previewFlow } from '../flow/index';
import {
  arrivalDoc,
  arrivalEditable,
  arrivalValue,
  reopenArrival,
  type ArrivalEditing,
} from './arrival-review';
import { readArrivalCatalog as loadCatalog, readArrivalDoc, readArrivalSource, type ArrivalCatalog } from './arrival-api';
import { recognizedEditing, storeArrival } from './arrival-store';
import { NO_KEY } from './ImportDialog';
import type { useOrderWorkspace } from './useOrderWorkspace';

type Api = ReturnType<typeof useOrderWorkspace>;
type Preview = Awaited<ReturnType<typeof previewFlow>>;
type Arrival = FlowDocView<'arrival'>;
const emptyCatalog: ArrivalCatalog = { suppliers: [], purchases: [], items: [], batches: [] };

/** 打开一份识别文件时读对照的档案、已登记的到货单和原件识别记录；业务数据变了重读档案 */
function useArrivalState(workspace: Workspace | undefined, actorId: string | undefined) {
  const [data, setData] = useState<ArrivalCatalog>(emptyCatalog),
    [editor, setEditor] = useState<ArrivalEditing | null>(null),
    [doc, setDoc] = useState<Arrival | null>(null),
    [source, setSource] = useState<ArrivalSource | null>(null),
    [warnings, setWarnings] = useState<string[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const docId = workspace?.arrivalDocId,
    sourceId = workspace?.arrivalSourceId;
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError('');
    Promise.all([
      loadCatalog(),
      docId ? readArrivalDoc(docId).then(arrivalDoc) : null,
      sourceId ? readArrivalSource(sourceId) : null,
    ])
      .then(([catalog, saved, original]) => {
        if (!live) return;
        setData(catalog);
        setSource(original);
        const recognized = original ? recognizedEditing(original, catalog, saved) : null;
        setWarnings(recognized?.warnings || []);
        setDoc(saved);
        setEditor(saved ? reopenArrival(saved) : recognized?.editing || null);
      })
      .catch((e: unknown) => {
        if (live) setError(errorMessage(e));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [workspace?.id, docId, sourceId, actorId]);
  useEffect(
    () =>
      listen('erp-business-changed', () => {
        void loadCatalog()
          .then(setData)
          .catch(() => {
            // 后台重读：没读到就留着眼前这份档案，下一次业务变化时再读
          });
      }),
    [],
  );
  return { data, editor, setEditor, doc, setDoc, source, setSource, warnings, setWarnings, loading, error, setError };
}

/** 一次只办一件事：办着的时候再点不办；没办成的原因记进 error；卸载以后不再改状态 */
function useRunner(setError: (message: string) => void) {
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true),
    pending = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function run(job: () => Promise<void>) {
    if (pending.current) return false;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await job();
      return true;
    } catch (e) {
      if (mounted.current) setError(errorMessage(e));
      return false;
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return { busy, run, mounted, pending };
}

/** 登记或改写到货单（待入库），返回登记好的到货单，页面换成它。已入库的不在这里改，用“更正到货单”。 */
function arrivalStorer(deps: {
  api: Api;
  s: ReturnType<typeof useArrivalState>;
  mounted: { current: boolean };
  requestId: { current: string };
}) {
  const { api, s, mounted, requestId } = deps;
  return async function store(value: ArrivalEditing, fileId: string) {
    const sourceId = s.source?.id ?? null,
      saved = await storeArrival(value, { link: api.linkArrival, fileId, sourceId, requestId });
    if (mounted.current) {
      s.setDoc(saved);
      s.setEditor(reopenArrival(saved));
    }
    emit('erp-business-changed');
    await api.refresh();
    return saved;
  };
}

/** 能不能开始识别；不能的话说为什么（空字符串是能） */
function recognizeBlocked(canEdit: boolean, editable: boolean, ai: Api['status']) {
  if (!canEdit) return '请使用有业务编辑权限的账号进行到货识别和入库。';
  if (!editable) return '这张到货单已经确认或只读，不能重新识别。';
  return ai?.ai.ready ? '' : ai?.ai.message || NO_KEY;
}

/**
 * 到货单类型的数据和动作。识别完资料齐的直接登记成待入库到货单，之后改的都是这张到货单本身；
 * 资料不齐（比如供应商、订货单没对上）先留在表单里，补齐了点“保存”再登记。挂了订货单的按订货单登记
 * （服务端按订货单分到各张采购单），选了“不挂采购单”的走单据流转的到货单接口。核对入库和单据页同一套办理
 * （src/flow 的 previewFlow、confirmPreview）。界面在 ArrivalDraftPanel。
 */
export function useArrivalDraft(api: Api, workspace: Workspace | undefined) {
  const auth = useAuthState(),
    canEdit = !!auth?.actor && (auth.actor.superAdminMode || auth.actor.permissions.includes('business:edit'));
  const fileId = workspace?.id;
  const s = useArrivalState(workspace, auth?.actor?.id);
  const { busy, run, mounted, pending } = useRunner(s.setError);
  const [preview, setPreview] = useState<Preview | null>(null);
  const saveRequest = useRef(crypto.randomUUID());
  const { data, editor, doc, source } = s;
  const batchOf = (v: ArrivalEditing) => data.batches.find((b) => b.id === v.orderBatchId);
  const editable = arrivalEditable(doc),
    dirty = !!editor && (!doc || arrivalValue(editor) !== arrivalValue(doc)),
    issues = editor ? arrivalDraftIssues(editor, batchOf(editor)) : [];
  const store = arrivalStorer({ api, s, mounted, requestId: saveRequest });
  /** 能不能开始识别；不能的话把原因写出来 */
  function canRecognize() {
    if (!fileId || pending.current) return false;
    const reason = recognizeBlocked(canEdit, editable, api.status);
    if (reason) s.setError(reason);
    return !reason;
  }
  /** 识别；资料齐的直接登记成待入库到货单（已经登记过的就改写这张） */
  const recognize = () =>
    run(async () => {
      if (!fileId) return;
      const result = await api.recognizeArrival(fileId, !!source?.result || !!editor);
      const next = result && recognizedEditing(result, data, doc);
      if (!result || !next)
        throw Error('到货识别没有完成，可以重试；失败原因在“更多 → 历史与归档 → 识别失败”里。');
      if (!mounted.current) return;
      s.setSource(result);
      s.setWarnings(next.warnings);
      setPreview(null);
      const draft: ArrivalEditing = doc ? { ...next.editing, id: doc.id, version: doc.version } : next.editing;
      if (arrivalDraftIssues(draft, batchOf(draft)).length) {
        s.setEditor(draft);
        api.setNotice('识别完了，还有要补的地方；补齐后点“保存”登记成待入库的到货单。');
        return;
      }
      await store(draft, fileId);
      api.setNotice('识别完了，已登记成待入库的到货单；核对入库时才加原材料库存。');
    });
  /** 保存：资料齐了登记成（或改写）待入库的到货单；还有要补的就说清楚，不保存 */
  async function save() {
    if (!editor || !fileId || !canEdit) return null;
    if (issues.length) {
      s.setError('还有 ' + issues.length + ' 项要补，补齐后才能登记：' + issues.slice(0, 3).join('；'));
      return null;
    }
    const registered: { doc: Arrival | null } = { doc: null };
    await run(async () => {
      registered.doc = await store(editor, fileId);
      api.setNotice('已登记到货，待入库；核对入库时才加原材料库存。');
    });
    return registered.doc;
  }
  const reviewing = arrivalReview({ api, s, run, mounted, canEdit, dirty, save, preview, setPreview });
  return {
    ...reviewing,
    /** 登录状态读到了没有（没读到时先不提示“需要业务编辑权限”） */
    authKnown: !!auth,
    canEdit,
    data,
    editor,
    doc,
    source,
    preview,
    warnings: s.warnings,
    busy,
    loading: s.loading,
    error: s.error,
    editable,
    dirty,
    issues,
    totals: editor ? arrivalTotals(editor.lines) : null,
    canRecognize,
    recognize,
    save,
  };
}

type ReviewDeps = {
  api: Api;
  s: ReturnType<typeof useArrivalState>;
  run: ReturnType<typeof useRunner>['run'];
  mounted: { current: boolean };
  canEdit: boolean;
  dirty: boolean;
  save: () => Promise<Arrival | null>;
  preview: Preview | null;
  setPreview: (preview: Preview | null) => void;
};
/** 核对入库：先看核对内容（有没保存的修改先登记），再按核对内容确认，和单据页同一套；表单改动、放弃修改也会关掉核对窗 */
function arrivalReview({ api, s, run, mounted, canEdit, dirty, save, preview, setPreview }: ReviewDeps) {
  const doc = s.doc;
  async function review(target: Arrival | null = doc) {
    if (!target || (target === doc && dirty) || !canEdit) return;
    await run(async () => {
      const result = await previewFlow(target.id);
      if (mounted.current) setPreview(result);
    });
  }
  /** 核对入库：有没保存的修改先登记，再打开入库核对窗。 */
  async function confirmArrival() {
    if (dirty || !doc) {
      const registered = await save();
      if (registered) await review(registered);
    } else await review();
  }
  const confirm = () =>
    preview &&
    run(async () => {
      // 核对时单据、库存被别人改了：核对窗换成最新的内容再提示，和单据页同一套
      const result = arrivalDoc(
        await confirmPreview(preview, (next) => {
          if (mounted.current) setPreview(next);
        }),
      );
      if (!mounted.current) return;
      setPreview(null);
      s.setDoc(result);
      s.setEditor(reopenArrival(result));
      api.setNotice(confirmedMessage('arrival'));
      emit('erp-business-changed');
      await api.refresh();
    });
  return {
    confirmArrival,
    confirm,
    /** 到货表单改了几项 */
    change: (patch: Partial<ArrivalEditing>) => {
      setPreview(null);
      s.setEditor((v) => (v ? { ...v, ...patch } : v));
    },
    /** 放弃没保存的修改，回到登记好的到货单 */
    discard: () => {
      s.setEditor(doc ? reopenArrival(doc) : null);
      setPreview(null);
    },
    closePreview: () => setPreview(null),
  };
}
