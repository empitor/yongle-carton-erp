// 删除引擎按“库存改回”删掉已入库的单据时，流水删了，涉及的库存品版本号要变：
// 删之前就打开着的核对窗口（核对入库、登记完工）的预览摘要按库存品版本算，带旧摘要确认要报“已变化”。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AppError, localAdministratorActor } from '../server/core/index.js';
import { OperationsService } from '../server/operations/index.js';
import { setup } from './delete-fixture.js';
import { actor } from './actor-fixture.js';

test('按“库存改回”删掉已入库的到货单：入的那个库存品版本号变了，删之前打开的核对入库带旧摘要确认被拒', () => {
  const f = setup(),
    owner = localAdministratorActor({ ...actor, role: 'super_admin' }),
    ops = new OperationsService(f.store);
  try {
    const board = ops.items(true).find((i) => i.name === '虚构纸板');
    assert.ok(board, '已入库的那张到货单建了这个原材料');
    // 待核对的那张也入“虚构纸板”：它的核对窗口在删除之前打开
    const opened = f.flow.preview(f.draft.id, actor);
    const selection = {
      module: 'arrival',
      items: [{ id: f.stocked.id, version: f.flow.get(f.stocked.id).version }],
      inventoryPolicy: 'recalculate',
    };
    const plan = f.service.preview(selection, owner);
    f.service.delete({ ...selection, requestId: randomUUID(), deletionDigest: plan.digest }, owner, 's');
    assert.equal(f.exists(f.stocked.id), false);
    const after = ops.items(true, board.id)[0];
    assert.equal(after.balanceUnits, 0, '入的 10 张跟着改回');
    assert.notEqual(after.version, board.version, '流水删了，库存品版本号要变');
    assert.throws(
      () => f.flow.confirm(f.draft.id, { previewDigest: opened.previewDigest, requestId: randomUUID(), acknowledged: true }, actor),
      (e: unknown) => e instanceof AppError && e.status === 409 && e.code === 'preview-changed',
    );
  } finally {
    f.store.close();
  }
});
