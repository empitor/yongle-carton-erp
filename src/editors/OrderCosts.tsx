import { FormField, FormSection } from '../ui/index';

import type { CostDraft } from './order-draft';

const fields = [
  { key: 'material', label: '材料费用' },
  { key: 'processing', label: '加工费用' },
  { key: 'waste', label: '损耗费用' },
  { key: 'other', label: '其他费用' },
] as const;

/** 订单的预估成本：按整张订单填总额和估算依据，不套统一公式；不录入的订单不计入毛利汇总。 */
export default function OrderCosts({
  costed,
  setCosted,
  costs,
  setCosts,
  costText,
  profitText,
}: {
  costed: boolean;
  setCosted: (v: boolean) => void;
  costs: CostDraft;
  setCosts: (update: (c: CostDraft) => CostDraft) => void;
  costText: string;
  profitText: string;
}) {
  return (
    <FormSection
      title="预估成本"
      hint={costed ? '按整张订单填写，单位元，最多两位小数。' : '不录入的订单不计入毛利汇总。'}
      columns={4}
      extra={
        <label className="sales-check">
          <input type="checkbox" checked={costed} onChange={(e) => setCosted(e.target.checked)} />
          录入预估成本
        </label>
      }
    >
      {costed && (
        <>
          {fields.map((x) => (
            <FormField key={x.key} label={x.label} required>
              <input
                required
                type="number"
                min="0"
                max="1000000"
                step="0.01"
                value={costs[x.key]}
                onChange={(e) => setCosts((c) => ({ ...c, [x.key]: e.target.value }))}
              />
            </FormField>
          ))}
          <FormField label="估算依据" required span="full">
            <textarea
              required
              maxLength={1000}
              rows={2}
              placeholder="例如：本单实际配纸报价、加工报价、单独确认的损耗及运费"
              value={costs.basis}
              onChange={(e) => setCosts((c) => ({ ...c, basis: e.target.value }))}
            />
          </FormField>
          <div className="sales-cost-summary span-full">
            <span>预估成本 ¥{costText}</span>
            <strong>预估毛利 {profitText === '—' ? '—' : '¥' + profitText}</strong>
          </div>
        </>
      )}
    </FormSection>
  );
}
