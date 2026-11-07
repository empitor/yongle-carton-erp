// 模型返回的 JSON 有出入时不丢整份结果。用例来自真实文件的识别失败，内容都改成了虚构的。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analysisSchema, tidyAnalysis } from '../shared/order-draft.js';
import { markAnalysisSchema, tidyMarkAnalysis } from '../shared/shipping-mark.js';
import { supplierAnalysisSchema, tidySupplierAnalysis } from '../server/flow/receipt-ai.js';
import { dropFormatEcho } from '../shared/model-output.js';
import { sameSpecification } from '../shared/domain.js';
import { deliveryCandidates } from '../shared/warehouse-delivery.js';
import { dropModelPreamble, isBadModelOutput, parseModelJson, retryBadModelOutput } from '../server/ai/model-retry.js';
import { AiConnectionError } from '../server/ai/connection-error.js';
import { ImportError } from '../server/import/errors.js';

const field = (value: unknown, extra: object = {}) => ({
  value,
  sources: [],
  quote: '',
  certainty: 'recognized',
  note: '',
  ...extra,
});
const analysis = (extra: object = {}) => ({
  header: { buyerName: field('虚构客户') },
  lines: [{ productName: field('虚构箱'), quantity: field('100'), unit: field('个') }],
  warnings: [],
  ...extra,
});

test('模型把 response_format 回显到顶层时不算错，其他同名字段不动', () => {
  assert.deepEqual(dropFormatEcho({ type: 'json_object', a: 1 }), { a: 1 });
  assert.deepEqual(dropFormatEcho({ type: 'json_schema', a: 1 }), { a: 1 });
  assert.deepEqual(dropFormatEcho({ type: '客户订单', a: 1 }), { type: '客户订单', a: 1 });
  assert.equal(dropFormatEcho('文字'), '文字');
});

test('订单识别：回显的 type 不再让整份结果失败（真实文件上的失败）', () => {
  const raw = analysis({ type: 'json_object' });
  assert.equal(analysisSchema.safeParse(raw).success, false, '严格校验本身没有放宽');
  const parsed = analysisSchema.parse(tidyAnalysis(raw));
  assert.equal(parsed.lines[0].productName.value, '虚构箱');
});

test('订单识别：多余字段丢掉，数字转文字，认不出的把握程度当待核对', () => {
  const raw = analysis({ sql: 'DELETE FROM orders', total: 1 }) as any;
  raw.header.extra = field('x');
  raw.lines[0].lineNo = 1;
  raw.lines[0].quantity = field(2000, { certainty: 'sure', confidence: 0.9 });
  raw.lines[0].unitPrice = 1.39;
  raw.lines[0].unit = '个';
  raw.warnings = ['虚构提醒', 3, { a: 1 }, ''];
  const parsed = analysisSchema.parse(tidyAnalysis(raw));
  assert.equal(parsed.lines[0].quantity.value, '2000');
  assert.equal(parsed.lines[0].quantity.certainty, 'needs-review');
  assert.equal(parsed.lines[0].unitPrice.value, '1.39');
  assert.equal(parsed.lines[0].unitPrice.certainty, 'needs-review');
  assert.equal(parsed.lines[0].unit.value, '个');
  assert.deepEqual(parsed.warnings, ['虚构提醒', '3', '{"a":1}']);
  assert.equal('sql' in parsed, false);
});

test('订单识别：真正缺内容的仍然失败，不编造', () => {
  assert.equal(analysisSchema.safeParse(tidyAnalysis({ header: {}, lines: [], warnings: [] })).success, false);
  assert.equal(analysisSchema.safeParse(tidyAnalysis({ header: {} })).success, false);
  assert.equal(tidyAnalysis('不是对象'), '不是对象');
  // 模型说人工改过，不能被清理层洗掉，manager 会拒绝
  const forged = analysis() as any;
  forged.lines[0].quantity = field('1', { certainty: 'user-modified' });
  assert.equal(analysisSchema.parse(tidyAnalysis(forged)).lines[0].quantity.certainty, 'user-modified');
});

test('唛头：多余字段、数字、单位写法都能整理，认不出的单位当未知', () => {
  const parsed = markAnalysisSchema.parse(
    tidyMarkAnalysis({
      marks: [
        {
          itemCode: 'FAKE-1',
          cartonLength: 53,
          dimensionUnit: 'CM',
          dimensionBasis: '内径',
          page: '1',
          confidence: 0.8,
        },
        { itemCode: 'FAKE-2', dimensionUnit: '英寸' },
      ],
      summary: '多余',
    }),
  );
  assert.equal(parsed.marks[0].cartonLength, '53');
  assert.equal(parsed.marks[0].dimensionUnit, 'cm');
  assert.equal(parsed.marks[0].dimensionBasis, 'unknown');
  assert.equal(parsed.marks[0].page, 1);
  assert.equal(parsed.marks[1].dimensionUnit, null, '不猜单位');
  assert.equal(parsed.marks[1].page, 1, '没写页码按顺序');
  assert.deepEqual(parsed.warnings, []);
});

test('到货单：多余字段丢掉，数字转文字，计价方式认不出当未知', () => {
  const parsed = supplierAnalysisSchema.parse(
    tidySupplierAnalysis({
      supplierName: '虚构纸业',
      extra: 1,
      lines: [{ name: '虚构纸板', quantity: 2000, unitPrice: 2.5, priceBasis: '平方', lineNo: 1 }],
    }),
  );
  assert.equal(parsed.lines[0].quantity, '2000');
  assert.equal(parsed.lines[0].unitPrice, '2.5');
  assert.equal(parsed.lines[0].priceBasis, null);
});

test('模型输出不合格时自动重试一次；网络类错误和取消不重试', async () => {
  let calls = 0;
  const result = await retryBadModelOutput(async () => {
    calls++;
    if (calls === 1) analysisSchema.parse(tidyAnalysis({})); // 真实遇到过模型返回空对象
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(calls, 2);

  calls = 0;
  await assert.rejects(
    retryBadModelOutput(async () => {
      calls++;
      analysisSchema.parse({});
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
      analysisSchema.parse({});
    }, controller.signal),
  );
  assert.equal(calls, 1, '用户取消了不重试');

  assert.equal(isBadModelOutput(new ImportError('虚构', 422, 'model-schema')), true);
  assert.equal(isBadModelOutput(new ImportError('虚构', 422, 'validation')), false);
});

test('解析模型文字：默认只去围栏，识别类才容忍夹杂的说明文字', () => {
  assert.deepEqual(parseModelJson('{"a":1}'), { a: 1 });
  assert.deepEqual(parseModelJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.throws(() => parseModelJson('结果如下：{"a":1} 请核对'), '助手回复不能从文字里挖 JSON');
  assert.deepEqual(parseModelJson('结果如下：{"a":1} 请核对', true), { a: 1 });
  assert.throws(() => parseModelJson('没有 JSON', true));
});

test('模型一次回两个连着的 JSON 时只取第一个，夹文字的不算', () => {
  assert.deepEqual(parseModelJson('{"a":1,"s":"}{"}{"a":2}'), { a: 1, s: '}{' });
  assert.deepEqual(parseModelJson('{"a":1}\n\n{"a":2}\n{"a":3}'), { a: 1 });
  assert.throws(() => parseModelJson('比如 {"a":1}{"a":2}'));
  assert.throws(() => parseModelJson('{"a":1}{"a":'));
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

test('服务商夹在正文前的安全判定和思考过程要去掉', () => {
  assert.deepEqual(parseModelJson('[分类]其他\n[规则]无</ds_safety>{"a":1}'), { a: 1 });
  assert.deepEqual(parseModelJson('<think>想一想 {"x":0}</think>\n{"a":1}'), { a: 1 });
  assert.deepEqual(parseModelJson('[分类]其他</ds_safety>\n```json\n{"a":1}\n```'), { a: 1 });
  assert.equal(dropModelPreamble('[分类]其他</ds_safety>你好'), '你好');
  assert.equal(dropModelPreamble('没有前缀的普通文字'), '没有前缀的普通文字');
});

test('页面建送货单：订单规格和成品档案只是写法不同，也要能关联订单', () => {
  const orders = [{ id: 1, number: '虚构单', customerId: 1, status: '已确认', lines: [{ id: 2, productId: 3, unit: '个', quantity: 10, specification: '66*25*7.5cm' }] }];
  assert.equal(deliveryCandidates({ productId: 3, unit: '个', specification: '66 × 25 × 7.5 cm' }, 1, orders).length, 1);
  assert.equal(deliveryCandidates({ productId: 3, unit: '个', specification: '88 × 15 × 6 cm' }, 1, orders).length, 0);
});
