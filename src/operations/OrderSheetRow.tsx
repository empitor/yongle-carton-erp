import type { ReactNode } from 'react';
import type { OrderBatchView } from '../../shared/business/index';
import { quantityString } from '../../shared/core/index';
import BatchSchedule, { type ScheduleDraft } from './BatchSchedule';

/** 这一行显示的：名称、规格、订购数量和单位（订货单详情、导出预览的行都有） */
type SheetRow = Pick<OrderBatchView['rows'][number], 'name' | 'specification' | 'orderedUnits' | 'unit'>;

/**
 * 订货单的一行纸板：名称、规格、订购数量，右下角一句小字（导出窗写单价，采购单详情写已到多少），
 * 下面是分批到货安排。导出订货单窗口和采购单详情的“订货单”一节共用。
 */
export default function OrderSheetRow({
  row: r,
  note,
  value,
  disabled,
  onChange,
}: {
  row: SheetRow;
  note: ReactNode;
  value: ScheduleDraft[];
  disabled: boolean;
  onChange: (v: ScheduleDraft[]) => void;
}) {
  return (
    <div className="ob-row">
      <div className="ob-row-head">
        <div>
          <strong>{r.name}</strong>
          <small>{r.specification}</small>
        </div>
        <div className="ob-row-qty">
          <strong>
            {quantityString(r.orderedUnits)} {r.unit}
          </strong>
          <small>{note}</small>
        </div>
      </div>
      <BatchSchedule
        name={r.name}
        unit={r.unit}
        orderedUnits={r.orderedUnits}
        value={value}
        disabled={disabled}
        onChange={onChange}
      />
    </div>
  );
}
