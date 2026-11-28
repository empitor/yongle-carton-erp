// 初始化清空规则的登记（server/core/records/deletion-rules.ts 的 registerReset）：同一个模块按顺序号分几段登记，
// 同模块同顺序号再登记一次要报错，不悄悄盖掉前一段（盖掉就少清一块表）。用基础模块已登记的那一段重登，不往登记表里加新条目。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppError, registerReset, resetParticipants } from '../../server/core/index.js';

test('同一个模块、同一个顺序号再登记清空规则：报错，原来那段照旧在', () => {
  const before = resetParticipants(['基础'], false).filter((r) => r.module === '基础');
  assert.deepEqual(before.map((r) => r.order), [49, 51]);
  assert.throws(
    () => registerReset({ module: '基础', order: 49, statements: ['DELETE FROM operation_requests'] }),
    (e: unknown) => e instanceof AppError && e.status === 500 && e.message === '基础模块的清空规则第 49 段已经登记过，不能再登记一次（会盖掉前一段）。',
  );
  const after = resetParticipants(['基础'], false).filter((r) => r.module === '基础');
  assert.deepEqual(after, before);
  assert.deepEqual(after[0].statements, ['DELETE FROM record_lifecycle']);
});
