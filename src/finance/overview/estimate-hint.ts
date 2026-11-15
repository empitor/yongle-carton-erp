/**
 * 概览“记账口径”顶上的提示：本月有待补税率的单据（看板的 missingTax）、没算进理论金额的单据（这个月经营数的
 * missingPrice）时，下面按凭证算的数是估算。只写有数的那几项，为 0 的不写；都没有就不提示。
 * missingPrice 数的是金额为空的单据，缺价格、缺数量的都在里面（server/finance/monthly.ts），所以说“缺价格或数量”。
 */
export function estimateHint({ missingTax, missingPrice }: { missingTax: number; missingPrice: number }) {
  const parts = [
    missingTax > 0 ? missingTax + ' 张单据待补税率' : null,
    missingPrice > 0 ? missingPrice + ' 张单据缺价格或数量、没算进理论金额' : null,
  ].filter((part) => part !== null);
  return parts.length ? '本月有 ' + parts.join('，') + '，下面的数字是估算。' : null;
}
