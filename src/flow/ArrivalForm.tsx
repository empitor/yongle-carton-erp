import { Plus } from 'lucide-react';
import { blankArrivalLine, type OrderBatchView } from '../../shared/business/index';
import type { CatalogLists } from '../recordkit/catalog-api';
import { FormField, FormMessage, FormSection } from '../ui/index';
import Select from './Select';
import ArrivalLineCard from './ArrivalLineCard';
import type { ArrivalEditing, ArrivalEditLine } from './flow-prefill';
import { dateInput as date, timeInput as time } from './form-inputs';
import BatchChoice from './BatchChoice';

/** 到货单表单要对照的档案：供应商、库存品；AI 识别的送货单另带还没到齐的订货单（batches） */
export type ArrivalFormData = Pick<CatalogLists, 'items' | 'suppliers'> & { batches?: OrderBatchView[] };
type Change = (patch: Partial<ArrivalEditing>) => void;

/** 哪家供应商送来的：供应商、送货单号、挂哪份订货单（AI 识别的）、到货日期和时间 */
function ArrivalHead({ v, change, data }: { v: ArrivalEditing; change: Change; data: ArrivalFormData }) {
  return (
    <FormSection title="哪家供应商送来的" columns={4}>
      <Select
        label="供应商"
        required
        span={2}
        value={v.supplierId}
        options={data.suppliers}
        // 换了供应商，原来挑的订货单不再对得上（不挂订货单就是没有这一项，不能写 null）
        onChange={(supplierId) => change({ supplierId, orderBatchId: undefined, withoutPurchase: false })}
      />
      <FormField label="供应商送货单号" required span={2}>
        <input
          aria-label="供应商送货单号"
          value={v.reference}
          maxLength={100}
          onChange={(e) => change({ reference: e.target.value })}
        />
      </FormField>
      {data.batches && <BatchChoice value={v} batches={data.batches} change={change} />}
      <FormField label="到货日期" required>
        {date(v.date, (d) => change({ date: d }), '实际到货日期')}
      </FormField>
      <FormField label="到货时间" hint="不知道可以留空">
        {time(v.actualTime, (actualTime) => change({ actualTime }), '实际到货时间')}
      </FormField>
    </FormSection>
  );
}

/**
 * 到货单编辑窗：哪家供应商送来的，收到哪些纸板。有采购单的货按订货单登记（到货页“待到货”），
 * 这里新建的是没有采购单的货（多送、样品）；AI 识别的送货单在这里选挂哪份订货单（data.batches 有值时）。
 */
export default function ArrivalForm({
  value: v,
  change,
  data,
}: {
  value: ArrivalEditing;
  change: Change;
  data: ArrivalFormData;
}) {
  const patchLine = (i: number, patch: Partial<ArrivalEditLine>) =>
    change({ lines: v.lines.map((l, index) => (index === i ? { ...l, ...patch } : l)) });
  // 原材料只有“张”（数据库约束）
  const raw = data.items.filter((s) => s.kind === 'raw');
  return (
    <>
      {v.sourceId ? (
        <FormMessage tone="warning">
          这张是 AI 从送货单识别出来的，请逐项核对数量、单位，并选是哪份订货单的货；原件会保留。
        </FormMessage>
      ) : (
        !v.id && (
          <FormMessage tone="info">
            这里登记没有采购单的货（供应商多送、样品）。有采购单的货请在到货页“待到货”里点“登记到货”，按订货单分配。
          </FormMessage>
        )
      )}
      <ArrivalHead v={v} change={change} data={data} />
      <FormSection
        title="收到哪些纸板"
        hint="纸板按张管理，AI 识别的以识别结果为准。"
        columns={1}
        extra={
          <button type="button" className="secondary" onClick={() => change({ lines: [...v.lines, blankArrivalLine()] })}>
            <Plus size={14} aria-hidden="true" />
            加一种纸板
          </button>
        }
      >
        {v.lines.map((l, i) => (
          <ArrivalLineCard
            key={i}
            l={l}
            index={i}
            only={v.lines.length === 1}
            raw={raw}
            patch={(p) => patchLine(i, p)}
            remove={() => change({ lines: v.lines.filter((_, j) => i !== j) })}
          />
        ))}
      </FormSection>
    </>
  );
}
