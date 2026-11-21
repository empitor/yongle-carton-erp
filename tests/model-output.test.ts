// 模型交回的表、JSON 有出入时不丢整份结果。用例来自真实文件的识别失败，内容都改成了虚构的。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { draftFromForm, orderFormSchema, orderFormTool } from '../shared/import/order-form.js';
import { receiptFormTool, receiptFromForm } from '../server/import/receipt-form.js';
import { sameSpecification } from '../shared/core/domain.js';
import { isBadModelOutput, retryBadModelOutput } from '../server/ai/model-retry.js';
import { AiConnectionError } from '../server/ai/errors.js';
import { AppError } from '../server/core/errors.js';


test('订单识别填表：多给的栏目丢掉，数字转文字，拿不准的标待核对、写明原因，空着的算原件未提供', () => {
  const draft = draftFromForm(
    orderFormSchema.parse({
      header: { buyerName: '虚构客户', extra: 1 },
      lines: [{ productName: '虚构箱', quantity: 100, unit: '个', lineNo: 1 }],
      uncertain: [
        { line: 1, field: 'quantity', reason: '数字模糊' },
        { line: 9, field: 'quantity', reason: '没有这一行' },
      ],
      type: 'json_object',
    }),
  );
  assert.equal(draft.lines[0].quantity.value, '100');
  assert.equal(draft.lines[0].quantity.certainty, 'needs-review');
  assert.equal(draft.lines[0].quantity.note, '数字模糊');
  assert.equal(draft.lines[0].productName.certainty, 'recognized');
  assert.equal(draft.header.orderDate.value, null);
  assert.match(draft.warnings.join(), /第 9 行数量：没有这一行/, '对不上的“拿不准”转成提醒，不丢');
  assert.equal('extra' in draft.header, false);
});

test('订单识别填表：一行明细都没有、栏目类型不对仍然失败，不编造', () => {
  assert.equal(orderFormSchema.safeParse({ header: {}, lines: [] }).success, false);
  assert.equal(orderFormSchema.safeParse({ header: {} }).success, false);
  assert.equal(orderFormSchema.safeParse({ header: {}, lines: [{ quantity: { value: '1' } }] }).success, false);
  assert.equal(orderFormSchema.safeParse({ header: {}, lines: [{}], uncertain: [{ field: '没有这栏', reason: 'x' }] }).success, false);
});

test('识别的表就是工具参数：栏目用界面上的中文叫法，表里没有“把握程度”“依据”这类状态栏', () => {
  const tool = orderFormTool();
  const line = z
    .object({
      properties: z.object({
        lines: z.object({
          items: z.object({
            properties: z.record(z.string(), z.object({ description: z.string() })),
          }),
        }),
      }),
    })
    .parse(tool.parameters).properties.lines.items.properties;
  assert.match(line.unitPrice.description, /^单价（原币）/);
  assert.match(line.quantity.description, /^数量/);
  assert.equal(JSON.stringify(tool).includes('certainty'), false);
  assert.equal(JSON.stringify(receiptFormTool()).includes('certainty'), false);
});

test('到货单填表：多给的栏目丢掉，数字转文字，计价方式不认识不收，拿不准的写进提醒', () => {
  const parsed = receiptFromForm({
    supplierName: '虚构纸业',
    extra: 1,
    lines: [{ name: '虚构纸板', quantity: 2000, unitPrice: 2.5, lineNo: 1 }],
    uncertain: [{ line: 1, field: 'unitPrice', reason: '看不清小数点' }],
  });
  assert.equal(parsed.lines[0].quantity, '2000');
  assert.equal(parsed.lines[0].unitPrice, '2.5');
  assert.equal(parsed.lines[0].priceBasis, null);
  assert.deepEqual(parsed.warnings, ['第 1 行单价拿不准：看不清小数点']);
  assert.throws(() => receiptFromForm({ lines: [{ name: 'x', priceBasis: '平方' }] }));
});

test('模型输出不合格时自动重试一次；网络类错误和取消不重试', async () => {
  let calls = 0;
  const result = await retryBadModelOutput(async () => {
    calls++;
    if (calls === 1) orderFormSchema.parse({}); // 真实遇到过模型交回空表
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(calls, 2);

  calls = 0;
  await assert.rejects(
    retryBadModelOutput(async () => {
      calls++;
      orderFormSchema.parse({});
    }),
  );
  assert.equal(calls, 2, '最多两次');

  calls = 0;
  await assert.rejects(
    retryBadModelOutput(async () => {
      calls++;
      throw new AiConnectionError('network', '虚构网络错误', 502);
    }),
  );
  assert.equal(calls, 1, '网络错误不在这里重试');

  calls = 0;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    retryBadModelOutput(async () => {
      calls++;
      orderFormSchema.parse({});
    }, controller.signal),
  );
  assert.equal(calls, 1, '用户取消了不重试');

  assert.equal(isBadModelOutput(new AppError('虚构', 422, 'model-schema')), true);
  assert.equal(isBadModelOutput(new AppError('虚构', 422, 'validation')), false);
});



test('规格比较：排版和附加内容不同不算不同型号，尺寸不同才算', () => {
  for (const [a, b] of [
    ['66*25*7.5cm', '66×25×7.5 cm'],
    ['62*26*9cm', '62×26×9 cm / 按虚构文件打印'],
    ['71*41*44', '71×41×44 / 双瓦楞'],
    ['66*25*7.5cm', '660×250×75 mm'],
    ['71*41*44', '71×41×44 mm'],
    ['80*60*40cm', '80 x 60 x 40 厘米'],
  ])
    assert.equal(sameSpecification(a, b), true, a + ' / ' + b);
  for (const [a, b] of [
    ['71*41*44', '71*41*45'],
    ['80*60*40cm / K=A', '80*60*40cm / K=K'],
    ['甲款', '乙款'],
    ['80*60cm', '80*60*40cm'],
  ])
    assert.equal(sameSpecification(a, b), false, a + ' / ' + b);
});
