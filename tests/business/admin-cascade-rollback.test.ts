// 本机管理员改有到货的采购明细、改被到货单用着的库存品时，连带改单据（server/flow/rules/maintenance-cascade.ts 的 detachPurchaseLines、
// alignStock，由保存入口 server/flow/stock/stock-entries.ts 交给采购库存在原位置调）和保存在同一个保存点：连带里出错整笔退回，
// 采购单、明细、库存品、到货单、关联表、审计、流水修订都不变。内存库、虚构数据。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Store } from '../../server/core/index.js';
import { FlowService } from '../../server/flow/index.js';
import { clerk, flowFixture, localAdmin } from '../support/flow-fixture.js';
import { orderedPurchase } from '../support/receive-fixture.js';

/** 连带会碰到的表，整张按写入顺序读出来 */
const TABLES = ['purchases', 'purchase_lines', 'stock_items', 'flow_documents', 'flow_refs', 'stock_movements', 'stock_movement_revisions', 'business_audit'];
const snapshot = (store: Store) =>
  Object.fromEntries(TABLES.map((t) => [t, store.db.prepare('SELECT * FROM ' + t + ' ORDER BY rowid').all().map((r) => ({ ...r }))]));

/** 一张已订货、已到货 400 张的采购单（到货单挂在明细上、用着 f.raw） */
function received() {
  const f = flowFixture(clerk);
  const p = orderedPurchase(f, clerk, ['1000']);
  p.receive('400', '虚构送货单-01');
  return { f, p };
}

/** 连带改完单据、重写关联表时出错（FlowService.maintenanceReferences，两种连带都在写回到货单之后调它） */
const failCascade = (t: { mock: { method: (o: object, name: string, impl: () => never) => unknown } }) =>
  t.mock.method(FlowService.prototype, 'maintenanceReferences', () => {
    throw new Error('虚构的连带出错');
  });

test('本机管理员改有到货的采购明细：解除到货关联的连带出错，整笔退回，什么都没变', (t) => {
  const { f, p } = received();
  try {
    const cur = p.current(),
      before = snapshot(f.store);
    failCascade(t);
    assert.throws(
      () =>
        f.flow.stock.savePurchase(
          {
            ...cur,
            status: cur.baseStatus,
            version: cur.version,
            lines: cur.lines.map((l) => ({ ...l, specification: '虚构改过的规格', length: 1200, width: 800, dimensionUnit: 'mm' })),
          },
          localAdmin(),
          cur.id,
        ),
      /虚构的连带出错/,
    );
    assert.deepEqual(snapshot(f.store), before);
  } finally {
    f.store.close();
  }
});

test('本机管理员改被到货单用着的库存品：对齐单据的连带出错，整笔退回，什么都没变', (t) => {
  const { f } = received();
  try {
    const item = f.flow.views.items(true, f.raw.id)[0],
      before = snapshot(f.store);
    failCascade(t);
    assert.throws(() => f.flow.stock.saveItem({ ...item, name: '虚构改名的纸板', version: item.version }, localAdmin(), item.id), /虚构的连带出错/);
    assert.deepEqual(snapshot(f.store), before);
  } finally {
    f.store.close();
  }
});

