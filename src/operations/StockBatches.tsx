import { useState, type ReactNode } from 'react';
import { FormMessage, Hint, Loading, Section, StatusChip } from '../ui/index';
import { canEditBusiness, emit, notify, useAuthState, useLoad } from '../ui/index';
import type { StockBatchView, StockItemView } from '../../shared/business/index';
import { readStockBatches } from '../flow/flow-api';
import { infoSavedMessage } from '../flow/flow-words';
import DocumentInfoDialog from '../flow/DocumentInfoDialog';

/** 批次块下面的一行：标题和内容 */
type BlockRow = { label: string; value: ReactNode; className?: string };

/** 订单和客户：单号不拆开；客户名放不下时整个换到下一行，不和单号挤在一起断 */
function BatchOrders({ orders }: { orders: StockBatchView['orders'] }) {
  return (
    <ul className="pur-batch-list">
      {orders.map((o) => (
        <li key={o.id} className="pur-batch-order">
          <a href={'#orders?order=' + o.id}>{o.number}</a> <span>{o.customerName}</span>
        </li>
      ))}
    </ul>
  );
}

/** 用料：纸板名称、用量，材质、楞型有才写 */
function BatchMaterials({ materials }: { materials: StockBatchView['materials'] }) {
  return (
    <ul className="pur-batch-list">
      {materials.map((m) => {
        const quality = [m.material && '材质 ' + m.material, m.flute && '楞型 ' + m.flute]
          .filter(Boolean)
          .join(' · ');
        return (
          <li key={m.stockId}>
            <span className="pur-batch-material">
              {m.name} · <span className="pur-batch-qty">{m.quantity} 张</span>
            </span>
            {quality && <small>{quality}</small>}
          </li>
        );
      })}
    </ul>
  );
}

/** 批次备注：写了的备注，能写的再加“写备注 / 编辑备注” */
function BatchNote({ batch, edit }: { batch: StockBatchView; edit?: () => void }) {
  const hasNotes = !!batch.notes.trim();
  return (
    <>
      {hasNotes && <span className="pur-batch-notes-text">{batch.notes}</span>}
      {edit && (
        <button
          type="button"
          className="text-link pur-batch-note-edit"
          aria-label={(hasNotes ? '编辑备注' : '写备注') + ' · 完工单 ' + batch.number}
          onClick={edit}
        >
          {hasNotes ? '编辑备注' : '写备注'}
        </button>
      )}
    </>
  );
}

/** 批次块下面只列有内容的几行：生产任务、订单和客户、用料、原因（其他入库）、操作人、批次备注 */
function blockRows(batch: StockBatchView, edit?: () => void): BlockRow[] {
  const rows: BlockRow[] = [];
  if (batch.taskId)
    rows.push({
      label: '生产任务',
      value: <a href={'#production?doc=' + batch.taskId}>{batch.taskNumber}</a>,
    });
  if (batch.orders.length) rows.push({ label: '订单', value: <BatchOrders orders={batch.orders} /> });
  if (batch.materials.length)
    rows.push({ label: '用料', value: <BatchMaterials materials={batch.materials} /> });
  // 其他入库说清来由：那笔流水的备注（出入库窗口里填的用途、盘点原因）
  if (batch.kind === 'other' && batch.reason)
    rows.push({ label: '原因', value: batch.reason, className: 'pur-batch-notes' });
  if (batch.operator) rows.push({ label: '操作人', value: batch.operator });
  if (batch.notes.trim() || edit)
    rows.push({ label: '批次备注', value: <BatchNote batch={batch} edit={edit} />, className: 'pur-batch-notes' });
  return rows;
}

/** 批次块的头部：第一行日期、完工或其他入库的类型、完工单号；第二行入库多少、估计还剩多少 */
function BatchHeader({ batch, unit }: { batch: StockBatchView; unit: string }) {
  const left = batch.remainingUnits > 0,
    other = batch.kind === 'other';
  return (
    <header>
      <div className="pur-batch-title">
        <strong className="pur-batch-date">{batch.date}</strong>
        <span className="pur-batch-kind">{other ? batch.label : '完工'}</span>
        {batch.documentId && (
          <>
            <span className="pur-batch-dot" aria-hidden="true">
              ·
            </span>
            <a className="pur-batch-number" href={'#production?view=production&doc=' + batch.documentId}>
              {batch.number}
            </a>
          </>
        )}
      </div>
      <div className="pur-batch-amount">
        <span>
          入库 {batch.inQuantity} {unit}
        </span>
        <span className="pur-batch-dot" aria-hidden="true">
          ·
        </span>
        {left ? (
          <StatusChip tone={other ? 'neutral' : 'accent'}>
            估计还剩 {batch.remaining} {unit}
          </StatusChip>
        ) : (
          <StatusChip tone="neutral">估计已发完</StatusChip>
        )}
      </div>
    </header>
  );
}

/**
 * 成品库存详情里的“批次”（调用处按库存品 key 重新挂载，换库存品时状态从头来）：每次完工入库算一批，一批一块上下排开（不用多列表格，右侧面板和手机宽度都不横向滚动）。
 * 还剩多少是服务端按流水推算的（shared/business/stock-batches.ts），这里只显示。估计已发完的默认收起（剩余是推算的，叫法和“估计还剩”一致）。
 * 完工批次的备注事后能补写、修改（质量好坏常常是入库以后才发现）：有编辑权限的账号在“批次备注”一行看到“写备注 / 编辑备注”，
 * 点开完工单的“编辑”小窗口（和完工详情同一个），只改批次备注、操作人，不动库存。“其他入库”没有完工单，没有这个入口。
 * 每批一块，头部两行就能看清：第一行“日期 完工 · 完工单号”（同一天的两批靠单号区分），第二行“入库 N 只 · 估计还剩 N 只”；
 * 下面只列有内容的几行：生产任务、订单和客户、用料、操作人、批次备注。
 * 完工批次在前；手工入库、盘点盘盈这些“其他入库”另起一组、有小标题，块是白底细边、标签中性色，和完工批次分得开。
 * 估计已发完的收起，展开后底色更浅、文字次要色，一眼看得出是旧的。
 * 估计还剩的标签跟在头部文字后面，不推到最右边：右下角悬浮的小甬小勒会盖住面板最右侧。
 */
function BatchBlock({
  batch,
  unit,
  editNote,
}: {
  batch: StockBatchView;
  unit: string;
  editNote?: (batch: StockBatchView) => void;
}) {
  const left = batch.remainingUnits > 0,
    other = batch.kind === 'other';
  // 只有完工批次（有完工单）能写备注
  const edit = editNote && !other && batch.documentId ? () => editNote(batch) : undefined;
  const rows = blockRows(batch, edit);
  return (
    <li className={'pur-batch' + (left ? '' : ' is-depleted') + (other ? ' is-other' : '')}>
      <BatchHeader batch={batch} unit={unit} />
      {rows.length > 0 && (
        <dl>
          {rows.map((r) => (
            <div key={r.label} className={r.className}>
              <dt>{r.label}</dt>
              <dd>{r.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </li>
  );
}

/** 一组批次：完工批次在前；其他入库另起一组，带小标题“其他入库”（服务端已经按完工批次在前排好） */
function BatchGroups({
  list,
  unit,
  editNote,
}: {
  list: StockBatchView[];
  unit: string;
  editNote?: (batch: StockBatchView) => void;
}) {
  const made = list.filter((b) => b.kind === 'batch'),
    others = list.filter((b) => b.kind === 'other');
  return (
    <>
      {made.length > 0 && (
        <ul className="pur-batches">
          {made.map((b) => (
            <BatchBlock key={b.key} batch={b} unit={unit} editNote={editNote} />
          ))}
        </ul>
      )}
      {others.length > 0 && (
        <>
          <h4 className="pur-batches-group">其他入库</h4>
          <ul className="pur-batches is-other">
            {others.map((b) => (
              <BatchBlock key={b.key} batch={b} unit={unit} />
            ))}
          </ul>
        </>
      )}
    </>
  );
}

/** 库存品的数量、版本变了（出入库、改档案）就重读批次 */
type BatchesOf = Pick<StockItemView, 'id' | 'version' | 'quantity' | 'unit'>;

export default function StockBatches({ row }: { row: BatchesOf }) {
  const auth = useAuthState(),
    editNote = canEditBusiness(auth) ? (b: StockBatchView) => setEditing(b) : undefined;
  const [all, setAll] = useState(false),
    [editing, setEditing] = useState<StockBatchView | null>(null);
  const loaded = useLoad([row.id, row.version, row.quantity, all].join('|'), () =>
    readStockBatches(row.id, all),
  );
  const { data, error } = loaded;
  const unit = data?.unit || row.unit;
  return (
    <Section title="批次">
      <p className="pur-batch-note">
        每次完工入库算一批。剩余是推算的：先发给对应订单，其余先做先发。
      </p>
      {error ? (
        <FormMessage>{error}</FormMessage>
      ) : !data ? (
        <Loading />
      ) : (
        <>
          {data.unmatchedUnits !== 0 && (
            <Hint tone="warning">
              {data.unmatchedUnits > 0
                ? '有 ' +
                  data.unmatched +
                  ' ' +
                  unit +
                  '对不上批次：实际库存比各批估计剩余加起来多。'
                : '有 ' +
                  data.unmatched +
                  ' ' +
                  unit +
                  '对不上批次：各批估计剩余加起来比实际库存多。'}
              请到库存流水里核对。
            </Hint>
          )}
          {!data.open.length && !data.depletedTotal ? (
            <p className="pur-empty">还没有完工入库。登记完工后，每次完工会在这里单独列一批。</p>
          ) : !data.open.length ? (
            <p className="pur-empty">现在没有还有货的批次。</p>
          ) : (
            <BatchGroups list={data.open} unit={unit} editNote={editNote} />
          )}
          {data.depletedTotal > 0 && (
            <details className="pur-batches-done">
              <summary>估计已发完的 {data.depletedTotal} 批</summary>
              <BatchGroups list={data.depleted} unit={unit} editNote={editNote} />
              {data.depleted.length < data.depletedTotal && (
                <button type="button" className="pur-batches-all" onClick={() => setAll(true)}>
                  显示全部 {data.depletedTotal} 批（现在列出最近 {data.depleted.length} 批）
                </button>
              )}
            </details>
          )}
        </>
      )}
      {/* 写备注的只有完工批次（有完工单）；其他入库没有单据，不出窗口 */}
      {editing && editing.documentId !== null && editing.number !== null && editing.documentVersion !== null && (
        <DocumentInfoDialog
          doc={{
            id: editing.documentId,
            kind: 'production',
            number: editing.number,
            version: editing.documentVersion,
            date: editing.date,
            notes: editing.notes,
            operator: editing.operator,
          }}
          close={() => setEditing(null)}
          saved={(r) => {
            setEditing(null);
            loaded.reload();
            emit('erp-business-changed');
            notify(infoSavedMessage('production', r));
          }}
        />
      )}
    </Section>
  );
}

