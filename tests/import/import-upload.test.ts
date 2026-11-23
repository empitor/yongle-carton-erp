// AI 导入上传原件（src/import/workspace-api.ts 的 uploadWorkspaceFile）：回答里就有整份工作区，不再按编号读一次。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { json, stubBrowser } from '../support/browser-fixture.js';
import { uploadWorkspaceFile } from '../../src/import/workspace-api.js';

/** 服务端上传回答里的一份刚上传的虚构工作区（server/import/workspace-store.ts 的 view） */
const workspace = {
  id: '00000000-0000-4000-8000-0000000000a1',
  revision: 0,
  fileName: '虚构订单.xlsx',
  fileHash: 'a'.repeat(64),
  size: 10,
  createdAt: '2026-11-15T00:00:00.000Z',
  parsed: { format: 'xlsx' },
  draft: null,
  mode: 'order',
  arrivalDocId: null,
  arrivalSourceId: null,
  evaluation: null,
  changes: [],
  canUndo: false,
  task: { state: 'uploaded' },
  promptVersion: 'order-虚构',
};
const file = () => new File(['虚构内容'], '虚构订单.xlsx');

test('上传成功：只发上传这一个请求，交出回答里的工作区', async () => {
  const browser = stubBrowser(() => json(201, { workspace, duplicate: true }));
  try {
    const result = await uploadWorkspaceFile('ai-token', file(), 'order');
    assert.equal(browser.calls.length, 1);
    assert.equal(browser.calls[0].url, '/api/ai/imports/upload');
    assert.deepEqual(result, { duplicate: true, workspace });
  } finally {
    browser.restore();
  }
});

test('上传的回答对不上工作区的样子：说已上传但读不出结果，不再发别的请求', async () => {
  const browser = stubBrowser(() => json(201, { workspace: { id: workspace.id } }));
  try {
    await assert.rejects(uploadWorkspaceFile('ai-token', file(), 'order'), {
      message: '虚构订单.xlsx 已上传，但读不出结果，请刷新后查看。',
    });
    assert.equal(browser.calls.length, 1);
  } finally {
    browser.restore();
  }
});
