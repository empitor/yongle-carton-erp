// 采购退货（server/flow/arrival/returns.ts）：退货扣库存和已到货，撤销退货补回；挂账、编号、幂等、权限。内存库、虚构数据。
import { pageActor } from '../support/actor-fixture.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { listen } from '../support/http-fixture.js';
import {
  Store,
  localAdministratorActor,
  AppError,
  count,
  one,
  parseStoredJson,
  rows,
  type Actor,
} from '../../server/core/index.js';
import { businessBase } from '../support/business-base-fixture.js';
import { PurchaseReturns } from '../../server/flow/index.js';
import { flowRouter } from '../../server/flow/index.js';
import { DatabaseMaintenanceService } from '../../server/lifecycle/index.js';
import { today } from '../../shared/core/domain.js';
import { saveDoc, applyCorrection, previewCorrection } from '../support/receive-fixture.js';
import { z } from 'zod';
import type { NextFunction, Request, Response } from 'express';
import { AuthManager } from '../../server/accounts/index.js';
import { purchaseReturnDocumentSchema, purchaseReturnViewSchema } from '../../shared/business/index.js';
import { errorMessage } from '../../shared/core/error-message.js';

// 全部是虚构数据，只用内存库或临时目录。
const maker = pageActor({
  id: 'audit-maker',
  name: '虚构仓管',
  role: 'super_admin' as const,
  permissions: ['business:edit'],
});
const supervisor = () => ({ ...maker, superAdminMode: true, superAdminUntil: Date.now() + 600000 });
const owner = () =>
  localAdministratorActor({ ...maker, superAdminMode: true, superAdminUntil: Date.now() + 600000 });
/** 出错是不是给人看的业务错误、状态码对得上，说明合不合 pattern */
const failed = (status: number, pattern: RegExp) => (e: unknown) => e instanceof AppError && e.status === status && pattern.test(errorMessage(e));
/** 撤销退货补回库存的那笔流水挂的采购明细 */
const reversalMove = (s: Store, returnId: number) =>
  one(
    s.db,
    rows.stock_movements.pick({ purchase_line_id: true }),
    "SELECT purchase_line_id FROM stock_movements WHERE source_kind='purchase_return' AND source_id=? AND delta_units>0",
    String(returnId),
  ) ?? assert.fail('没有撤销退货补回库存的流水');

function fixture(quantities = ['10'], store = new Store(':memory:')) {
  const base = businessBase(maker, store),
    { store: s, ops, flow } = base,
    returns = new PurchaseReturns(s);
  const supplier = base.supplier({ name: '虚构供应商' });
  const raw = base.raw({ name: '虚构纸板', length: 1000, width: 800, dimensionUnit: 'mm' });
  const purchase = ops.savePurchase(
    {
      supplierId: supplier.id,
      orderDate: '2026-02-01',
      status: '已订货',
      lines: quantities.map((quantity) => ({
        ...raw,
        stockItemId: raw.id,
        quantity,
        unitPrice: '10.0000',
        priceBasis: 'quantity',
      })),
    },
    maker,
  );
  const confirm = (draft: { id: number }) => base.check(draft);
  const arrive = (items: { line?: number; quantity: string }[], date = '2026-02-05') =>
    confirm(
      saveDoc(flow, 
        'arrival',
        {
          supplierId: supplier.id,
          date,
          reference: '虚构到货-' + randomUUID(),
          lines: items.map((i) => ({
            stockId: raw.id,
            purchaseLineId: current().lines[i.line ?? 0].id,
            item: raw,
            quantity: i.quantity,
            unitPrice: '10.0000',
            priceBasis: 'quantity',
          })),
        },
        maker,
      ),
    );
  const ret = (arrivalId: number, quantity: string, requestId = randomUUID(), who: Actor = maker) =>
    returns.create(who, {
      arrivalId,
      date: '2026-02-08',
      reason: '虚构质量问题',
      requestId,
      lines: [{ lineIndex: 0, quantity }],
    });
  const current = () => flow.views.purchases(true, purchase.id)[0];
  const received = (lineId = purchase.lines[0].id) =>
    Number(current().lines.find((l) => l.id === lineId)?.receivedUnits ?? 0);
  const balance = () => ops.balance(raw.id);
  const remove = (module: string, id: number, version: number, inventoryPolicy = 'preserve') => {
    const maintenance = new DatabaseMaintenanceService(s),
      selection = { module, items: [{ id, version }], inventoryPolicy };
    const preview = maintenance.preview(selection, owner());
    return maintenance.delete({ ...selection, requestId: randomUUID(), deletionDigest: preview.digest }, owner(), 'session');
  };
  return { s, ops, flow, returns, supplier, raw, purchase, arrive, ret, current, received, balance, remove };
}

test('失效到货上的退货：不再扣到货、到货不能再退，也不能撤销退货', () => {
  const f = fixture();
  try {
    const a = f.arrive([{ quantity: '10' }]);
    const r = f.ret(a.id, '3');
    const input = () => ({
      expectedVersion: f.current().receipts.find((x) => x.effective)?.version,
      reason: '虚构更正',
      items: [{ index: 0, lineId: f.purchase.lines[0].id, quantity: '8' }],
    });
    // 造出“退货仍有效、原到货已被更正替代”的状态（现在有退货时不让更正，先把退货临时标成已撤销再更正）
    f.s.db.prepare("UPDATE purchase_returns SET status='reversed' WHERE id=?").run(r.id);
    const plan = previewCorrection(f.ops.store, 'flow-' + a.id, input(), maker);
    const corrected = applyCorrection(f.ops.store,
      'flow-' + a.id,
      { ...input(), previewDigest: plan.previewDigest, requestId: randomUUID() },
      maker,
    );
    f.s.db.prepare("UPDATE purchase_returns SET status='confirmed' WHERE id=?").run(r.id);
    assert.equal(f.received(), 8000, '替代到货 8 张，原到货上的旧退货不再重复扣');
    assert.equal(f.returns.returnable(Number(corrected.replacementFlowId)).lines[0].returnable, '8');
    assert.equal(f.returns.returnable(a.id).lines[0].returnable, '0', '失效到货不能再退');
    const before = f.balance();
    assert.throws(
      () => f.returns.reverse(supervisor(), r.id, { version: r.version, reason: '虚构冲销' }),
      failed(409, /原到货单已撤销或被更正替代/),
    );
    assert.equal(f.balance(), before, '冲销被拦下，库存不变');
  } finally {
    f.s.close();
  }
});

test('采购明细删掉换新后，退货按到货单现在的明细挂账，撤销不挂错行、不报外键错；删掉的明细编号不被新明细重用', () => {
  const f = fixture();
  try {
    const a = f.arrive([{ quantity: '10' }]);
    const r = f.ret(a.id, '3');
    const oldLineId = f.purchase.lines[0].id;
    const { id: _id, version: _v, ...spec } = f.raw;
    const p = f.current();
    // 管理员删掉原明细、另加一条：新明细拿新编号，删掉的编号不重用（AUTOINCREMENT）。
    const edited = f.flow.stock.savePurchase(
      {
        supplierId: f.supplier.id,
        orderDate: '2026-02-01',
        status: '已订货',
        version: p.version,
        lines: [{ ...spec, stockItemId: f.raw.id, quantity: '10', unitPrice: '10.0000', priceBasis: 'quantity' }],
      },
      owner(),
      f.purchase.id,
    );
    const newLineId = edited.lines[0].id;
    assert.ok(newLineId > oldLineId, '删掉的明细编号不被新明细重用');
    const row = one(f.s.db, rows.purchase_returns.pick({ document: true }), 'SELECT document FROM purchase_returns WHERE id=?', r.id);
    assert.ok(row, '退货单在库里');
    const stored = parseStoredJson(purchaseReturnDocumentSchema, row.document, 'purchase_returns.document 第 ' + r.id + ' 行');
    assert.equal(stored.lines[0].purchaseLineId, null, '退货单里的旧明细编号已解除');
    // 新明细补货 5 张：不能被旧退货扣成 2。
    f.arrive([{ quantity: '5' }], '2026-02-09');
    assert.equal(f.received(newLineId), 5000);
    f.returns.reverse(supervisor(), r.id, { version: f.returns.list(a.id)[0].version, reason: '虚构冲销' });
    const move = reversalMove(f.s, r.id);
    assert.equal(move.purchase_line_id, null, '冲销流水不挂到无关的新明细');
    assert.equal(f.received(newLineId), 5000);
    assert.deepEqual(f.s.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    f.s.close();
  }
});

test('退货单里残留的旧明细编号不影响扣减和撤销，撤销按到货单现在的明细挂账', () => {
  const f = fixture();
  try {
    const a = f.arrive([{ quantity: '10' }]);
    const r = f.ret(a.id, '3');
    f.s.db
      .prepare("UPDATE purchase_returns SET document=json_set(document,'$.lines[0].purchaseLineId',999) WHERE id=?")
      .run(r.id);
    assert.equal(f.received(), 7000);
    f.returns.reverse(supervisor(), r.id, { version: r.version, reason: '虚构冲销' });
    const move = reversalMove(f.s, r.id);
    assert.equal(Number(move.purchase_line_id), f.purchase.lines[0].id);
    assert.equal(f.received(), 10000);
  } finally {
    f.s.close();
  }
});

test('数据维护删采购单或库存品后，退货单引用同步清掉，撤销给出明确提示', () => {
  const f = fixture();
  try {
    const a = f.arrive([{ quantity: '10' }]);
    const r = f.ret(a.id, '3');
    f.remove('purchases', f.purchase.id, f.current().version);
    const doc = f.returns.list(a.id)[0];
    assert.equal(doc.lines[0].purchaseLineId, null);
    assert.ok(doc.version > r.version, '退货单版本号跟着变');
    assert.deepEqual(f.s.db.prepare('PRAGMA foreign_key_check').all(), []);
    const g = fixture();
    try {
      const b = g.arrive([{ quantity: '10' }]);
      const back = g.ret(b.id, '3');
      g.remove('stock_items', g.raw.id, g.ops.items(true, g.raw.id)[0].version);
      const kept = g.returns.list(b.id)[0];
      assert.equal(kept.lines[0].stockId, null);
      assert.throws(
        () => g.returns.reverse(supervisor(), back.id, { version: kept.version, reason: '虚构冲销' }),
        failed(409, /库存品已不存在/),
      );
    } finally {
      g.s.close();
    }
    // 采购单删了，退货仍可冲销，不会因外键报 500。
    f.returns.reverse(supervisor(), r.id, { version: doc.version, reason: '虚构冲销' });
    assert.equal(f.balance(), 10000);
  } finally {
    f.s.close();
  }
});

test('纸板退货不能填小数张', () => {
  const f = fixture();
  try {
    const a = f.arrive([{ quantity: '10' }]);
    assert.throws(() => f.ret(a.id, '2.5'), /整张/);
    assert.equal(f.balance(), 10000);
  } finally {
    f.s.close();
  }
});

test('退货不能让库存变负：到货 10 张、领用 8 张，退 3 张拦下，库存、退货单、流水都不变', () => {
  const f = fixture();
  try {
    const a = f.arrive([{ quantity: '10' }]);
    const it = f.ops.items(true, f.raw.id)[0];
    f.flow.stock.move(f.raw.id, { expectedVersion: it.version, requestId: randomUUID(), action: 'out', quantity: '8', date: '2026-02-06', notes: '虚构领料', acknowledged: true }, maker);
    const moves = count(f.s.db, 'SELECT count(*) n FROM stock_movements');
    assert.throws(() => f.ret(a.id, '3'), failed(409, /库存不足，不能退这么多：退货会让库存变成负数。/));
    assert.equal(f.balance(), 2000);
    assert.equal(f.returns.list(a.id).length, 0);
    assert.equal(count(f.s.db, 'SELECT count(*) n FROM stock_movements'), moves);
    assert.equal(f.received(), 10000);
  } finally {
    f.s.close();
  }
});

test('只有有效的到货能退：已撤销、已被更正替代的到货单不能新建退货；退货日期不能早于到货日期，也不能晚于今天', () => {
  const f = fixture(['10', '10']);
  try {
    const a = f.arrive([{ line: 0, quantity: '10' }]);
    const create = (arrivalId: number, date: string) =>
      f.returns.create(maker, { arrivalId, date, reason: '虚构质量问题', requestId: randomUUID(), lines: [{ lineIndex: 0, quantity: '1' }] });
    assert.throws(() => create(a.id, '2026-02-04'), /退货日期不能早于到货日期。/);
    assert.throws(() => create(a.id, '2099-01-01'), /退货日期不能晚于今天。/);
    const input = { expectedVersion: f.flow.get(a.id).version, reason: '虚构更正', items: [{ index: 0, quantity: '9' }] };
    const plan = previewCorrection(f.s, a.id, input, maker);
    applyCorrection(f.s, a.id, { ...input, previewDigest: plan.previewDigest, requestId: randomUUID() }, maker);
    const b = f.arrive([{ line: 1, quantity: '10' }]);
    f.flow.reverse(b.id, { version: f.flow.get(b.id).version, reason: '虚构登记重了', acknowledged: true }, supervisor());
    for (const id of [a.id, b.id])
      assert.throws(() => create(id, today()), failed(409, /只有已入库、没撤销的到货单可以退货。/));
    assert.equal(count(f.s.db, 'SELECT count(*) n FROM purchase_returns'), 0);
  } finally {
    f.s.close();
  }
});

test('供应商补货后再撤销退货会超过订购数量，拦下并说明', () => {
  const f = fixture();
  try {
    const a = f.arrive([{ quantity: '10' }]);
    const r = f.ret(a.id, '3');
    f.arrive([{ quantity: '3' }], '2026-02-09');
    assert.equal(f.received(), 10000);
    assert.throws(
      () => f.returns.reverse(supervisor(), r.id, { version: r.version, reason: '虚构冲销' }),
      failed(409, /超过采购数量 10/),
    );
    assert.equal(f.received(), 10000);
    assert.equal(f.returns.list(a.id)[0].status, 'confirmed');
    assert.equal(f.balance(), 10000);
  } finally {
    f.s.close();
  }
});

test('到货单连同退货被删除后，同一天的新退货不撞号', () => {
  const f = fixture(['10', '10']);
  try {
    const a1 = f.arrive([{ line: 0, quantity: '10' }]);
    const a2 = f.arrive([{ line: 1, quantity: '10' }]);
    const r1 = f.ret(a1.id, '1');
    const r2 = f.ret(a2.id, '1');
    assert.equal(r1.number, 'TH-20260208-0001');
    assert.equal(r2.number, 'TH-20260208-0002');
    f.remove('arrival', a1.id, f.flow.get(a1.id).version);
    const r3 = f.ret(a2.id, '1');
    assert.equal(r3.number, 'TH-20260208-0003');
    assert.notEqual(r3.id, r2.id);
  } finally {
    f.s.close();
  }
});

test('同一请求凭据换了内容拒绝，原样重试只退一次；别人用同一凭据是另一次退货', () => {
  const f = fixture();
  try {
    const a = f.arrive([{ quantity: '10' }]);
    const requestId = randomUUID();
    const first = f.ret(a.id, '3', requestId);
    assert.throws(() => f.ret(a.id, '2', requestId), failed(409, /不同内容/));
    assert.equal(f.ret(a.id, '3', requestId).id, first.id);
    assert.equal(f.balance(), 7000);
    // 请求凭据按账号分开：别人拿同一个凭据提交，是他自己的一次退货
    const theirs = f.ret(a.id, '3', requestId, { ...maker, id: 'other-maker', name: '虚构他人' });
    assert.notEqual(theirs.id, first.id);
    assert.equal(f.ret(a.id, '3', requestId).id, first.id);
    assert.equal(f.balance(), 4000);
    assert.equal(f.returns.list(a.id).length, 2);
  } finally {
    f.s.close();
  }
});

test('撤销退货后库存超过可保存上限时拦下', () => {
  const f = fixture();
  try {
    const a = f.arrive([{ quantity: '10' }]);
    const r = f.ret(a.id, '3');
    const before = f.balance(),
      delta = 999999999999 - before - 2000;
    f.s.db
      .prepare('INSERT INTO stock_movements(id,item_id,action,delta_units,before_units,after_units,source_kind,source_id,purchase_line_id,customer_order_id,date,notes,actor_id,actor_name,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(randomUUID(), f.raw.id, 'in', delta, before, before + delta, 'manual', null, null, null, '2026-02-09', '虚构大额盘盈', 'x', '虚构', new Date().toISOString());
    assert.throws(
      () => f.returns.reverse(supervisor(), r.id, { version: r.version, reason: '虚构冲销' }),
      failed(409, /超出可保存范围/),
    );
    assert.equal(f.returns.list(a.id)[0].status, 'confirmed');
  } finally {
    f.s.close();
  }
});

test('到货行没记实际入库数量时不可退，提示入库数量待核对，不拿申报数量顶替', () => {
  const f = fixture();
  try {
    const a = f.arrive([{ quantity: '10' }]);
    f.s.db
      .prepare("UPDATE flow_documents SET document=json_remove(document,'$.lines[0].stockedQuantity') WHERE id=?")
      .run(a.id);
    const line = f.returns.returnable(a.id).lines[0];
    assert.equal(line.stocked, null);
    assert.equal(line.returnable, '0');
    assert.match(line.hint, /入库数量待核对/);
    assert.throws(() => f.ret(a.id, '1'), failed(409, /待核对/));
  } finally {
    f.s.close();
  }
});

test('只读账号能看退货记录和可退数量，不能退货', async () => {
  const f = fixture();
  const viewer = pageActor({ id: 'viewer', name: '虚构只读', permissions: [] });
  // 账号库照常，只是谁在请求固定成这个只读账号
  class ViewerAuth extends AuthManager {
    override actor(): Actor {
      return viewer;
    }
  }
  const auth = new ViewerAuth(':memory:');
  const app = express();
  app.use(express.json());
  app.use('/flow', flowRouter(f.s, auth));
  app.use((e: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(e instanceof AppError ? e.status : 500).json({ message: errorMessage(e) });
  });
  const server = await listen(app);
  try {
    const base = server.origin;
    const a = f.arrive([{ quantity: '10' }]);
    f.ret(a.id, '3');
    const list = await fetch(base + '/flow/returns?arrivalId=' + a.id);
    assert.equal(list.status, 200);
    assert.equal(z.array(purchaseReturnViewSchema).parse(await list.json()).length, 1);
    const returnable = await fetch(base + '/flow/returns/returnable/' + a.id);
    assert.equal(returnable.status, 200);
    assert.equal(z.array(z.object({ returnable: z.string() })).parse(await returnable.json())[0].returnable, '7');
    const create = await fetch(base + '/flow/returns', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-erp-auth-token': auth.csrf },
      body: JSON.stringify({ arrivalId: a.id, date: '2026-02-08', reason: '虚构', requestId: randomUUID(), lines: [{ lineIndex: 0, quantity: '1' }] }),
    });
    assert.equal(create.status, 403);
  } finally {
    await server.close();
    auth.close();
    f.s.close();
  }
});
