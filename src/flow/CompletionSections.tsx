import { FINISHED_UNIT, RAW_UNIT } from '../../shared/core/index';
import { Plus } from 'lucide-react';
import { specLine, type CompletionPreview as CompletionPlan } from '../../shared/business/index';
import { Combobox, RowDelete } from '../ui/index';
import { FormField, FormGroup, FormSection } from '../ui/index';
import { sumByUnit } from '../ui/index';
import type { CatalogLists } from '../recordkit/catalog-api';
import { netQuantity as net } from '../recordkit/quantity';
import type { CompletionRow, CompletionTask } from './CompletionTasks';

/** 登记完工窗口（ProductionBatchDialog）里的三块：领了哪些纸板、纸板怎么分到各任务、领料分配结果。 */

/** 领料的一行：纸板（库存品编号的文字，还没选是空串）、领用、退料 */
export type Material = { stockId: string; issued: string; returned: string };
export type Allocation = 'shared-proportional' | 'explicit';
/** 分配方式下拉只有这两项 */
const allocationOf = (value: string): Allocation => (value === 'explicit' ? 'explicit' : 'shared-proportional');
/** 纸板编号（领料行里是文字、核验结果里是数）换成名称 */
type StockName = (id: string | number) => string;

/** 这批领了哪些纸板：每种一行领用、退料，净耗用 = 领用 − 退料。 */
export function CompletionMaterials({
  materials,
  raw,
  change,
  add,
  remove,
}: {
  materials: Material[];
  /** 可选的原材料库存品 */
  raw: readonly CatalogLists['items'][number][];
  change: (index: number, key: keyof Material, value: string) => void;
  add: () => void;
  remove: (index: number) => void;
}) {
  return (
    <FormSection
      title="领了哪些纸板"
      hint="按张登记这批实际领用和退料；净耗用 = 领用 − 退料。"
      columns={1}
      extra={
        <button type="button" className="secondary" onClick={add}>
          <Plus size={14} aria-hidden="true" />
          加一种纸板
        </button>
      }
    >
      <div className="line-table pb-materials">
        <table>
          <thead>
            <tr>
              <th>纸板</th>
              <th className="num">领用（张）</th>
              <th className="num">退料（张）</th>
              <th className="num">净耗用</th>
              <th aria-label="操作" />
            </tr>
          </thead>
          <tbody>
            {materials.map((m, i) => (
              <tr key={i}>
                <td className="pb-material">
                  <Combobox
                    ariaLabel={'第 ' + (i + 1) + ' 种纸板'}
                    placeholder="选择纸板"
                    required
                    value={m.stockId}
                    onChange={(id) => change(i, 'stockId', id)}
                    options={raw.map((s) => ({
                      value: String(s.id),
                      label: [s.name, specLine(s)].filter(Boolean).join(' · '),
                      hint: '库存 ' + s.quantity + ' 张',
                    }))}
                  />
                </td>
                <td className="num" data-label="领用">
                  <input
                    required
                    aria-label={'第 ' + (i + 1) + ' 种纸板领用（张）'}
                    inputMode="numeric"
                    value={m.issued}
                    onChange={(e) => change(i, 'issued', e.currentTarget.value)}
                  />
                </td>
                <td className="num" data-label="退料">
                  <input
                    required
                    aria-label={'第 ' + (i + 1) + ' 种纸板退料（张）'}
                    inputMode="numeric"
                    value={m.returned}
                    onChange={(e) => change(i, 'returned', e.currentTarget.value)}
                  />
                </td>
                <td className="num wh-cell-text" data-label="净耗用">
                  {m.issued ? net(m.issued, m.returned) : '—'}
                </td>
                <td className="pb-remove">
                  <RowDelete
                    label={'移除第 ' + (i + 1) + ' 种纸板'}
                    disabled={materials.length === 1}
                    onClick={() => remove(i)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
          {materials.length > 1 && (
            <tfoot>
              <tr>
                <td>合计</td>
                <td className="num">
                  {sumByUnit(materials.map((m) => ({ value: m.issued, unit: RAW_UNIT })))}
                </td>
                <td className="num">
                  {sumByUnit(materials.map((m) => ({ value: m.returned, unit: RAW_UNIT })))}
                </td>
                <td className="num">
                  {sumByUnit(
                    materials.map((m) => ({ value: net(m.issued, m.returned), unit: RAW_UNIT })),
                  )}
                </td>
                <td />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </FormSection>
  );
}

/** 几张任务共用一批纸板时，纸板怎么分：按产量比例，或逐任务填写。 */
export function CompletionDistribution({
  allocation,
  setAllocation,
  chosen,
  materials,
  distribution,
  setCell,
  stockName,
}: {
  allocation: Allocation;
  setAllocation: (v: Allocation) => void;
  /** 勾选了的任务 */
  chosen: readonly Pick<CompletionRow, 'id' | 'number'>[];
  /** 已经选了纸板的领料行 */
  materials: Material[];
  distribution: Record<string, { issued: string; returned: string }>;
  setCell: (key: string, value: { issued: string; returned: string }) => void;
  stockName: StockName;
}) {
  return (
    <FormSection title="纸板怎么分到各任务" columns={2}>
      <FormField
        label="分配方式"
        hint={
          allocation === 'explicit'
            ? '每张任务分别填领用和退料。'
            : '按合格数量比例分整张，只记领料归属，不推算开料方式。'
        }
      >
        <select
          aria-label="领料归属方式"
          value={allocation}
          onChange={(e) => setAllocation(allocationOf(e.currentTarget.value))}
        >
          <option value="shared-proportional">整批共享，按实际产量比例分整张</option>
          <option value="explicit">逐任务填写实际领退料</option>
        </select>
      </FormField>
      {allocation === 'explicit' && (
        <FormGroup span="full">
          {chosen.length && materials.length ? (
            <div className="line-table wh-no-action pb-distribution">
              <table>
                <thead>
                  <tr>
                    <th>任务</th>
                    <th>纸板</th>
                    <th className="num">领用（张）</th>
                    <th className="num">退料（张）</th>
                  </tr>
                </thead>
                <tbody>
                  {chosen.flatMap((r) =>
                    materials.map((m, j) => {
                      const key = r.id + ':' + m.stockId,
                        v = distribution[key] || { issued: '0', returned: '0' };
                      return (
                        <tr key={key}>
                          <td className="wh-cell-text">{j === 0 ? r.number : ''}</td>
                          <td className="wh-cell-text">{stockName(m.stockId)}</td>
                          {(['issued', 'returned'] as const).map((k) => (
                            <td key={k} className="num">
                              <input
                                required
                                aria-label={
                                  r.number +
                                  ' ' +
                                  stockName(m.stockId) +
                                  (k === 'issued' ? ' 领用（张）' : ' 退料（张）')
                                }
                                inputMode="numeric"
                                value={v[k]}
                                onChange={(e) => setCell(key, { ...v, [k]: e.currentTarget.value })}
                              />
                            </td>
                          ))}
                        </tr>
                      );
                    }),
                  )}
                </tbody>
                <tfoot>
                  {materials.map((m) => (
                    <tr key={'sum' + m.stockId}>
                      <td>已分</td>
                      <td>{stockName(m.stockId)}</td>
                      <td className="num">
                        {sumByUnit(
                          chosen.map((r) => ({
                            value: distribution[r.id + ':' + m.stockId]?.issued || '0',
                            unit: '',
                          })),
                        )}{' '}
                        / {m.issued || '—'}
                      </td>
                      <td className="num">
                        {sumByUnit(
                          chosen.map((r) => ({
                            value: distribution[r.id + ':' + m.stockId]?.returned || '0',
                            unit: '',
                          })),
                        )}{' '}
                        / {m.returned || '—'}
                      </td>
                    </tr>
                  ))}
                </tfoot>
              </table>
            </div>
          ) : (
            <p className="choice-list-empty">先选好任务和纸板，再逐任务分配。</p>
          )}
        </FormGroup>
      )}
    </FormSection>
  );
}

/** 先看领料怎么分：服务端预览出的每张任务的合格、报废和领退料。 */
export function CompletionPreview({
  preview,
  rows,
  productName,
  productOf,
  stockName,
}: {
  preview: CompletionPlan;
  rows: readonly CompletionRow[];
  productName: (r: CompletionTask) => string | undefined;
  /** 不挂任务的那几行（taskId 是空的）按产品叫 */
  productOf: (productId: number) => string;
  stockName: StockName;
}) {
  return (
    <section className="ed-section wh-preview" aria-label="领料分配结果">
      <header>
        <h3>领料怎么分 · {preview.results.length} 张完工单</h3>
      </header>
      {preview.allocationBasis && <p className="ed-hint">{preview.allocationBasis}</p>}
      <div className="table-wrap">
        <table className="wh-table">
          <thead>
            <tr>
              <th>任务或产品</th>
              <th className="num">合格 / 报废</th>
              <th>领用 / 退料</th>
            </tr>
          </thead>
          <tbody>
            {preview.results.map((r, i) => {
              const t = r.taskId == null ? null : rows.find((x) => x.id === r.taskId);
              return (
                <tr key={r.taskId ?? 'p' + r.productId + ':' + i}>
                  <td>
                    {t ? t.number : '不挂任务'}
                    <small>{t ? productName(t) : productOf(r.productId)}</small>
                  </td>
                  <td className="num">
                    {r.goodQuantity} / {r.scrapQuantity} {t?.unit || FINISHED_UNIT}
                  </td>
                  <td>
                    {r.materials.map((m) => (
                      <span key={m.stockId} className="wh-block">
                        {stockName(m.stockId)}：领 {m.issued}，退 {m.returned} 张
                      </span>
                    ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
