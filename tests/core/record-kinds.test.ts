// 归档标记（record_lifecycle）和永久删除墓碑（permanent_record_deletions）的记录种类不在建表里写死（升级第 22 步去掉了枚举），
// 由各模块登记（server/core/records/kinds/record-kinds.ts）：登记齐了现在能归档的十种，写入前核对，没登记的报错、不落库。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import '../../server/lifecycle/index.js';
import { AppError, Store, count, registerRecordKinds, rememberDeletedRecord } from '../../server/core/index.js';
import { assertRecordKind } from '../../server/core/records/kinds/record-kinds.js';
import { recordEntities } from '../../shared/business/index.js';
import { flowKinds } from '../../shared/core/index.js';
import { actor } from '../support/actor-fixture.js';

const unknown = '虚构的记录种类';

test('各模块加载后，客户、产品、订单、供应商、采购单、库存品和四种单据都登记成了能归档、能留墓碑的记录种类', () => {
  for (const kind of [...recordEntities, ...flowKinds.map((k) => 'flow_' + k)]) assert.doesNotThrow(() => assertRecordKind(kind), kind);
  assert.throws(() => assertRecordKind(unknown), (e) => e instanceof AppError && e.status === 500 && /不是登记过的记录种类/.test(e.message));
});

test('没登记的记录种类：归档标记和墓碑都写不进去，库里不留', () => {
  const store = new Store(':memory:');
  try {
    assert.throws(() => store.markArchived(unknown, 1, actor.id), /不是登记过的记录种类/);
    assert.throws(() => rememberDeletedRecord(store, actor, unknown, { id: 1, name: '虚构' }), /不是登记过的记录种类/);
    assert.equal(count(store.db, 'SELECT COUNT(*) FROM record_lifecycle'), 0);
    assert.equal(count(store.db, 'SELECT COUNT(*) FROM permanent_record_deletions'), 0);
    store.markArchived('flow_delivery', 1, actor.id);
    rememberDeletedRecord(store, actor, 'suppliers', { id: 2, name: '虚构供应商' });
    assert.equal(count(store.db, 'SELECT COUNT(*) FROM record_lifecycle'), 1);
    assert.equal(count(store.db, 'SELECT COUNT(*) FROM permanent_record_deletions'), 1);
  } finally {
    store.close();
  }
});

test('同一种记录只能由一个模块登记：别的模块再登记报错', () => {
  assert.throws(() => registerRecordKinds('业务总览', ['customers']), /已由客户产品订单登记/);
  assert.throws(() => registerRecordKinds('删除归档', ['flow_task']), /已由单据流转登记/);
  assert.doesNotThrow(() => registerRecordKinds('采购库存', ['suppliers']), '同一个模块重复登记自己的不报错');
});
