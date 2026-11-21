// 财务选客户、供应商的下拉：走财务自己的读取地址，出纳这类纯财务账号也能读（全部是虚构数据，只用内存库）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { Store } from '../server/core/db.js';
import { customerSchema } from '../shared/core/domain.js';
import { OperationsService } from '../server/operations/index.js';
import { FinanceParties } from '../server/finance/parties.js';
import { maker } from './finance-fixture.js';
import { startHttp } from './http-fixture.js';

const password = 'Fictional-cashier-123';
const options = z.array(z.object({ id: z.number(), name: z.string() }));

/** 建两个客户、一个供应商（都是虚构的），返回编号 */
function parties(s: Store) {
  const kept = s.saveCustomer(customerSchema.parse({ name: '虚构客户甲' }));
  const archived = s.saveCustomer(customerSchema.parse({ name: '虚构客户乙' }));
  const supplier = new OperationsService(s).saveSupplier({ name: '虚构供应商' }, maker);
  return { kept: kept.id, archived: archived.id, supplier: supplier.id };
}

test('往来单位名单：出纳读得到客户、供应商；没有财务查看权限的账号被拒；种类不对 400', async () => {
  const s = new Store(':memory:');
  const h = await startHttp(s);
  try {
    const ids = parties(s);
    await h.enterSuperMode();
    for (const [name, level] of [['虚构出纳', 'cashier'], ['虚构业务员', 'staff']])
      assert.equal((await h.send('/auth/users', { name, password, level }, h.cookie)).status, 201, level);
    const cashier = await h.login('虚构出纳', password),
      staff = await h.login('虚构业务员', password);
    const read = async (kind: string) => {
      const r = await h.send('/finance/parties?kind=' + kind, undefined, cashier);
      assert.equal(r.status, 200, kind);
      return options.parse(await r.json());
    };
    assert.deepEqual(
      (await read('customer')).map((p) => p.name).sort(),
      ['虚构客户乙', '虚构客户甲'].sort(),
    );
    assert.deepEqual(await read('supplier'), [{ id: ids.supplier, name: '虚构供应商' }]);
    assert.equal((await h.send('/finance/parties?kind=customer', undefined, staff)).status, 403, '业务人员没有财务查看权限');
    assert.equal((await h.send('/finance/parties?kind=order', undefined, cashier)).status, 400);
  } finally {
    await h.close();
    s.close();
  }
});

test('往来单位名单不列已归档的单位', () => {
  const s = new Store(':memory:');
  try {
    const ids = parties(s);
    s.markArchived('customers', ids.archived, maker.id);
    assert.deepEqual(new FinanceParties(s).options(maker, { kind: 'customer' }), [{ id: ids.kept, name: '虚构客户甲' }]);
  } finally {
    s.close();
  }
});
