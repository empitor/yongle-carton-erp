import type { DocumentTemplate } from '../../shared/document-templates.js';
import { applyDocumentTemplate, type BusinessForm } from './templates.js';
/** 纯展示样张，无业务ID、不创建订单、不使用真实库记录。 */
export function sampleDocument(template: DocumentTemplate): BusinessForm {
  const purchase = template.kind === 'purchase';
  return applyDocumentTemplate(
    {
      title: template.title,
      number: 'TEST-20261029',
      draft: true,
      sample: true,
      fields: purchase
        ? [
            ['采购单号', 'TEST-PO-001'],
            ['供应商', '虚构示例纸板厂'],
            ['供应商联系信息', '示例联系人 / 000-0000'],
            ['下单日期', '2026-10-29'],
            ['预计交货日期', '2026-11-02'],
          ]
        : [
            ['送货单号', 'TEST-DN-001'],
            ['客户', '虚构示例客户'],
            ['收货地址', '虚构工业园示例仓库'],
            ['实际送货日期', '2026-10-29'],
            ['关联销售订单', 'TEST-SO-001'],
            ['客户采购订单号', 'TEST-CPO-001'],
          ],
      headers: [],
      columnKeys: purchase
        ? ['index', 'name', 'specification', 'unit', 'quantity', 'unitPrice', 'amount']
        : ['index', 'name', 'specification', 'unit', 'quantity', 'notes'],
      rows: purchase
        ? [
            [
              '1',
              '示例五层瓦楞纸板',
              '1000 × 800 mm / K=A / BC楞',
              '张',
              '1000',
              '1.2345 元/张',
              '1234.5000000',
            ],
            ['2', '示例三层瓦楞纸板', '80 × 60 cm / B楞', '张', '200', '0.5 元/张', '100.0000000'],
          ]
        : [
            [
              '1',
              '示例包装纸箱',
              '300 × 200 × 150 mm',
              '只',
              '4000',
              '本批实际送货，非整单10000只',
            ],
            ['2', '示例内衬', '200 × 150 mm', '张', '200', '请按实收签认'],
          ],
      lineData: [
        {
          productCode: '000123',
          orderNumber: 'TEST-SO-001',
          customerOrderNumber: 'TEST-CPO-001',
          dimensions: purchase ? '1000 × 800 mm' : '300 × 200 × 150 mm',
          material: 'K=A',
          flute: 'BC',
          unitPrice: purchase ? '1.2345 元/张' : '未记录',
          amount: purchase ? '1234.5000000' : '未记录',
        },
        { productCode: '000124', orderNumber: 'TEST-SO-002', dimensions: '80 × 60 cm' },
      ],
      total: purchase ? '1334.5000000' : undefined,
      notes: '虚构测试数据，仅用于模板排版验收，不作为订货、出库或结算凭证。',
      signatures: template.signatures,
    },
    template,
  );
}
