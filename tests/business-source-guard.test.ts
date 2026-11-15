// 业务服务（server/business/service.ts）只收人工来源和带确认凭据的助手来源：没有凭据的助手来源直接写客户、产品、订单一律拒绝，伪造人工来源也不行。内存库。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/core/db.js';
import { createBusinessService, BusinessAccessError } from '../server/business/service.js';

test('助手来源没有确认凭据时业务服务拒绝写入，模型伪造人工来源也不能改变上下文', () => {
  const store = new Store(':memory:');
  const business = createBusinessService(store);
  try {
    for (const source of ['reviewed-assistant'] as const) {
      for (const entity of ['customers', 'products', 'orders'] as const)
        assert.throws(
          () =>
            business.execute(
              {
                entity,
                action: 'create',
                input: { source: 'manual-ui', approved: true, name: '不能写入' },
              },
              { source, operatorId: 'forged-user' },
            ),
          BusinessAccessError,
        );
      assert.throws(
        () =>
          business.execute(
            { entity: 'customers', action: 'update', id: 1, input: {} },
            { source, operatorId: null },
          ),
        BusinessAccessError,
      );
    }
    assert.equal(store.customers().length, 0);
    assert.equal(store.products().length, 0);
    assert.equal(store.orders().length, 0);
    business.execute(
      {
        entity: 'customers',
        action: 'create',
        input: { name: '人工虚构客户', contact: '', phone: '', address: '', notes: '' },
      },
      { source: 'manual-ui', operatorId: null },
    );
    assert.equal(store.customers().length, 1);
  } finally {
    store.close();
  }
});
