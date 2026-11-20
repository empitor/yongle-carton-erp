// 安卓 App 返回键按层级关窗用的弹层登记（src/ui/back-layers.ts）
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { afterBackLayersClosed, closeTopLayer, hasBackLayer, registerBackLayer } from '../src/ui/back-layers.js';

let unregister: (() => void)[] = [];

function layer(name: string, closed: string[], busy = false) {
  const off = registerBackLayer({ close: () => closed.push(name), busy: () => busy });
  unregister.push(off);
  return off;
}
/** 等登记表在这一轮之后再看一眼（弹层都关了的通知要等同一轮里的开开关关走完） */
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

afterEach(() => {
  for (const off of unregister) off();
  unregister = [];
});

test('没有弹层时什么都不关', () => {
  assert.equal(closeTopLayer(), 'none');
  assert.equal(hasBackLayer(), false);
});

test('叠了两层时一次只关最上面一层', () => {
  const closed: string[] = [];
  layer('订单详情', closed);
  layer('附属窗口', closed);
  assert.equal(closeTopLayer(), 'closed');
  assert.deepEqual(closed, ['附属窗口']);
});

test('最上面一层正在提交时留在这一层，不关也不往下关', () => {
  const closed: string[] = [];
  layer('库存详情', closed);
  layer('编辑库存', closed, true);
  assert.equal(closeTopLayer(), 'stayed');
  assert.deepEqual(closed, []);
});

test('关掉注销后的层不再算', () => {
  const closed: string[] = [];
  const off = layer('助手窗口', closed);
  off();
  assert.equal(closeTopLayer(), 'none');
});

test('弹层都关掉后通知一次；只关了其中一层不通知', async () => {
  const told: string[] = [];
  const offA = layer('详情', []),
    offB = layer('窗口', []);
  afterBackLayersClosed(() => told.push('都关了'));
  offB();
  await nextTurn();
  assert.deepEqual(told, []);
  offA();
  await nextTurn();
  assert.deepEqual(told, ['都关了']);
  layer('又一层', [])();
  await nextTurn();
  assert.deepEqual(told, ['都关了']);
});

test('同一轮里关一层又开一层（换窗口）不算都关了；取消后不再通知', async () => {
  const told: string[] = [];
  const off = layer('旧窗口', []);
  const cancel = afterBackLayersClosed(() => told.push('都关了'));
  off();
  const offNew = layer('新窗口', []);
  await nextTurn();
  assert.deepEqual(told, []);
  cancel();
  offNew();
  await nextTurn();
  assert.deepEqual(told, []);
});
