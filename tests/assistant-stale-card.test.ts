// 卡片过期时说清哪几条记录变了（server/assistant/stale-card.ts）：按编号比出新加、删掉、改了的，最多列 5 条。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { staleMessage, staleRecords } from '../server/assistant/stale-card.js';

test('按编号比：改了的写现在的叫法，删掉的写原来的，新加的排在后面', () => {
  const before = { rows: [{ id: 1, number: 'A-1' }, { id: 2, name: '旧名' }, { id: 3, number: 'A-3' }] };
  const after = { rows: [{ id: 4, name: '新加的' }, { id: 2, name: '新名' }, { id: 1, number: 'A-1' }] };
  assert.deepEqual(staleRecords(before, after), ['新名', 'A-3', '新加的']);
});

test('没有单号和名称的记录写编号；记录变成别的值写“一条记录”；最多列 5 条', () => {
  assert.deepEqual(staleRecords({ a: { x: { id: 7, v: 1 } } }, { a: { x: { id: 7, v: 2 } } }), ['编号 7']);
  assert.deepEqual(staleRecords({ a: { id: 1, name: '甲' } }, { a: '文字' }), ['一条记录']);
  assert.deepEqual(staleRecords({ a: { id: 1, name: '甲' } }, { a: null }), ['甲']);
  const many = (v: number) => ({ rows: [1, 2, 3, 4, 5, 6].map((id) => ({ id, name: '记录' + id, v })) });
  assert.deepEqual(staleRecords(many(1), many(2)), ['记录1', '记录2', '记录3', '记录4', '记录5']);
  assert.deepEqual(staleRecords({ n: 1 }, { n: 2 }), []);
});

test('过期的那句话：列出变了的记录，没列出来就说相关记录变了', () => {
  assert.equal(staleMessage([{ id: 1, name: '甲' }], [{ id: 1, name: '乙' }]), '出卡片之后乙 变了，这张卡片已过期，没有执行；要办的话按最新数据重新出一张。');
  assert.equal(staleMessage(1, 2), '出卡片之后相关记录变了，这张卡片已过期，没有执行；要办的话按最新数据重新出一张。');
});
