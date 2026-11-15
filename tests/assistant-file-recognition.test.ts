// 助手把附件交给识别服务（订单、供应商送货单）时，和页面走同一条“上传、引用、删除”链路，不另传文件；
// 识别出的数据完整交给助手。模型用假 DeepSeek，不发真实请求。
import { test } from 'node:test';
import { toolResultSent } from './fake-deepseek.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createOrderWorkflowFixture, workflowAnalysis } from './assistant-workflow-fixture.js';
import { z } from 'zod';
import { actor, readAs } from './assistant-fixture.js';
import { fakeAiSettings, forcedFunction, freshUserText } from './fake-deepseek.js';
import { docxFixture, xlsxFixture } from './import-fixtures.js';
import { PromptPresetManager } from '../server/ai/prompt-presets.js';
import { supplierDefaultPreset } from '../server/ai/default-prompts/supplier-delivery.js';
import { ReceiptAi } from '../server/import/receipt-ai.js';

const arrivalResult = {
  supplierName: '虚构纸板厂',
  reference: 'SH-TEST-01',
  purchaseNumber: null,
  date: '2026-11-01',
  notes: null,
  warnings: ['第二行单价看不清'],
  lines: [{ name: '虚构纸板', specification: '1200×800', quantity: '500', unit: '张', unitPrice: null }],
};
/** tool：助手这一轮要调的工具；模型替身先叫这个工具，拿到结果后回一句话 */
function setup(tool: { name: string; args: Record<string, unknown> } | null, finalText = '已按识别结果回答。') {
  const { settings, fake } = fakeAiSettings({
    chat: (body) => {
      const text = JSON.stringify(body.messages);
      if (text.includes('ERP 里的业务助手小甬和小勒')) {
        return tool && freshUserText(body) !== null
          ? { message: '交给识别服务', toolCalls: [tool] }
          : { message: finalText, toolCalls: [] };
      }
      // 识别是“填表”：按请求点名的工具分到货单和订单
      if (forcedFunction(body) === 'submit_delivery_note') return arrivalResult;
      return workflowAnalysis();
    },
  });
  const f = createOrderWorkflowFixture(undefined, { settings });
  const receiptPrompts = new PromptPresetManager(':memory:', supplierDefaultPreset);
  f.manager.connectExtras({ receiptAi: new ReceiptAi(f.store, settings, receiptPrompts) });
  const send = async (name: string, bytes: Buffer, text: string) => {
    const file = await f.manager.attachments.upload(f.thread.id, bytes, name, randomUUID(), actor);
    return f.send(text, [file.id]);
  };
  /** 模型看到的那份工具结果 */
  const toolResult = (name: string) => toolResultSent(fake.chatCalls(), name);
  const uploads = () => fake.calls.filter((c) => c.path === '/files' && c.method === 'POST');
  const deletes = () => fake.calls.filter((c) => c.path.startsWith('/files/') && c.method === 'DELETE');
  return {
    f,
    fake,
    send,
    toolResult,
    uploads,
    deletes,
    close() {
      receiptPrompts.close();
      f.close();
    },
  };
}

test('订单附件交给订单识别：识别只上传一次、用完删一次；助手拿到全部识别字段、核验结果和匹配候选', async () => {
  const s = setup({ name: 'order_import.start', args: {} });
  try {
    const word = docxFixture();
    await s.send('虚构订单.docx', word, '识别这张订单');
    // 这一轮带的附件先放进了用户消息（上传一份，留给后面几轮看）；识别服务自己再传一份，用完就删
    assert.equal(s.uploads().length, 2);
    for (const upload of s.uploads()) assert.deepEqual(upload.body.file?.bytes, word, '原样上传');
    assert.equal(s.deletes().length, 1);
    assert.equal(s.fake.files.size, 1, '识别那份用完就删，消息里那份还在');
    const result = s.toolResult('order_import.start');
    assert.ok(result, '识别结果交给了助手');
    const text = JSON.stringify(result);
    for (const key of ['draft', 'evaluation', 'customerCandidates', 'productCandidates']) assert.match(text, new RegExp(key));
  } finally {
    s.close();
  }
});

test('供应商送货单附件交给到货识别：识别只上传一次、用完删一次；助手拿到全部识别字段和提醒', async () => {
  const s = setup({ name: 'arrival.recognize', args: {} });
  try {
    await s.send('虚构送货单.xlsx', xlsxFixture(), '识别这张送货单');
    assert.equal(s.uploads().length, 2, '消息里一份、识别一份');
    for (const upload of s.uploads()) assert.equal(upload.body.purpose, 'user_data');
    assert.equal(s.deletes().length, 1);
    assert.equal(s.fake.files.size, 1, '识别那份用完就删，消息里那份还在');
    const line = z.looseObject({ quantity: z.unknown(), unitPrice: z.unknown() });
    const recognized = z.looseObject({ reference: z.unknown(), warnings: z.unknown(), lines: z.array(line) });
    const result = readAs(s.toolResult('arrival.recognize'), { recognized });
    assert.equal(result.recognized.reference, 'SH-TEST-01');
    assert.deepEqual(result.recognized.warnings, ['第二行单价看不清']);
    assert.equal(result.recognized.lines[0].quantity, '500');
    assert.equal(result.recognized.lines[0].unitPrice, null, '没识别出的也给出来');
  } finally {
    s.close();
  }
});

