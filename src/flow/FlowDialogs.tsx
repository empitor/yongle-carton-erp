import { ManagementDialog, Loading } from '../ui/index';
import type { FlowPreview } from '../../shared/business/index';
import { quantityString, type FlowKind } from '../../shared/core/index';
import { EditorFooter, FormField, FormMessage, FormSection } from '../ui/index';
import { Hint, Section } from '../ui/index';
import type { CatalogLists } from '../recordkit/catalog-api';
import type { FlowUndoing } from './desk-windows';
import FlowDetails, { flowSubtitle } from './FlowDetails';
import { cancelLabel, undoLabel } from './flow-words';

/** 一笔库存变化（核对窗口算出来的） */
type StockChange = FlowPreview['changes'][number];

/** 没选库存品的到货行入到哪里：和实际入库同一个判断（服务端预览给出 target / sameNewAs） */
function newStockNote(c: StockChange) {
  if (c.target) return '入到已有的“' + c.target.name + '”' + (c.target.archived ? '（已归档，核对入库时自动恢复）' : '');
  return c.sameNewAs ? '和第 ' + c.sameNewAs + ' 行入同一个新建的库存品' : '核对入库时新建这个库存品';
}

/** 核对窗里“库存怎么变”的表：变动、现在库存、核对后 */
function StockChanges({ changes }: { changes: StockChange[] }) {
  return (
    <Section title="库存怎么变">
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>库存品</th>
              <th>原因</th>
              <th className="num">变动</th>
              <th className="num">现在库存</th>
              <th className="num">核对后</th>
            </tr>
          </thead>
          <tbody>
            {changes.map((c, i) => (
              <tr key={i}>
                <td>
                  {c.name}
                  {!c.stockId && <small>{newStockNote(c)}</small>}
                </td>
                <td>{c.reason}</td>
                <td className="num">
                  {c.deltaUnits > 0 ? '+' : '−'}
                  {quantityString(Math.abs(c.deltaUnits))} {c.unit}
                </td>
                <td className="num">{c.currentUnits == null ? '—' : quantityString(c.currentUnits) + ' ' + c.unit}</td>
                <td className="num">{c.afterUnits == null ? '—' : quantityString(c.afterUnits) + ' ' + c.unit}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

/** 确认前的核对窗：单据内容在上，库存怎么变在下，确认后同时生效。 */
export function FlowReviewDialog({
  kind,
  preview,
  data,
  ready,
  busy,
  error,
  close,
  confirm,
}: {
  kind: FlowKind;
  preview: FlowPreview;
  /** 对照的档案（显示名称、单号用）；AI 导入的到货单只读了到货要的几份 */
  data: Partial<CatalogLists>;
  ready: boolean;
  busy: boolean;
  error: string;
  close: () => void;
  confirm: () => void;
}) {
  const doc = preview.document;
  const delivery = kind === 'delivery';
  return (
    <ManagementDialog
      title={(delivery ? '不导出直接出库 · ' : '核对入库 · ') + doc.number}
      subtitle={flowSubtitle(doc, data)}
      size="lg"
      close={close}
      busy={busy}
      footer={
        <EditorFooter
          note="确认后单据和库存一起更新；弄错了可以在详情里撤销。"
        >
          <button className="secondary" disabled={busy} onClick={close}>
            取消
          </button>
          <button className="primary" disabled={busy} onClick={confirm}>
            {busy ? '正在确认…' : delivery ? '确认出库' : '确认入库'}
          </button>
        </EditorFooter>
      }
    >
      <FormMessage>{error}</FormMessage>
      {preview.warnings.map((w) => (
        <Hint key={w} tone="warning">
          {w}
        </Hint>
      ))}
      {ready ? (
        <FlowDetails doc={doc} data={data} />
      ) : (
        <Loading what="关联档案" />
      )}
      {preview.changes.length > 0 && <StockChanges changes={preview.changes} />}
      {preview.sourceHash && (
        <p className="flow-source-hash">送货单原件已保存（SHA-256 {preview.sourceHash.slice(0, 12)}…）</p>
      )}
    </ManagementDialog>
  );
}

/** 调整计划日期：只改排程，不登记实际生产或发货。 */
export function FlowScheduleDialog({
  doc,
  label,
  date,
  time,
  setDate,
  setTime,
  busy,
  error,
  close,
  save,
}: {
  doc: { number: string };
  /** 往来方或产品的名称（档案里查不到时没有） */
  label: string | undefined;
  date: string;
  time: string;
  setDate: (v: string) => void;
  setTime: (v: string) => void;
  busy: boolean;
  /** 保存没成功的原因（例如单据已被别人改过） */
  error?: string;
  close: () => void;
  save: () => void;
}) {
  return (
    <ManagementDialog
      title={'调整排程 · ' + doc.number}
      subtitle={label}
      size="sm"
      close={close}
      busy={busy}
      footer={
        <EditorFooter note="只改计划，不动实际业务和库存。">
          <button className="secondary" onClick={close} disabled={busy}>
            取消
          </button>
          <button className="primary" disabled={busy || !date} onClick={save}>
            保存排程
          </button>
        </EditorFooter>
      }
    >
      <FormMessage>{error}</FormMessage>
      <FormSection>
        <FormField label="计划日期" required>
          <input type="date" aria-label="新的计划日期" value={date} onChange={(e) => setDate(e.target.value)} />
        </FormField>
        <FormField label="计划时间" hint="选填">
          <input type="time" aria-label="新的计划时间" value={time} onChange={(e) => setTime(e.target.value)} />
        </FormField>
      </FormSection>
    </ManagementDialog>
  );
}

/** 确认窗里的单据：单号，完工单挂的生产任务 */
type UndoRow = { number: string; taskId?: number | null };

/** 撤销、取消之后会怎样：按单据种类说清库存和关联数量怎么变 */
function UndoHints({ type, kind, rows }: { type: FlowUndoing['type']; kind: FlowKind; rows: readonly UndoRow[] }) {
  if (type === 'reverse') {
    // 已生效的单据撤回，业务人员叫“撤销”，不用懂“冲销”
    if (kind === 'delivery')
      return (
        <Hint tone="warning">
          用于发错、发重：出库的数量加回库存，订单的已发数量减回。送货单保留，标“已撤销”，记下原因和操作人。
        </Hint>
      );
    if (kind === 'arrival')
      return (
        <Hint tone="warning">
          用于到货登记错了、登记重了：入库的数量从库存扣回，采购单的已到货数量减回。到货单保留，标“已撤销”。这批料已经领用掉、库存不够扣的撤销不了；供应商退货请用“采购退货”。
        </Hint>
      );
    return (
      <Hint tone="warning">
        {kind === 'production'
          ? '入库的成品从库存扣回，领的纸板加回库存；完工记录保留，标“已撤销”。成品已经送出去、库存不够扣的撤销不了。'
          : '单据保留，标“已撤销”，记下原因和操作人。'}
      </Hint>
    );
  }
  if (kind === 'task') return <Hint tone="info">已完工的部分和库存记录保留，只取消还没做的部分。</Hint>;
  if (kind === 'production')
    return (
      <Hint tone="info">
        这次完工还没核对入库：取消后成品不入库、领的纸板也不扣，库存不变；完工记录保留在列表里，标“已取消”
        {rows.some((r) => r.taskId) ? '，生产任务还差的数量跟着加回来。' : '。'}
      </Hint>
    );
  return null;
}

/** 取消、撤销的确认窗：说清楚影响哪些单据，要写原因。 */
export function FlowActionDialog({
  action,
  kind,
  reason,
  setReason,
  busy,
  close,
  perform,
  error,
}: {
  action: { type: FlowUndoing['type']; rows: readonly UndoRow[] };
  kind: FlowKind;
  reason: string;
  setReason: (v: string) => void;
  busy: boolean;
  close: () => void;
  perform: () => void;
  /** 提交失败的原因，显示在窗口里（比如库存已经被用掉、撤销不了） */
  error?: string;
}) {
  const title =
    action.type === 'reverse' ? undoLabel(kind) : action.rows.length === 1 ? cancelLabel({ kind }) : '取消';
  return (
    <ManagementDialog
      title={title + ' · ' + action.rows.map((r) => r.number).join('、')}
      subtitle={action.rows.length > 1 ? '共 ' + action.rows.length + ' 张单据' : undefined}
      size="md"
      close={close}
      busy={busy}
      danger
      footer={
        <EditorFooter>
          {/* 这一步本身就是“取消这次××”时，退出写“不取消”，免得两个“取消”挨着分不清 */}
          <button className="secondary" onClick={close} disabled={busy}>
            {action.type === 'cancel' ? '不取消' : '取消'}
          </button>
          <button className="danger-solid" onClick={perform} disabled={busy || !reason.trim()}>
            {busy ? '正在处理…' : title}
          </button>
        </EditorFooter>
      }
    >
      {error && <FormMessage>{error}</FormMessage>}
      <UndoHints type={action.type} kind={kind} rows={action.rows} />
      {/* 撤销、取消的确认窗不列关联记录（送货、完工、到货一个样）：这一步会怎样由上面的说明讲清，
          要看关联和历史从详情“更多”里的“关联记录与修改历史”打开 */}
      <FormSection columns={1}>
        <FormField label="原因" required span="full">
          <textarea aria-label="原因" value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} />
        </FormField>
      </FormSection>
    </ManagementDialog>
  );
}
