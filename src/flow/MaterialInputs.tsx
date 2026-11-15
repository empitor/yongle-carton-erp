import { specLine } from '../../shared/business/index';
import { RAW_UNIT } from '../../shared/core/index';
import { Combobox, RowDelete } from '../ui/index';
import type { CatalogLists } from '../recordkit/catalog-api';

/** 领料的一行：哪种纸板（还没选是 null）、领用、退料 */
export type MaterialInput = { stockId: number | null; issued: string; returned: string };
/** 可选的纸板：原材料库存品 */
export type RawStock = Pick<CatalogLists['items'][number], 'id' | 'name' | 'quantity'> & Parameters<typeof specLine>[0];

/**
 * 完工单的领料表（编辑待入库的完工单、更正完工单共用）：每种纸板选库存品、填领用和退料，至少留一行。
 * busy 时输入框和移除按钮都点不了（更正窗提交中）。
 */
export default function MaterialInputs({
  rows,
  raw,
  busy,
  patch,
  remove,
}: {
  rows: readonly MaterialInput[];
  raw: readonly RawStock[];
  busy?: boolean;
  patch: (i: number, value: Partial<MaterialInput>) => void;
  remove: (i: number) => void;
}) {
  return (
    <div className="line-table">
      <table>
        <thead>
          <tr>
            <th>纸板</th>
            <th className="num">{'领用（' + RAW_UNIT + '）'}</th>
            <th className="num">{'退料（' + RAW_UNIT + '）'}</th>
            <th aria-label="操作" />
          </tr>
        </thead>
        <tbody>
          {rows.map((m, i) => (
            <tr key={i}>
              <td>
                <Combobox
                  ariaLabel={'第 ' + (i + 1) + ' 种纸板'}
                  required
                  placeholder="选择纸板"
                  value={m.stockId ? String(m.stockId) : ''}
                  onChange={(id) => patch(i, { stockId: id ? Number(id) : null })}
                  options={raw.map((s) => ({
                    value: String(s.id),
                    label: [s.name, specLine(s)].filter(Boolean).join(' · '),
                    hint: '库存 ' + s.quantity + ' ' + RAW_UNIT,
                  }))}
                />
              </td>
              <td className="num">
                <input
                  aria-label={'第 ' + (i + 1) + ' 种纸板领用（' + RAW_UNIT + '）'}
                  inputMode="decimal"
                  value={m.issued}
                  disabled={busy}
                  onChange={(e) => patch(i, { issued: e.currentTarget.value })}
                />
              </td>
              <td className="num">
                <input
                  aria-label={'第 ' + (i + 1) + ' 种纸板退料（' + RAW_UNIT + '）'}
                  inputMode="decimal"
                  value={m.returned}
                  disabled={busy}
                  onChange={(e) => patch(i, { returned: e.currentTarget.value })}
                />
              </td>
              <td>
                <RowDelete label={'移除第 ' + (i + 1) + ' 种纸板'} disabled={busy || rows.length === 1} onClick={() => remove(i)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
