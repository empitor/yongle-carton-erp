import { useEffect, useRef, useState } from 'react';
import { Save, ShieldCheck, Undo2 } from 'lucide-react';
import type { ImportWorkspaceView as Workspace } from '../../shared/import/index';
import { ConfirmDialog, loadingText } from '../ui/index';
import { CorrectionDialog, FlowEditor, FlowReviewDialog } from '../flow/index';
import { DraftEmpty, DraftFooter, DraftNotice, Figure } from './DraftUI';
import { SEND_NOTE } from './ImportDialog';
import ReviewIssues from './ReviewIssues';
import { useArrivalDraft } from './useArrivalDraft';
import type { useOrderWorkspace } from './useOrderWorkspace';
import { fieldShort } from '../../shared/core/index';

const fieldset = { border: 0, padding: 0, margin: 0, minWidth: 0 };
type Arrival = ReturnType<typeof useArrivalDraft>;

/** 正文：出错和提醒、到货表单（还没识别时是一句下一步） */
function ArrivalBody({ a, workspace }: { a: Arrival; workspace: Workspace | undefined }) {
  const locked = a.busy || a.loading || !a.canEdit || !a.editable;
  return (
    <div className="aii-pane-body">
      {a.error && <DraftNotice error>{a.error}</DraftNotice>}
      {a.source?.lastError && a.source.result && (
        <DraftNotice>最近一次重新识别没有成功，下面仍是上一次完整的结果，请核对后再用。</DraftNotice>
      )}
      {!a.canEdit && a.authKnown && <DraftNotice>请使用有业务编辑权限的账号进行到货识别和入库。</DraftNotice>}
      {a.editor ? (
        <fieldset style={fieldset} disabled={locked} aria-label="到货单">
          <FlowEditor kind="arrival" value={a.editor} data={a.data} change={a.change} />
        </fieldset>
      ) : (
        <DraftEmpty title={a.loading ? loadingText('已保存的识别结果') : workspace ? '还没有识别' : '先选一份文件'}>
          {workspace && !a.loading
            ? '点右上角“开始识别”。资料齐的直接登记成待入库的到货单，核对入库时才加库存。' + SEND_NOTE
            : ''}
        </DraftEmpty>
      )}
    </div>
  );
}

/** 底栏左边：实到、面积、没保存的提示、要补的项和提醒 */
function ArrivalSummary({ a, confirmed }: { a: Arrival; confirmed: boolean }) {
  return (
    <>
      <Figure label={fieldShort('quantity', { record: 'arrival', parent: 'lines' })}>{(a.totals?.quantity || '待确认') + ' 张'}</Figure>
      <Figure label="面积">{a.totals?.area + ' m²'}</Figure>
      {!!a.totals?.unknownArea && <small>{a.totals.unknownArea} 行面积待确认，未计入</small>}
      {!confirmed && a.dirty && <small>{a.doc ? '有未保存的修改' : '还没登记成到货单'}</small>}
      <ReviewIssues
        issues={a.issues.map((message) => ({ path: 'draft', message, severity: 'error' }))}
        warnings={a.warnings}
        changes={[]}
      />
    </>
  );
}

/** 主按钮：已入库的链到仓库里的这张到货单，能改的给“核对入库” */
function ArrivalPrimary({ a }: { a: Arrival }) {
  if (a.doc?.status === 'confirmed')
    return (
      <a className="aii-done-link" href={'#warehouse?arrivals=1&doc=' + a.doc.id}>
        <ShieldCheck size={14} />
        已入库 {a.doc.number}
      </a>
    );
  if (!a.editable) return null;
  return (
    <button
      className="primary"
      disabled={a.busy || a.loading || a.issues.length > 0 || !a.canEdit}
      title={a.issues.length ? '还有 ' + a.issues.length + ' 项要补，补完才能入库' : undefined}
      onClick={() => void a.confirmArrival()}
    >
      核对入库
    </button>
  );
}

/** 底栏：让 AI 改 · 撤回修改 · 保存 · 更正到货单 · 主按钮 */
function ArrivalFooter({ a, askAssistant, correct }: { a: Arrival; askAssistant: () => void; correct: () => void }) {
  const confirmed = a.doc?.status === 'confirmed',
    discardable = a.dirty && !!a.doc;
  return (
    <DraftFooter moreLabel="到货识别更多操作" summary={<ArrivalSummary a={a} confirmed={confirmed} />}>
      <button
        className="aii-ai-button"
        title={a.doc ? '打开助手，说要改这张到货单的哪里' : '先保存登记成到货单，再让助手改'}
        disabled={a.busy || !a.doc || a.dirty}
        onClick={askAssistant}
      >
        让 AI 改
      </button>
      {!confirmed && discardable && (
        <button className="secondary" disabled={a.busy || !a.canEdit} title="放弃还没保存的修改" onClick={a.discard}>
          <Undo2 size={14} />
          撤回修改
        </button>
      )}
      {!confirmed && a.editable && a.dirty && (
        <button className="secondary" disabled={a.busy || a.loading || !a.canEdit} onClick={() => void a.save()}>
          <Save size={14} />
          保存
        </button>
      )}
      {/* 已入库的改数量、单价走“更正到货单”（本机管理员也一样），不在这里直接改 */}
      {confirmed && a.canEdit && (
        <button className="secondary" disabled={a.busy} onClick={correct}>
          更正到货单
        </button>
      )}
      <ArrivalPrimary a={a} />
    </DraftFooter>
  );
}

/**
 * 到货单类型的识别结果：用单据流转的到货表单核对、选挂哪份订货单（到货的编辑只有这一套），
 * 底栏（让 AI 改 · 撤回修改 · 保存 · 核对入库）和单据页同一个核对入库窗。数据和动作在 useArrivalDraft。
 * recognizeSignal 变了就开始识别（页头“开始识别 / 重新识别”）。
 */
export default function ArrivalDraftPanel({
  api,
  workspace,
  recognizeSignal,
}: {
  api: ReturnType<typeof useOrderWorkspace>;
  workspace: Workspace | undefined;
  recognizeSignal: number;
}) {
  const a = useArrivalDraft(api, workspace);
  const [asking, setAsking] = useState(false),
    [correcting, setCorrecting] = useState(false);
  /** 开始识别；已有识别结果或改过的，先问一句会覆盖。 */
  const start = () => {
    if (!a.canRecognize()) return;
    if (a.source?.result || a.editor) setAsking(true);
    else void a.recognize();
  };
  // 只在页头点了“开始识别”（recognizeSignal 变了）时开始；start 每次渲染都是新函数，放进 ref 取最新的
  const latestStart = useRef(start);
  useEffect(() => {
    latestStart.current = start;
  });
  const seen = useRef(recognizeSignal);
  useEffect(() => {
    if (recognizeSignal === seen.current) return;
    seen.current = recognizeSignal;
    latestStart.current();
  }, [recognizeSignal]);
  return (
    <>
      <ArrivalBody a={a} workspace={workspace} />
      {a.editor && workspace && (
        <ArrivalFooter a={a} askAssistant={() => api.askAssistant(workspace.id)} correct={() => setCorrecting(true)} />
      )}
      {asking && (
        <ConfirmDialog
          title="重新识别这张到货单？"
          size="md"
          confirmLabel="重新识别"
          close={() => setAsking(false)}
          onConfirm={() => {
            setAsking(false);
            void a.recognize();
          }}
        >
          <p className="aii-confirm-text">
            会用新的识别结果改写{a.doc ? '这张待入库的到货单' : '当前识别结果'}
            {a.dirty ? '，还没保存的修改会丢掉' : ''}。{SEND_NOTE}
          </p>
        </ConfirmDialog>
      )}
      {correcting && a.doc && (
        <CorrectionDialog
          id={a.doc.id}
          kind="arrival"
          close={() => setCorrecting(false)}
          done={(result) => {
            setCorrecting(false);
            api.setNotice(result.summary);
          }}
        />
      )}
      {a.preview && (
        <FlowReviewDialog
          kind="arrival"
          preview={a.preview}
          data={a.data}
          ready
          busy={a.busy}
          error={a.error}
          close={a.closePreview}
          confirm={() => void a.confirm()}
        />
      )}
    </>
  );
}
