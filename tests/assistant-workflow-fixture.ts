import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/db.js';
import { AssistantManager, assistantDefaultPreset } from '../server/assistant/manager.js';
import { AssistantOrderWorkflow } from '../server/assistant/order-workflow.js';
import { ImportManager } from '../server/import/manager.js';
import { ImportExecutionService, findImport } from '../server/business/import-execution.js';
import { PromptPresetManager } from '../server/ai/prompt-presets.js';
import { makeSettings, actor as baseActor } from './assistant-fixture.js';
import { headerFields, lineFields, blankField } from '../shared/order-draft.js';
import { customerSchema, productSchema, today } from '../shared/domain.js';
import { imageFixture, docxFixture, xlsxFixture, pdfFixture } from './import-fixtures.js';

const actor = { ...baseActor, permissions: ['business:edit', 'import:execute'] };
const field = (value: string) => ({
  value,
  sources: [],
  quote: value,
  certainty: 'recognized',
  note: '',
});
export const workflowAnalysis = () => ({
  header: {
    ...Object.fromEntries(headerFields.map((k) => [k, blankField()])),
    buyerName: field('聊天验收客户'),
    supplierName: field('宁波甬勒包装制品有限公司'),
    orderDate: field(today()),
    deliveryDate: field(today()),
    currency: field('人民币'),
    statedTotalQuantity: field('200'),
    statedTotalAmount: field('246.90'),
  },
  lines: ['聊天纸箱甲', '聊天纸箱乙'].map((name, i) => ({
    ...Object.fromEntries(lineFields.map((k) => [k, blankField()])),
    productName: field(name),
    specification: field(i ? '200×150×100' : '300×200×150'),
    quantity: field('100'),
    unit: field('只'),
    unitPrice: field('1.2345'),
    statedAmount: field('123.45'),
  })),
  warnings: [],
});
export function createOrderWorkflowFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'erp-assistant-orders-')),
    store = new Store(join(dir, 'erp.sqlite'));
  let recognitionCalls = 0,
    broken = false;
  const requests: any[] = [],
    replies: any[] = [];
  // 可控模型替身：生产代码不再替模型按关键词直接执行工具。
  const defaultControlReply = (req: any) => {
    const list = req.body.input || req.body.messages || [];
    const textOf = (m: any) =>
      typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content || '');
    const last = textOf(list.at(-1));
    if (last.includes('服务器当前上下文')) {
      const text = textOf(list.filter((m: any) => m.role === 'user').at(-2));
      if (/确认导入/.test(text))
        return {
          message: '调用正式导入服务',
          toolCalls: [{ name: 'order_import.execute', args: {} }],
        };
      if (/识别.*订单|订单.*识别/.test(text) && !/只阅读|解释|是什么/.test(text))
        return {
          message: '调用订单识别服务',
          toolCalls: [{ name: 'order_import.start', args: { recognitionType: 'order' } }],
        };
    }
    return { message: '已读取实际草稿，未执行其他修改。', toolCalls: [] };
  };
  const settings = makeSettings(async (req) => {
    requests.push(req);
    const global = JSON.stringify(req.body).includes('你是受控ERP助手');
    if (!global) {
      recognitionCalls++;
      if (broken) return { status: 503, body: { error: { message: 'fictional unavailable' } } };
    }
    const next = global ? replies.shift() || defaultControlReply(req) : workflowAnalysis(),
      reply = typeof next === 'function' ? next() : next;
    const output = JSON.stringify(reply);
    if ((req.body as any).stream) {
      req.onSseEvent?.({
        event: 'response.output_text.delta',
        data: JSON.stringify({ type: 'response.output_text.delta', delta: output }),
      });
      req.onSseEvent?.({
        event: 'response.completed',
        data: JSON.stringify({
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: output }],
              },
            ],
          },
        }),
      });
      return { status: 200, body: null, streamed: true };
    }
    return {
      status: 200,
      body: {
        status: 'completed',
        output: [
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: output }] },
        ],
      },
    };
  });
  const prompts = new PromptPresetManager(':memory:', assistantDefaultPreset),
    orderPrompts = new PromptPresetManager(':memory:'),
    manager = new AssistantManager(store, settings, prompts);
  const imports = new ImportManager({
    directory: join(dir, 'imports'),
    settings,
    promptPresets: orderPrompts,
    findImport: (id, hash) => findImport(store, id, hash),
    validateMapping: (m) => {
      if (m.customer.mode === 'existing')
        assert.equal(store.customer(m.customer.id)?.version, m.customer.version);
      for (const p of Object.values(m.products))
        if (p.mode === 'existing') assert.equal(store.product(p.id)?.version, p.version);
    },
  });
  const execution = new ImportExecutionService(store, imports, join(dir, 'archive'));
  manager.connectImports(imports, execution);
  store.saveCustomer(customerSchema.parse({ name: '聊天验收客户' }));
  const thread = manager.create(actor),
    events: any[] = [];
  const send = (
    text: string,
    attachmentIds: string[] = [],
    requestId = randomUUID(),
    who = actor,
  ) =>
    manager.chat(
      thread.id,
      { text, attachmentIds, requestId, profile: settings.view().active },
      who,
      'session',
      (event, data) => events.push({ event, data }),
      () => who,
    );
  const current = () => {
    const state = manager.view(thread.id, actor).orderWorkflow!;
    return imports.get(state.tasks.find((t) => t.id === state.activeId)!.workspaceId);
  };
  return {
    dir,
    store,
    settings,
    manager,
    imports,
    execution,
    thread,
    replies,
    requests,
    events,
    send,
    current,
    recognitionCalls: () => recognitionCalls,
    broken: (v: boolean) => (broken = v),
    close() {
      manager.registry.close();
      imports.close();
      prompts.close();
      orderPrompts.close();
      settings.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
