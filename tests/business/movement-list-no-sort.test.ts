// 库存流水列表（server/operations/router.ts 的 movementList）没有排序参数：流水只按业务日期倒序，
// 地址上带了 sort 也不认、不校验，和别的不认识的参数一样不管。内存库、虚构数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store } from '../../server/core/index.js';
import { createApp } from '../../server/app.js';
import { OperationsService } from '../../server/operations/index.js';
import { FlowService } from '../../server/flow/index.js';
import { pageActor } from '../support/actor-fixture.js';
import { listen, testProblems } from '../support/http-fixture.js';

const actor = pageActor({ id: 'movement-no-sort', name: '虚构仓管', permissions: ['business:edit'] });

test('流水列表带了 sort（哪怕是不认识的值）也照常回答，仍按业务日期新的在前', async () => {
  const store = new Store(':memory:'),
    ops = new OperationsService(store),
    flow = new FlowService(store);
  const item = ops.saveItem({ name: '虚构纸板', kind: 'raw', unit: '张' }, actor);
  for (const [date, notes] of [['2026-10-05', '虚构早'], ['2026-10-07', '虚构晚']]) {
    const current = ops.items(true, item.id)[0];
    flow.stock.move(item.id, { expectedVersion: current.version, requestId: randomUUID(), action: 'in', quantity: '1', date, notes, acknowledged: true }, actor);
  }
  const server = await listen(createApp(store, { problems: testProblems() }));
  try {
    const query = new URLSearchParams({ withMetrics: '1', page: '1', pageSize: '5', sort: '不认识的排序' });
    const r = await fetch(server.origin + '/api/warehouse/movements?' + query);
    assert.equal(r.status, 200);
    const body = z.object({ rows: z.array(z.object({ notes: z.string() })) }).parse(await r.json());
    assert.deepEqual(body.rows.map((m) => m.notes), ['虚构晚', '虚构早']);
  } finally {
    await server.close();
    store.close();
  }
});
