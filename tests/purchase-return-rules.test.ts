// 采购退货本身的规则：扣库存、冲减采购已到货、超量和带退货冲销到货被拦，删到货单连带删退货（虚构数据、内存库）
// 加载识别导入、单据导出模块：删除到货单要它们登记的删除规则
import '../server/import/index.js';
import '../server/documents/index.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { localAdministratorActor } from '../server/core/local-administrator.js';
import { count } from '../server/core/index.js';
import { DatabaseMaintenanceService } from '../server/business/database-maintenance.js';
import { maker } from './finance-fixture.js';
import { returnFixture } from './finance-costing-fixture.js';

test('采购退货：扣库存、冲减采购已到货，超量和带退货冲销到货都拦下，冲销退货后恢复', () => {
  const f = returnFixture();
  try {
    const supervisor = { ...maker, superAdminMode: true, superAdminUntil: Date.now() + 600000 };
    const receivedUnits = () =>
      Number(f.flow.views.purchases(true, f.purchase.id)[0].lines[0].receivedUnits);
    assert.equal(f.ops.balance(f.raw.id), 10000);
    assert.throws(
      () => f.returns.create(maker, { arrivalId: f.received.id, date: '2026-02-08', reason: '虚构质量问题', requestId: 'return-too-much', lines: [{ lineIndex: 0, quantity: '11' }] }),
      /最多还能退 10/,
    );
    const back = f.returns.create(maker, {
      arrivalId: f.received.id,
      date: '2026-02-08',
      reason: '虚构质量问题',
      requestId: 'return-three',
      lines: [{ lineIndex: 0, quantity: '3' }],
    });
    assert.match(back.number, /^TH-20260208-0001$/);
    assert.equal(f.ops.balance(f.raw.id), 7000, '库存剩 7 张');
    assert.equal(receivedUnits(), 7000, '采购单已到货变成 7 张，供应商补货还能再到');
    assert.equal(f.returns.returnable(f.received.id).lines[0].returnable, '7');
    const arrival = f.flow.get(f.received.id);
    assert.throws(
      () => f.flow.reverse(f.received.id, { version: arrival.version, reason: '虚构冲销', acknowledged: true }, supervisor),
      /先撤销退货/,
    );
    assert.throws(() => f.returns.reverse(maker, back.id, { version: back.version, reason: '虚构' }), /超级管理员/);
    f.returns.reverse(supervisor, back.id, { version: back.version, reason: '虚构退错了' });
    assert.equal(f.ops.balance(f.raw.id), 10000, '冲销退货后库存加回来');
    assert.equal(receivedUnits(), 10000);
    assert.deepEqual(f.s.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    f.s.close();
  }
});

test('采购退货：数据维护删除到货单时，退货记录一起删掉，退货流水解除来源，外键干净', () => {
  const f = returnFixture();
  try {
    f.returns.create(maker, { arrivalId: f.received.id, date: '2026-02-08', reason: '虚构质量问题', requestId: 'return-goods', lines: [{ lineIndex: 0, quantity: '3' }] });
    const owner = localAdministratorActor({ ...maker, superAdminMode: true, superAdminUntil: Date.now() + 600000 });
    const maintenance = new DatabaseMaintenanceService(f.s);
    const selection = { module: 'arrival', items: [{ id: f.received.id, version: f.flow.get(f.received.id).version }] };
    const preview = maintenance.preview(selection, owner);
    maintenance.delete({ ...selection, requestId: randomUUID(), deletionDigest: preview.digest }, owner, 'session');
    assert.equal(count(f.s.db, 'SELECT count(*) AS n FROM purchase_returns'), 0);
    assert.equal(
      count(f.s.db, "SELECT count(*) AS n FROM stock_movements WHERE source_kind='purchase_return'"),
      0,
      '退货流水不再指向已删除的退货单',
    );
    assert.deepEqual(f.s.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    f.s.close();
  }
});
