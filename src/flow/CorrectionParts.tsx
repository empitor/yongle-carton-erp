import type { ReactNode } from 'react';
import { Plus } from 'lucide-react';

/* 到货、送货、完工三个更正窗共用的小件：“改成多少”那张表、正确数量那一格、加一行的按钮。 */

/** “改成多少”那张表：第一列是什么、现在、正确数量，后面是这种单据多的几列（extra）；表身是各自的行 */
export function CorrectionTable({ first, extra, children }: { first: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <div className="line-table wh-no-action wh-compact">
      <table>
        <thead>
          <tr>
            <th>{first}</th>
            <th className="num">现在</th>
            <th className="num">正确数量</th>
            {extra}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/** 正确数量那一格：输入框后面跟单位 */
export function CorrectQuantity(o: { label: string; value: string; unit: string; busy: boolean; change: (value: string) => void }) {
  return (
    <td className="num wh-wide">
      <div className="wh-qty">
        <input aria-label={o.label} inputMode="decimal" value={o.value} disabled={o.busy} onChange={(e) => o.change(e.currentTarget.value)} />
        <span>{o.unit}</span>
      </div>
    </td>
  );
}

/** 加一行（一种纸板）的按钮，放在那一栏标题右边（完工单编辑窗的领料也用它） */
export function AddRow({ busy, add, children }: { busy: boolean; add: () => void; children: ReactNode }) {
  return (
    <button type="button" className="secondary" disabled={busy} onClick={add}>
      <Plus size={14} aria-hidden="true" />
      {children}
    </button>
  );
}
