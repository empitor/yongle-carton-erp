// 正式导入的回执（server/import/import-execution.ts）：回给页面和助手的只按 ImportReceipt 的几项给，
// 不带服务器上的原件路径和操作人；库里的导入记录照旧存着这两项。虚构文件、模型替身。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { one, parseStoredJson, rows } from '../server/core/index.js';
import { storedReceipt } from '../server/import/import-receipt.js';
import { createOrderWorkflowFixture, importer } from './assistant-workflow-fixture.js';

/** ImportReceipt（shared/import/import-plan.ts）的全部键 */
const receiptKeys = ['at', 'created', 'digest', 'executionId', 'fileHash', 'fileName', 'orderId', 'orderNumber', 'orderVersion', 'sourceId'];

test('正式导入回的回执、同一预览重交回的回执都没有服务器路径和操作人；库里的导入记录照旧存着原件位置', async () => {
  const f = createOrderWorkflowFixture();
  try {
    const w = await f.reviewedWorkspace({ poNumber: 'FICT-RECEIPT-001' });
    const preview = await f.execution.preview(w.id, { expectedRevision: w.revision }, importer);
    const input = { expectedRevision: preview.plan.source.revision, previewDigest: preview.previewDigest, acknowledged: true };
    const first = await f.execution.execute(w.id, input, importer);
    const again = await f.execution.execute(w.id, input, importer);
    for (const receipt of [first, again]) assert.deepEqual(Object.keys(receipt).sort(), receiptKeys);
    assert.deepEqual(again, first, '重交回的是同一份回执');
    const saved = one(f.store.db, rows.import_executions.pick({ document: true }), 'SELECT document FROM import_executions WHERE id=?', first.executionId);
    assert.ok(saved, '记了导入记录');
    const stored = parseStoredJson(storedReceipt, saved.document, 'import_executions.document');
    assert.ok(existsSync(stored.sourcePath), '库里记着原件归档的位置');
    assert.equal(stored.actor.id, importer.id);
  } finally {
    f.close();
  }
});
