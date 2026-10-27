import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliveryPrint } from '../server/flow/printing.js';
test('送货单导出区分草稿/确认/冲销，所有业务文本转义并保留多产品型号与独立备注', () => {
  const d = {
      number: 'SH-TEST',
      status: 'draft',
      date: '2026-10-25',
      address: '测试收货地址',
      notes: '<script>不执行</script>',
      lines: [
        {
          orderNumber: 'O-1',
          productName: '产品一',
          specification: '规格一',
          quantity: '2',
          unit: '只',
          notes: '备注一',
        },
        {
          orderNumber: 'O-2',
          productName: '产品二',
          specification: '规格二',
          quantity: '3',
          unit: '箱',
          notes: '备注二',
        },
      ],
    },
    html = deliveryPrint(d, { name: '虚构客户' });
  assert.match(html, /草稿.*尚未确认发货/);
  assert.match(html, /规格二/);
  assert.match(html, /备注二/);
  assert.match(html, /&lt;script&gt;/);
  assert(!html.includes('<script>'));
  assert(!deliveryPrint({ ...d, status: 'confirmed' }, {}).includes('草稿 ·'));
  assert.match(deliveryPrint({ ...d, status: 'reversed' }, {}), /已冲销/);
});
