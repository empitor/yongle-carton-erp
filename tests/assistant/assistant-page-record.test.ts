// 页面上“正在看的那条记录”在页面和模型之间换叫法（server/assistant/tools/page-record.ts）：页面报全站记录种类，
// 交给模型的快照换成助手模块名，模型照快照里的叫法查记录能查到；模型让页面看某条记录时换回全站种类。
// 内存库、虚构数据，模型用替身。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { actor } from '../support/actor-fixture.js';
import { assistantFixture } from '../support/assistant-fixture.js';
import { businessBase } from '../support/business-base-fixture.js';
import { turnFailure } from '../support/fake-deepseek.js';
import { observeForPage } from '../../server/assistant/tools/page-record.js';
import type { PageSnapshot } from '../../shared/assistant/index.js';

/** 页面交来的快照：开着某条记录（页面报的是全站记录种类） */
const snapshot = (route: string, module: string, id: number): PageSnapshot => ({
  route,
  capturedAt: '2026-11-21T08:00:00.000Z',
  title: '虚构页面',
  text: '',
  selected: [],
  dialogs: [],
  tables: [],
  feedback: [],
  record: { module, id, label: '虚构记录' },
  truncated: false,
});
/** 模型替身照快照里写的记录去查：从发给它的上下文里认出 record 的 module 和 id（JSON 里转了义） */
const RECORD_IN_CONTEXT = /\\"record\\":\{\\"module\\":\\"([a-z_]+)\\",\\"id\\":(\d+)/;

test('开着生产任务、原材料、成品库存品时问话：快照里是助手模块名，模型照着查能查到', async () => {
  const seen: string[] = [],
    failures: (string | null)[] = [];
  let step = 0;
  const f = assistantFixture([], {
    chat: (body) => {
      step++;
      if (step % 2 === 0) {
        failures.push(turnFailure(body));
        return { message: '已查到。', toolCalls: [] };
      }
      const found = RECORD_IN_CONTEXT.exec(JSON.stringify(body.messages));
      assert.ok(found, '发给模型的上下文里有当前记录');
      seen.push(found[1]);
      return { message: '', toolCalls: [{ name: 'records.get', args: { module: found[1], id: Number(found[2]) } }] };
    },
  });
  try {
    const base = businessBase(actor, f.store);
    const product = base.product({ name: '虚构纸箱' }),
      raw = base.raw({ name: '虚构纸板' }),
      finished = base.finished(product, { name: '虚构成品' });
    const task = base.flow.save('task', { date: '2026-10-20', productId: product.id, quantity: '10', unit: '只', orderIds: [], notes: '' }, actor);
    const open = [snapshot('#production', 'task', task.id), snapshot('#warehouse?kind=raw', 'stock_items', raw.id), snapshot('#warehouse?kind=finished', 'stock_items', finished.id)];
    for (const page of open)
      await f.say(f.manager.create(actor).id, '这条记录现在怎么样', { pageClientId: randomUUID(), pageSnapshot: page });
    assert.deepEqual(seen, ['production_tasks', 'raw_inventory', 'finished_inventory']);
    assert.deepEqual(failures, [null, null, null], '照快照里的叫法查，三次都查到了');
  } finally {
    f.close();
  }
});

test('模型让页面看某条记录：助手模块名换回页面上的全站记录种类，别的写法原样交给页面', () => {
  assert.deepEqual(observeForPage({ mode: 'record', record: { module: 'raw_inventory', id: 3 } }).record, { module: 'stock_items', id: 3 });
  assert.deepEqual(observeForPage({ mode: 'record', record: { module: 'production_tasks', id: 4 } }).record, { module: 'task', id: 4 });
  assert.deepEqual(observeForPage({ mode: 'record', record: { module: 'task', id: 4 } }).record, { module: 'task', id: 4 });
  assert.equal(observeForPage({ mode: 'summary' }).record, undefined);
});
