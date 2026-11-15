import type { PurchaseView } from '../../shared/business/index';
import { businessStatusTone } from '../recordkit/record-meta';
import { StatusChip } from '../ui/index';

/** 采购单的一条到货记录（一张到货单）：挂在这张采购单上的行、更正关系、原件 */
type Receipt = PurchaseView['receipts'][number];
type Props = {
  /** 采购单：列它的全部到货记录 */
  row: Pick<PurchaseView, 'receipts'>;
  /** 只列碰到这一行采购明细的 */
  lineId?: number;
  /** 有效的到货记录“更正到货单”（没有时只给“查看单据”） */
  correct?: (receipt: Receipt) => void;
};

/** 状态叫法：和到货单本身同一套——已入库 / 已更正 / 已撤销 / 待入库 / 已取消 */
const receiptStatus = (r: Receipt) =>
  r.effective ? '已入库' : r.replacedBy ? '已更正' : r.reversed ? '已撤销' : r.status === 'draft' ? '待入库' : '已取消';

/** 这条到货记录的更正链：原始到货、各次更正，按先后排 */
function correctionChain(receipts: readonly Receipt[], record: Receipt) {
  const ids = new Set<string | null>([record.id]);
  for (let i = 0; i < receipts.length; i++)
    for (const r of receipts)
      if (ids.has(r.id) || ids.has(r.correctionOf) || ids.has(r.replacedBy)) {
        ids.add(r.id);
        if (r.correctionOf) ids.add(r.correctionOf);
        if (r.replacedBy) ids.add(r.replacedBy);
      }
  return receipts.filter((r) => ids.has(r.id)).reverse();
}

/** 一条到货记录登记的各行：纸板和数量 */
const lineText = (l: Receipt['items'][number]) => l.item.name + '：' + l.quantity + ' ' + l.item.unit;

/** 更正状态、原因、原始与更正历史、原件 */
function ReceiptState({ r, receipts }: { r: Receipt; receipts: readonly Receipt[] }) {
  const text = receiptStatus(r);
  return (
    <>
      <StatusChip tone={businessStatusTone(text)}>{text}</StatusChip>
      {r.effective && r.correctionOf && <span className="sub">更正后的数量</span>}
      {r.reason && <span className="sub">原因：{r.reason}</span>}
      {(r.correctionOf || r.replacedBy) && (
        <details>
          <summary>查看原始与更正历史</summary>
          <ol>
            {correctionChain(receipts, r).map((event) => (
              <li key={event.id}>
                {event.correctionOf ? '更正到货' : '原始到货'} · {event.date} · {event.effective ? '当前有效' : '已被更正'}
                {event.items.map((l) => (
                  <span className="sub" key={l.index}>
                    {lineText(l)}
                  </span>
                ))}
                {event.reason && <span className="sub">原因：{event.reason}</span>}
              </li>
            ))}
          </ol>
        </details>
      )}
      {r.sourceId && (
        <a className="sub" href={'/api/flow/sources/' + r.sourceId + '/file'} target="_blank" rel="noreferrer">
          查看原始文件
        </a>
      )}
    </>
  );
}

export function ReceiptHistory({ row, lineId, correct }: Props) {
  const all = row.receipts;
  const receipts = all.filter((r) => lineId === undefined || r.items.some((l) => l.lineId === lineId));
  return (
    <div className="table-wrap receipt-history">
      <table>
        <thead>
          <tr>
            {['到货日期 / 单号或批次', '本次登记数量', '更正状态 / 关联历史', '操作'].map((t) => (
              <th key={t}>{t}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {receipts.map((r) => (
            <tr key={r.id}>
              <td>
                <strong>{r.reference}</strong>
                <span className="sub">
                  {r.date} · {r.actorName}
                </span>
              </td>
              <td>
                {r.items
                  .filter((l) => lineId === undefined || l.lineId === lineId)
                  .map((l) => (
                    <div key={l.index}>{lineText(l)}</div>
                  ))}
              </td>
              <td>
                <ReceiptState r={r} receipts={all} />
              </td>
              <td>
                {r.effective && correct ? (
                  <button onClick={() => correct(r)}>更正到货单</button>
                ) : (
                  <a href={'#warehouse?arrivals=1&doc=' + r.flowId}>查看单据</a>
                )}
              </td>
            </tr>
          ))}
          {!receipts.length && (
            <tr>
              <td colSpan={4}>暂无到货记录</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
