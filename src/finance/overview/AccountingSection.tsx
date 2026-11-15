import { Hint, ListSummary, yuan } from '../../ui/index';
import { FinSection } from '../layout';
import { useFinRead } from '../fin-api';
import { estimateHint } from './estimate-hint';

/** 记账口径：按凭证算的收入、成本和利润。财务启用后才有，默认收起。 */
export default function AccountingSection({
  period,
  enabled,
}: {
  period: string;
  enabled: boolean;
}) {
  const { data } = useFinRead(enabled ? ['GET /finance/reports/dashboard', { query: { period } }] : null);
  if (!enabled || !data) return null;
  const { accounting } = data;
  const hint = estimateHint({ missingTax: data.missingTax, missingPrice: data.current.missingPrice });
  return (
    <FinSection
      title="记账口径"
      note="按凭证算的收入、成本和利润，和上面的理论、实际盈亏是两回事"
      collapsed
    >
      {hint && <Hint tone="warning">{hint}</Hint>}
      <ListSummary
        items={[
          { label: '会计收入', value: yuan(accounting.revenue) },
          { label: '销售成本', value: yuan(accounting.salesCost) },
          { label: '毛利', value: yuan(accounting.grossProfit) },
          { label: '期间费用', value: yuan(accounting.expense) },
          { label: '净利润', value: yuan(accounting.profit) },
          { label: '含待补的估算收入', value: yuan(accounting.estimatedRevenue) },
        ]}
      />
    </FinSection>
  );
}
