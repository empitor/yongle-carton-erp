/**
 * 财务扫描的业务来源有哪几种：送货单、到货单、完工单和盘点调整流水（fin_events.source_kind、fin_source_observations.source_kind）。
 * 业务的财务口径（shared/business/finance-source.ts）、只读窗口（server/flow/finance-facts/sources.ts）、财务存的值
 * （server/finance/stored-values.ts）和财务接口的类型（shared/finance）都引这一份。放在基础：共用-财务只能引共用-基础。
 */
export const financeSource = { delivery: 'delivery', arrival: 'arrival', production: 'production', stock: 'stock' } as const;
export const financeSourceKinds = [
  financeSource.delivery,
  financeSource.arrival,
  financeSource.production,
  financeSource.stock,
] as const;
export type FinanceSourceKind = (typeof financeSourceKinds)[number];
