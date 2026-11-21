// 分层检查的“只许减少”清单：立规矩时已经越层、还没整理的地方。不修，先登记；整理掉一处就删一条。
// 清单之外多出来的越层会被拦，清单里已经不存在的（整理掉了却没删登记）也会被拦。
// 代码的分层检查在 module-boundaries.test.ts，层的划分在 module-map.ts。样式的分层检查在 css-modules.test.ts，已经没有越层的，不设清单。

/** 只许减少的清单和实际查出来的比：清单外多出来的（extra）、清单里已经查不到的（stale） */
export function compareBacklog(found: string[], backlog: string[]) {
  const listed = new Set(backlog);
  const seen = new Set(found);
  return {
    extra: [...seen].filter((k) => !listed.has(k)),
    stale: [...listed].filter((k) => !seen.has(k)),
  };
}

/**
 * 共用业务规则（shared/business）往上一层引用的：引用方文件 → 被引的文件（经 index.ts 引的名字按来源文件算）。
 * 整理办法：把被引的东西挪到下层那一份（路线图“架构整理”第 2 阶段）。
 */
export const businessLayerBacklog: { from: string; to: string; what: string }[] = [
  {
    from: 'shared/business/operations-views.ts',
    to: 'shared/business/flow-views.ts',
    what: 'receiptEventSchema、receiptLineSchema（采购单视图里的到货事件）',
  },
  { from: 'shared/business/order-batch.ts', to: 'shared/business/arrival.ts', what: 'arrivalTimeSchema' },
  { from: 'shared/business/order-batch.ts', to: 'shared/business/physical-flow.ts', what: 'noteText' },
  { from: 'server/operations/purchase-rows.ts', to: 'shared/business/physical-flow.ts', what: 'purchaseLineAmount（采购明细金额）' },
  { from: 'server/operations/stock-items.ts', to: 'shared/business/flow-document.ts', what: 'FlowDocument 类型（取到货明细里的物品）' },
];
