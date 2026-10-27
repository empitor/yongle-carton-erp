import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Store } from '../server/db.js';
import { createApp } from '../server/app.js';
import { OperationsService } from '../server/operations/service.js';
import { today } from '../shared/domain.js';
import { monthsBefore } from '../shared/date-ranges.js';
import { initialMovementRange, movementFilterSchema } from '../shared/movement-filters.js';
import { ListFilters, Pagination, TableRegion } from '../src/ui/ListLayout.js';
import DateRangeFilter from '../src/DateRangeFilter.js';
import WarehouseNavigation from '../src/WarehouseNavigation.js';
test('流水默认两自然月，支持月末/闰年、全部日期和自定义，旧流水不是自动归档', () => {
  assert.deepEqual(initialMovementRange(new URLSearchParams(), '2026-10-25'), {
    preset: '2',
    start: '2026-08-25',
    end: '2026-10-25',
  });
  assert.equal(
    initialMovementRange(new URLSearchParams('range=1'), '2024-03-31').start,
    '2024-02-29',
  );
  assert.equal(
    initialMovementRange(new URLSearchParams('range=3'), '2026-01-31').start,
    '2025-10-31',
  );
  assert.deepEqual(initialMovementRange(new URLSearchParams('range=all'), '2026-10-25'), {
    preset: 'all',
    start: '',
    end: '',
  });
  assert.deepEqual(
    initialMovementRange(new URLSearchParams('range=custom&start=2026-07-01&end=2026-07-31')),
    { preset: 'custom', start: '2026-07-01', end: '2026-07-31' },
  );
  assert.equal(movementFilterSchema.safeParse({ start: '2026-02-30' }).success, false);
  assert.equal(
    movementFilterSchema.safeParse({ start: '2026-03-01', end: '2026-02-01' }).success,
    false,
  );
});
test('客户订单与采购复用相同筛选结构；日期处于第二行，仓库每次只选中一个视图，分页边界正确', () => {
  for (const label of ['下单日期', '采购日期', '业务日期']) {
    const html = renderToStaticMarkup(
      h(ListFilters, {
        search: '',
        onSearch: () => {},
        placeholder: '查询',
        onReset: () => {},
        dates: h(DateRangeFilter, {
          label,
          preset: '2',
          start: '2026-08-25',
          end: '2026-10-25',
          change: () => {},
        }),
      }),
    );
    assert.ok(html.indexOf('list-filters-primary') < html.indexOf('list-filters-secondary'));
    assert.ok(html.includes(label + '范围'));
    assert.ok(html.includes('重置筛选'));
  }
  for (const view of ['raw', 'finished', 'flows'] as const) {
    const html = renderToStaticMarkup(h(WarehouseNavigation, { view, onChange: () => {} }));
    assert.equal((html.match(/aria-selected="true"/g) || []).length, 1);
    assert.ok(html.includes('出入库流水'));
  }
  const first = renderToStaticMarkup(
    h(Pagination, { page: 1, total: 26, pageSize: 25, onChange: () => {} }),
  );
  assert.match(first, /aria-label="上一页" disabled/);
  assert.ok(!first.includes('aria-label="下一页" disabled'));
  const last = renderToStaticMarkup(
    h(Pagination, { page: 2, total: 26, pageSize: 25, onChange: () => {} }),
  );
  assert.match(last, /aria-label="下一页" disabled/);
  assert.ok(
    renderToStaticMarkup(h(TableRegion, { children: '完整字段' })).includes('tabindex="0"'),
  );
});
test('流水HTTP组合筛选/边界/历史查询不改变余额、审计或生命周期，数据重开后完整保留', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-flow-ui-')),
    file = join(dir, 'erp.sqlite'),
    store = new Store(file),
    service = new OperationsService(store),
    actor = { id: 'flow-test', name: '虚构仓库验收', permissions: ['business:edit'] };
  const date = today(),
    start = monthsBefore(date, 2),
    old = monthsBefore(date, 3);
  const raw = service.saveItem({ name: '测试原材料纸板', kind: 'raw', unit: '张' }, actor),
    finished = service.saveItem({ name: '测试成品纸箱', kind: 'finished', unit: '只' }, actor);
  const move = (id: number, action: string, quantity: string, date: string, notes: string) => {
    const item = store.stock_items().find((r) => r.id === id);
    return service.move(
      id,
      {
        expectedVersion: item.version,
        requestId: randomUUID(),
        action,
        quantity,
        date,
        notes,
        acknowledged: true,
      },
      actor,
    );
  };
  move(raw.id, 'in', '50', old, '历史原材料入库');
  move(raw.id, 'out', '5', start, '边界原材料出库');
  move(raw.id, 'adjust', '40', date, '人工盘点');
  move(finished.id, 'in', '100', old, '历史成品入库');
  move(finished.id, 'out', '10', date, '成品出库');
  const supplier = service.saveSupplier({ name: '流水测试供应商' }, actor),
    p = service.savePurchase(
      {
        supplierId: supplier.id,
        orderDate: date,
        status: '已订货',
        lines: [
          { name: raw.name, stockItemId: raw.id, quantity: '3', unit: '张', unitPrice: '1.2345' },
        ],
      },
      actor,
    );
  service.receive(
    p.id,
    {
      expectedVersion: p.version,
      requestId: randomUUID(),
      reference: 'UI-DELIVERY',
      date,
      items: [{ lineId: p.lines[0].id, quantity: '3' }],
      acknowledged: true,
    },
    actor,
  );
  for (let i = 0; i < 26; i++) move(raw.id, 'in', '1', date, '测试批次' + i);
  const before = {
    movements: store.db.prepare('SELECT * FROM stock_movements ORDER BY rowid').all(),
    audit: store.db.prepare('SELECT * FROM business_audit ORDER BY rowid').all(),
    life: store.db.prepare('SELECT * FROM record_lifecycle ORDER BY rowid').all(),
    items: store.stock_items(),
  };
  const server = createApp(store).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + (server.address() as any).port + '/api/warehouse/movements';
  const get = async (q = '') => {
    const r = await fetch(base + q);
    assert.equal(r.status, 200);
    return r.json();
  };
  try {
    assert.equal((await get('?start=' + start + '&end=' + date)).length, 30);
    assert.equal((await get()).length, 32);
    assert.equal(
      (
        await get(
          '?kind=raw&action=out&start=' +
            start +
            '&end=' +
            start +
            '&q=' +
            encodeURIComponent('边界'),
        )
      ).length,
      1,
    );
    assert.equal((await get('?kind=finished&action=out&start=' + start)).length, 1);
    const received = await get('?kind=raw&action=purchase&q=' + p.number);
    assert.equal(received.length, 1);
    assert.equal(received[0].delta, '3');
    assert.equal((await get('?action=adjust&q=' + encodeURIComponent(actor.name))).length, 1);
    assert.equal((await get('?start=' + old + '&end=' + old)).length, 2);
    assert.equal((await get('?kind=finished&action=purchase')).length, 0);
    for (const q of [
      '?action=delete',
      '?kind=unknown',
      '?start=2026-02-30',
      '?start=' + date + '&end=' + old,
    ])
      assert.equal((await fetch(base + q)).status, 400);
    assert.deepEqual(
      {
        movements: store.db.prepare('SELECT * FROM stock_movements ORDER BY rowid').all(),
        audit: store.db.prepare('SELECT * FROM business_audit ORDER BY rowid').all(),
        life: store.db.prepare('SELECT * FROM record_lifecycle ORDER BY rowid').all(),
        items: store.stock_items(),
      },
      before,
    );
    const copy = new Store(file);
    assert.equal(copy.db.prepare('SELECT COUNT(*) n FROM stock_movements').get()!.n, 32);
    assert.equal(copy.stock_items().find((r) => r.id === raw.id).quantity, '69');
    copy.close();
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
