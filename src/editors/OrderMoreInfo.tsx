import { FormField, FormSection } from '../ui/index';
import OrderCosts from './OrderCosts';
import type { CostDraft, OrderExtras } from './order-draft';

/** 金额结算的两种选法：下拉框照这里列，选中的按这里取值 */
const roundingChoices = [
  { value: 'exact-cents', label: '精确到分，不自动舍入' },
  { value: 'half-up-cent', label: '明确采用整单四舍五入到分' },
] as const satisfies readonly { value: OrderExtras['roundingPolicy']; label: string }[];

/**
 * 订单编辑窗里收起来的“更多信息”：供应方、税率和含税口径、金额结算、合同条件、预估成本。
 * 用得少，默认收起；合计有不足一分的尾数要选结算方式时由编辑窗自动展开（open）。
 */
export default function OrderMoreInfo({
  open,
  setOpen,
  extras,
  setExtras,
  costed,
  setCosted,
  costs,
  setCosts,
  costText,
  profitText,
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
  extras: OrderExtras;
  setExtras: (update: (v: OrderExtras) => OrderExtras) => void;
  costed: boolean;
  setCosted: (costed: boolean) => void;
  costs: CostDraft;
  setCosts: (update: (c: CostDraft) => CostDraft) => void;
  costText: string;
  profitText: string;
}) {
  return (
    <details
      className="sales-more-info"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>
        更多信息
        <small>供应方、税费、合同条件、金额结算、预估成本</small>
      </summary>
      <FormSection title="供应方、税费和结算" columns={4}>
        <FormField label="供应方" span={2} hint="客户采购单上写的供货单位，可不填">
          <input
            maxLength={100}
            data-field="供应方"
            value={extras.supplierName}
            onChange={(e) => setExtras((v) => ({ ...v, supplierName: e.target.value }))}
          />
        </FormField>
        <FormField label="税率">
          <input
            maxLength={30}
            placeholder="例如 13%"
            value={extras.taxRate}
            onChange={(e) => setExtras((v) => ({ ...v, taxRate: e.target.value }))}
          />
        </FormField>
        <FormField label="含税口径">
          <input
            maxLength={60}
            placeholder="含税 / 未税"
            value={extras.taxMode}
            onChange={(e) => setExtras((v) => ({ ...v, taxMode: e.target.value }))}
          />
        </FormField>
        <FormField label="金额结算" span={2} hint="不会自动加减税">
          <select
            value={extras.roundingPolicy}
            onChange={(e) => {
              const chosen = roundingChoices.find((c) => c.value === e.target.value);
              if (chosen) setExtras((v) => ({ ...v, roundingPolicy: chosen.value }));
            }}
          >
            {roundingChoices.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="合同条件" span="full">
          <input
            maxLength={4000}
            value={extras.terms}
            onChange={(e) => setExtras((v) => ({ ...v, terms: e.target.value }))}
          />
        </FormField>
      </FormSection>
      <OrderCosts
        costed={costed}
        setCosted={setCosted}
        costs={costs}
        setCosts={setCosts}
        costText={costText}
        profitText={profitText}
      />
    </details>
  );
}
