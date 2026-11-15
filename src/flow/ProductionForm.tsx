import { useRef } from 'react';
import type { FlowDocView } from '../../shared/business/index';
import { FINISHED_UNIT, today } from '../../shared/core/index';
import { FormField, FormMessage, FormSection } from '../ui/index';
import type { CatalogLists } from '../recordkit/catalog-api';
import { AddRow } from './CorrectionParts';
import MaterialInputs, { type MaterialInput, type RawStock } from './MaterialInputs';
import Select from './Select';
import { overPlanText, taskOptionText } from './task-progress';

type ProductionDoc = FlowDocView<'production'>;
/**
 * 编辑窗里的完工单（待入库完工单的副本）：表单读和改的这几项。编号、版本、状态没有时按还没存过的算；
 * 产品可能还没选，新加的领料行还没选纸板
 */
export type ProductionEditing = { kind: 'production' } & Pick<
  ProductionDoc,
  'goodQuantity' | 'scrapQuantity' | 'operator' | 'date' | 'taskId' | 'notes'
> &
  Partial<Pick<ProductionDoc, 'id' | 'version' | 'status' | 'finishedStockId'>> & { productId: number | null; materials: MaterialInput[] };
/** 能挂的生产任务：编号、状态、产品、计划数和单位、已完工和待入库 */
type TaskChoice = Pick<FlowDocView<'task'>, 'id' | 'number' | 'status' | 'productId' | 'quantity' | 'unit' | 'completed' | 'pendingCompleted'>;
/** 完工单表单要对照的档案：库存品（选纸板）、生产任务、产品 */
export type ProductionFormData = {
  items: readonly (RawStock & Pick<CatalogLists['items'][number], 'kind'>)[];
  tasks: readonly TaskChoice[];
  products: readonly { id: number; name: string }[];
};

/**
 * 打开时这张完工单自己挂的任务和合格数（ownTask、own）：任务上的待入库数（pendingCompleted）已经算着它自己，
 * 超计划提示和任务选项都要先扣掉它，和服务端同一口径。
 * hadTask：打开时就挂着任务，任务下拉一直留着；不挂任务的完工单不显示任务下拉
 */
type Opened = { id: number | null; hadTask: boolean; ownTask: number | null; own: boolean; good: string };
const openedFor = (v: ProductionEditing): Opened => ({
  id: v.id ?? null,
  hadTask: v.taskId != null,
  ownTask: v.id != null && v.status === 'draft' ? v.taskId : null,
  own: v.id != null && v.status === 'draft',
  good: v.goodQuantity,
});

/**
 * 编辑一张待入库的完工单：完工哪个产品、完成多少、领料（已入库的改数量走“更正完工单”）。
 * 新登记完工只有“登记完工”窗口（ProductionBatchDialog），挂不挂任务都在那里。
 */
export default function ProductionForm({
  value: v,
  change,
  data,
}: {
  value: ProductionEditing;
  change: (patch: Partial<ProductionEditing>) => void;
  data: ProductionFormData;
}) {
  const patchMaterial = (i: number, patch: Partial<MaterialInput>) =>
    change({ materials: v.materials.map((l, index) => (index === i ? { ...l, ...patch } : l)) });
  // 原材料只有“张”（数据库约束）
  const raw = data.items.filter((s) => s.kind === 'raw');
  // 换了一张单据才重新记下打开时的样子
  const openedRef = useRef<Opened | null>(null);
  const kept = openedRef.current,
    opened = kept && kept.id === (v.id ?? null) ? kept : openedFor(v);
  openedRef.current = opened;
  const task = v.taskId ? data.tasks.find((t) => t.id === v.taskId) : undefined;
  const overPlan = task ? overPlanText(task, v.goodQuantity, opened) : '';
  return (
    <>
      {/* 挂了任务的完工单才显示任务；不挂任务的只选产品 */}
      <FormSection title={opened.hadTask ? '完工哪张任务' : '完工哪个产品'}>
        {opened.hadTask && (
          <Select
            label="生产任务"
            span="full"
            hint="不选就是不挂任务的完工（打样、补做）。"
            value={v.taskId}
            options={data.tasks
              .filter((t) => t.status === 'confirmed')
              .map((t) => ({
                ...t,
                // 和下面的超计划提示同一组数：这张单自己挂的任务扣掉它自己，写明“不算这张”
                label:
                  t.number +
                  ' · ' +
                  (data.products.find((p) => p.id === t.productId)?.name || '') +
                  ' · ' +
                  taskOptionText(t, opened),
              }))}
            onChange={(taskId) => {
              const t = data.tasks.find((t) => t.id === taskId);
              change({
                taskId,
                ...(t
                  ? // 入哪个成品库存由产品决定，登记时服务端按产品对应
                    { productId: t.productId, finishedStockId: null }
                  : {}),
              });
            }}
          />
        )}
        <Select
          label="产品"
          required
          hint="合格数量入这个产品的成品库存；还没有的，登记时自动新建。"
          value={v.productId}
          options={data.products}
          onChange={(productId) => change({ productId, taskId: null, finishedStockId: null })}
        />
      </FormSection>
      <FormSection title="完成多少" columns={4}>
        <FormField label={'合格数量（' + FINISHED_UNIT + '）'} required>
          <input aria-label="实际合格数量" inputMode="decimal" value={v.goodQuantity} onChange={(e) => change({ goodQuantity: e.currentTarget.value })} />
        </FormField>
        <FormField label="报废数量" hint="和合格数量同一单位">
          <input aria-label="损耗报废数量" inputMode="decimal" value={v.scrapQuantity} onChange={(e) => change({ scrapQuantity: e.currentTarget.value })} />
        </FormField>
        <FormField label="机台操作" required>
          <input aria-label="实际操作人员" value={v.operator} onChange={(e) => change({ operator: e.currentTarget.value })} />
        </FormField>
        <FormField label="完工日期" required>
          <input
            type="date"
            aria-label="完工日期"
            max={today()}
            value={v.date || ''}
            onChange={(e) => change({ date: e.currentTarget.value })}
          />
        </FormField>
      </FormSection>
      {/* 和服务端同一句：保存（待入库）、核对入库都拦未来日期 */}
      <FormMessage>{v.date && v.date > today() ? '完工日期不能晚于今天。' : ''}</FormMessage>
      <FormMessage tone="warning">{overPlan}</FormMessage>
      <FormSection
        title="领料"
        hint="按张登记。净耗用 = 领用 − 退料；报废只作质量记录，不会再扣一次料。"
        columns={1}
        extra={
          <AddRow busy={false} add={() => change({ materials: [...v.materials, { stockId: null, issued: '', returned: '0' }] })}>
            加一种纸板
          </AddRow>
        }
      >
        <MaterialInputs
          rows={v.materials}
          raw={raw}
          patch={patchMaterial}
          remove={(i) => change({ materials: v.materials.filter((_, j) => i !== j) })}
        />
      </FormSection>
    </>
  );
}
