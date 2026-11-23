// 助手面板按结构读服务端发来的数据：订单任务卡的导入预览和导入结果、“看一眼页面”的命令，
// 都喂服务端真实生成的（识别导入流程、页面桥），页面要认得出。内存库或临时目录、虚构数据，模型用替身。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AssistantOrderWorkflow } from '../server/assistant/order-workflow.js';
import { AssistantPageBridge } from '../server/assistant/page-bridge.js';
import { recognize } from '../server/assistant/order-import-prepare.js';
import { attach } from '../server/assistant/order-import-intake.js';
import { onTask } from '../server/assistant/order-import-edits.js';
import { importedOrderOf, previewPlanOf } from '../src/assistant/order-task-view.js';
import { executePageCommand } from '../src/assistant/assistant-page.js';
import { createOrderWorkflowFixture, importOrders, importer } from './assistant-workflow-fixture.js';
import { imageFixture } from './import-fixtures.js';
import { actor } from './actor-fixture.js';

/** 会话里当前那份识别任务（页面从会话视图里拿到的样子） */
function activeTask(f: ReturnType<typeof createOrderWorkflowFixture>) {
  const workflow = f.manager.view(f.thread.id, importer).orderWorkflow;
  const task = workflow?.tasks.find((t) => t.id === workflow.activeId);
  assert.ok(task, '会话里有正在办的识别任务');
  return task;
}

test('订单任务卡：识别好、生成导入预览后，页面认得出预览（客户、明细、新建的产品）；正式导入后认得出建好的订单', async () => {
  const f = createOrderWorkflowFixture();
  try {
    let w = (await f.imports.upload(imageFixture(), '虚构订单.png', true)).workspace;
    w = await f.imports.analyze(w.id, { expectedRevision: w.revision }, undefined, importer);
    w = f.imports.edit(w.id, {
      expectedRevision: w.revision,
      operations: [{ op: 'set-header', field: 'taxRate', value: '0%', reason: '虚构核对税率' }],
    }, 'manual', importer);
    const wf = new AssistantOrderWorkflow(f.store, f.imports, f.execution, f.manager.attachments);
    await attach(wf, { workspaceId: w.id }, f.ctx());
    // 第 2 行建新产品：预览里有一份新建产品的资料
    await onTask(wf, 'order_import.match', { line: 2, createNew: true }, f.ctx());
    const c = f.ctx();
    const { state, task } = wf.selected(c);
    await recognize(wf, c, state, task);

    const shown = activeTask(f);
    assert.equal(importedOrderOf(shown.result), undefined, '还没导入');
    const plan = previewPlanOf(shown.preview);
    assert.ok(plan, '导入预览认得出');
    assert.equal(plan.customer.name, '聊天验收客户');
    assert.equal(plan.order.taxRate, 0);
    assert.deepEqual(
      plan.order.lines.map((l) => l.productName),
      ['聊天纸箱甲', '聊天纸箱乙'],
    );
    assert.equal(plan.products.length, 2);
    assert.equal(plan.products[1]?.mode, 'new');
    assert.ok(plan.total);

    await importOrders(wf, f.ctx());
    const imported = importedOrderOf(activeTask(f).result);
    assert.ok(imported, '导入结果认得出');
    assert.match(imported.orderNumber, /\S/);
    assert.ok(imported.orderId > 0);
  } finally {
    f.close();
  }
});

test('“看一眼页面”的命令：服务器真实发出的命令页面认得出；内容对不上时说清楚', async () => {
  const bridge = new AssistantPageBridge(),
    controller = new AbortController();
  let command: unknown;
  const pending = bridge.observe(
    { mode: 'region', region: 'table', offset: 0, limit: 5 },
    {
      actor,
      binding: '虚构会话',
      clientId: randomUUID(),
      threadId: randomUUID(),
      requestId: randomUUID(),
      check: () => actor,
      signal: controller.signal,
      emit: (_event, data) => (command = data),
    },
  );
  try {
    assert.ok(command, '服务器发出了命令');
    // 不是这个页面的命令、换了账号：认出来以后不看页面，什么都不交
    assert.equal(await executePageCommand(command, randomUUID(), actor.id, () => actor.id), undefined);
    assert.equal(await executePageCommand(command, randomUUID(), actor.id, () => '别的账号'), undefined);
    await assert.rejects(
      executePageCommand({ observe: {} }, randomUUID(), actor.id, () => actor.id),
      /命令内容对不上/,
    );
  } finally {
    controller.abort();
    await assert.rejects(pending, /已停止/);
  }
});
