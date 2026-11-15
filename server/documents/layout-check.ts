import { defaultDocumentTemplates, type DocumentTemplate } from '../../shared/documents/index.js';
/**
 * 排版自检用的几种纸张和模板（scripts/linux/verify-layout.mjs、verify-runtime.mjs 用）：
 * 默认的送货单、订货单，加上换纸张、换方向的几种；rowsPerPage 是这种版式每张该放几行明细。
 */
export function layoutCases(): { name: string; template: DocumentTemplate; rowsPerPage: number }[] {
  const [purchase, delivery] = defaultDocumentTemplates().templates;
  return [
    { name: 'delivery-93', template: delivery, rowsPerPage: 6 },
    {
      name: 'delivery-140',
      template: { ...delivery, paper: 'continuous-241x140' },
      rowsPerPage: 11,
    },
    { name: 'delivery-a5', template: { ...delivery, paper: 'a5' }, rowsPerPage: 11 },
    { name: 'purchase-a4', template: purchase, rowsPerPage: 24 },
    { name: 'purchase-wide', template: { ...purchase, orientation: 'landscape' }, rowsPerPage: 14 },
  ];
}
