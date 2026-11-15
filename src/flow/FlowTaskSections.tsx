import { RAW_UNIT } from '../../shared/core/index';
import { flowStatusText, specLine, type FlowDocView } from '../../shared/business/index';
import { quantityString, quantityUnits } from '../../shared/core/index';
import type { CatalogLists } from '../recordkit/catalog-api';
import { businessStatusTone } from '../recordkit/record-meta';
import { netQuantity as netUsed } from '../recordkit/quantity';
import { Section, StatusChip } from '../ui/index';

/* 单据详情里生产用的两段：生产任务名下的完工记录和领料合计、领料表（任务和完工单共用）。 */

/** 详情要对照的档案：完工记录、库存品（还没读到时可能没有） */
type SectionData = Partial<Pick<CatalogLists, 'productions' | 'items'>>;

/** 生产任务的完工记录和领料：按任务列出每次登记，领料按纸板合计（同一单位才相加）。 */
export function TaskProduction({ task, data }: { task: Pick<FlowDocView<'task'>, 'id' | 'unit'>; data: SectionData }) {
  const records = (data.productions || [])
    .filter((p) => p.taskId === task.id)
    .sort((a, b) => (a.date === b.date ? a.id - b.id : a.date < b.date ? -1 : 1));
  if (!records.length) return null;
  const used = new Map<number, { issued: number; returned: number }>();
  for (const p of records)
    if (p.status === 'confirmed')
      for (const m of p.materials) {
        const row = used.get(m.stockId) || { issued: 0, returned: 0 };
        try {
          row.issued += quantityUnits(m.issued || '0');
          row.returned += quantityUnits(m.returned || '0');
        } catch {
          // 填错的数字不计入合计（合计只作参考，每次登记的原数在上面的完工记录里）
        }
        used.set(m.stockId, row);
      }
  return (
    <>
      <Section title={'完工记录 · ' + records.length + ' 次'}>
        <div className="table-wrap">
          <table className="wh-linked">
            <thead>
              <tr>
                <th>完工记录</th>
                <th className="num">合格 / 报废</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {records.map((p) => (
                <tr key={p.id}>
                  <td>
                    <a className="nowrap" href={'#production?view=production&doc=' + p.id}>
                      {p.number}
                    </a>
                    <small>
                      <span className="nowrap">{p.date}</span>
                      {p.operator ? ' · ' + p.operator : ''}
                    </small>
                  </td>
                  <td className="num">
                    {p.goodQuantity} / {p.scrapQuantity || '0'} {task.unit}
                  </td>
                  <td>
                    <StatusChip tone={businessStatusTone(flowStatusText(p))}>{flowStatusText(p)}</StatusChip>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
      {used.size > 0 && (
        <MaterialsTable
          data={data}
          rows={[...used].map(([stockId, m]) => ({
            stockId,
            issued: quantityString(m.issued),
            returned: quantityString(m.returned),
          }))}
        />
      )}
    </>
  );
}

/** 领料表：生产任务（按纸板合计）和完工记录（这一次）共用，带规格行和单位。 */
export function MaterialsTable({ rows, data }: { rows: { stockId: number; issued: string; returned: string }[]; data: Pick<SectionData, 'items'> }) {
  return (
    <Section title="领料">
      <div className="table-wrap">
        <table className="wh-linked">
          <thead>
            <tr>
              <th>纸板</th>
              <th className="num">领用</th>
              <th className="num">退料</th>
              <th className="num">净耗用</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => {
              const s = data.items?.find((x) => x.id === m.stockId),
                unit = s?.unit || RAW_UNIT;
              return (
                <tr key={m.stockId}>
                  <td>
                    {s?.name || '纸板'}
                    {s && specLine(s) && <small>{specLine(s)}</small>}
                  </td>
                  <td className="num">
                    {m.issued} {unit}
                  </td>
                  <td className="num">
                    {m.returned} {unit}
                  </td>
                  <td className="num">
                    {netUsed(m.issued, m.returned)} {unit}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Section>
  );
}
