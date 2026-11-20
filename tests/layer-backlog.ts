// 分层检查的“只许减少”清单：立规矩时已经越层、还没整理的地方。不修，先登记；整理掉一处就删一条。
// 清单之外多出来的越层会被拦，清单里已经不存在的（整理掉了却没删登记）也会被拦。
// 代码的分层检查在 module-boundaries.test.ts，样式的在 css-modules.test.ts，层的划分在 module-map.ts。

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

/**
 * 业务公共件（src/recordkit/）的样式里改上层类名的选择器：样式文件 → 选择器。
 * 整理办法：把这条规则搬到类名主人所在目录的样式里（路线图“架构整理”第 2 阶段），用 style-compare 比到没有差异。
 */
export const cssLayerBacklog: { file: string; selectors: string[] }[] = [
  {
    file: 'src/recordkit/kit-2.css',
    selectors: [
      '.flow-records .section-heading',
      '.flow-records .section-heading > button',
      '.flow-records .section-heading h3',
      '.flow-table tbody tr',
      '.flow-table td',
      '.flow-table th',
      '.line-card-sum',
    ],
  },
  {
    file: 'src/recordkit/kit-3.css',
    selectors: [
      '.help-list',
      ":root[data-ui='refined'] .detail-panel-body table.wh-linked td > a",
      ":root[data-ui='refined'] .flow-search > input",
      ":root[data-ui='refined'] .flow-search > input:focus",
      ":root[data-ui='refined'] .flow-search > input:hover",
      ":root[data-ui='refined'] main td button:not(.primary, .row-key, .danger-solid, .icon-button, .chain-node)",
      ":root[data-ui='refined'] main td button:not(.primary, .row-key, .danger-solid, .icon-button, .chain-node):hover:not(:disabled)",
    ],
  },
  {
    file: 'src/recordkit/kit.css',
    selectors: [
      '.arrival-table .sub',
      '.arrival-warehouse .business-records > .unified-table-region > .arrival-table .sub',
      '.arrival-warehouse > .section-heading .sub',
      '.board-card.done',
      '.business-form-preview .help-text',
      '.business-records .unified-table-region .record-no',
      '.business-records .unified-table-region > table > tbody > tr > td.cell-wrap',
      '.chain-link.done',
      '.chain-node.blocked',
      '.chain-node.done',
      '.flow-empty',
      '.flow-records .section-heading h3',
      '.flow-search',
      '.flow-search > input',
      '.flow-search:focus-within',
      '.flow-status',
      '.flow-table',
      '.flow-table progress',
      '.flow-table td',
      '.flow-table th',
      '.flow-toolbar',
      '.flow-toolbar > .record-view-tabs',
      '.flow-toolbar > .record-view-tabs > button',
      '.help-text',
      '.line-table td button.wh-link',
      '.line-table td.num.wh-cell-text',
      '.line-table td.wh-cell-text',
      '.line-table tr.wh-row-off td.wh-cell-text',
      '.management-dialog:has(.ob-rows, .ob-preview) .editor-footer-actions',
      '.management-dialog:has(.ob-rows, .ob-preview) .editor-footer-actions > .more-menu',
      '.management-dialog:has(.ob-rows, .ob-preview) .editor-footer-actions > button',
      '.ob-due',
      '.ob-row',
      '.ob-row-head',
      '.ob-row-head small',
      '.ob-row-qty',
      '.ob-row:first-child',
      '.ob-rows',
      '.pb-tasks .wh-qty > input',
      '.pur-details .receipt-history table',
      '.pur-empty',
      '.pur-unit-select .dimension-unit-control',
      '.pur-unit-select .dimension-unit-control small',
      '.queue-row .record-no',
      '.rb-stocks > .help-text',
      '.receipt-history .sub',
      '.row-key',
      '.row-key:hover:not(:disabled)',
      '.wh-muted',
      '.wh-qty',
      '.wh-qty > input',
      '.wh-qty > span',
      ":root[data-ui='refined'] .flow-search > input",
      'button.wh-link',
      'button.wh-link.danger-text',
      'button.wh-link:hover:not(:disabled)',
      'table.wh-linked td',
      'table.wh-linked td a',
    ],
  },
];
