import { Plus } from 'lucide-react';
import { Combobox, FormSection, RowDelete } from '../ui/index';
import { FINISHED_UNIT } from '../../shared/core/index';
import type { CatalogLists } from '../recordkit/catalog-api';

export type UntaskedRow = { productId: number | null; good: string; scrap: string };

/**
 * 登记完工窗口里“不挂任务”的完工（打样、补做）：选产品、填合格和报废，和挂任务的一起登记、共用这批纸板。
 * 成品入这个产品的成品库存（一个产品一个成品库存）。
 */
export default function UntaskedCompletions({
  rows,
  products,
  change,
}: {
  rows: UntaskedRow[];
  /** 产品清单（归档的不列） */
  products: readonly Pick<CatalogLists['products'][number], 'id' | 'name' | 'archived'>[];
  change: (rows: UntaskedRow[]) => void;
}) {
  const patch = (i: number, value: Partial<UntaskedRow>) => change(rows.map((r, j) => (j === i ? { ...r, ...value } : r)));
  const live = products.filter((p) => !p.archived);
  return (
    <FormSection
      title="不挂任务的完工"
      hint="打样、补做这类没有生产任务的，选产品填数量，和上面的任务一起登记"
      columns={1}
      extra={
        <button type="button" className="secondary" onClick={() => change([...rows, { productId: null, good: '', scrap: '0' }])}>
          <Plus size={14} aria-hidden="true" />
          加一行
        </button>
      }
    >
      {rows.length > 0 && (
        <div className="line-table pb-tasks">
          <table>
            <thead>
              <tr>
                <th>产品</th>
                <th className="num">合格</th>
                <th className="num">报废</th>
                <th aria-label="操作" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td>
                    <Combobox
                      ariaLabel={'不挂任务第 ' + (i + 1) + ' 行产品'}
                      placeholder="选择产品"
                      value={r.productId ? String(r.productId) : ''}
                      onChange={(id) => patch(i, { productId: Number(id) || null })}
                      options={live.map((p) => ({ value: String(p.id), label: p.name }))}
                    />
                  </td>
                  {(['good', 'scrap'] as const).map((k) => (
                    <td className="num" key={k} data-label={k === 'good' ? '合格' : '报废'}>
                      <div className="wh-qty">
                        <input
                          aria-label={'不挂任务第 ' + (i + 1) + ' 行' + (k === 'good' ? '合格' : '报废')}
                          inputMode="decimal"
                          required
                          value={r[k]}
                          onChange={(e) => patch(i, { [k]: e.currentTarget.value })}
                        />
                        <span>{FINISHED_UNIT}</span>
                      </div>
                    </td>
                  ))}
                  <td className="pb-remove">
                    <RowDelete
                      label={'去掉不挂任务第 ' + (i + 1) + ' 行'}
                      onClick={() => change(rows.filter((_, j) => j !== i))}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </FormSection>
  );
}
