import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/db.js';
import { OperationsService } from '../server/operations/service.js';
import { FinanceSettings } from '../server/finance/settings.js';
import { FinanceCosting } from '../server/finance/costing.js';
import { financePermissions } from '../shared/finance.js';

const maker = {
  id: 'maker',
  name: '虚构制单员',
  role: 'super_admin' as const,
  permissions: [...financePermissions, 'business:edit'],
};

test('算成本前列出要人填的期初和手工入库，填完才能算，算完不再要求', () => {
  const s = new Store(':memory:');
  try {
    const ops = new OperationsService(s);
    const item = ops.saveItem(
      { name: '虚构纸板', kind: 'raw', unit: '张', length: 1000, width: 800, dimensionUnit: 'mm' },
      maker,
    );
    const move = (date: string, quantity: string, version: number) =>
      ops.move(
        item.id,
        { action: 'in', quantity, date, notes: '虚构手工入库', expectedVersion: version, acknowledged: true, requestId: randomUUID() },
        maker,
      );
    move('2026-01-20', '10', item.version);
    new FinanceSettings(s).enable(maker, {
      period: '2026-02',
      taxpayer: 'general',
      version: 1,
      requestId: 'enable',
      rows: [],
    });
    const version = Number(s.db.prepare('SELECT version FROM stock_items WHERE id=?').get(item.id)!.version);
    move('2026-02-03', '5', version);
    const costing = new FinanceCosting(s);
    const need = costing.requirements(maker, { period: '2026-02' });
    assert.equal(need.isStart, true);
    assert.deepEqual(
      need.opening.map((o) => [o.name, o.quantity, o.unit]),
      [['虚构纸板', 10000, '张']],
    );
    assert.equal(need.valuations.length, 1);
    assert.equal(need.valuations[0].needsAmount, true);
    assert.throws(() => costing.run(maker, { period: '2026-02', requestId: 'empty' }), /期初成本/);
    costing.run(maker, {
      period: '2026-02',
      requestId: 'filled',
      opening: [{ stockId: item.id, unit: '张', quantity: 10000, amount: 10000 }],
      valuations: [
        { movementId: (need.valuations[0] as unknown as { id: string }).id, unit: '张', amount: 6000, reason: '虚构计价' },
      ],
    });
    const row = costing.list(maker, { period: '2026-02' }).rows[0];
    assert.equal(row.end_qty, 15000);
    assert.equal(row.end_cents, 16000);
    assert.equal(costing.requirements(maker, { period: '2026-02' }).done, true);
    const next = costing.requirements(maker, { period: '2026-03' });
    assert.deepEqual(next.opening, []);
    assert.deepEqual(next.valuations, []);
  } finally {
    s.close();
  }
});
