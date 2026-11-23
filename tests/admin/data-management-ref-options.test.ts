import assert from 'node:assert/strict';
import test from 'node:test';
import { refOptions, type FieldContext } from '../../src/admin/field-rules.js';

test('数据管理关联字段原来关联的记录找不到时，补的“已找不到”只在这一格，不混进同一类的候选', () => {
  const refs = { customers: [{ value: '1', label: '虚构客户甲' }] };
  const ctx: FieldContext = { module: 'orders', record: null, refs };
  assert.equal(refOptions('customerId', 99, ctx).at(-1)?.label, '原来关联的记录（已找不到）');
  // 别的格子（另一项明细、下一次渲染）看到的候选还是读来的那些
  assert.deepEqual(
    refOptions('customerId', 1, ctx).map((o) => o.value),
    ['1'],
  );
  assert.equal(refs.customers.length, 1);
});
