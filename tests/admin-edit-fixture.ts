// 管理员改单据、更正到货、排程测试共用的准备：一张已订货的采购单（纸板 10000 张）和它的到货、更正。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/core/db.js';
import { localAdministratorActor } from '../server/core/local-administrator.js';
import { OperationsRepository } from '../server/operations/repository.js';
import { shipOnDocDate } from './ship-date.js';
import { applyCorrection, previewCorrection, saveDoc } from './receive-fixture.js';
import { businessBase } from './business-base-fixture.js';
import { actor } from './actor-fixture.js';

export const owner = () => localAdministratorActor({ ...actor, role: 'super_admin' });

export function fixture(store = new Store(':memory:')) {
  const base = businessBase(actor, store),
    { ops, flow } = base;
  const supplier = base.supplier({ name: '虚构纠偏供应商' });
  const raw = base.raw({ name: '虚构纸板A' });
  const purchase = ops.savePurchase(
    {
      supplierId: supplier.id,
      status: '已订货',
      orderDate: '2026-10-01',
      lines: [
        { ...raw, stockItemId: raw.id, quantity: '10000', unitPrice: '2', priceBasis: 'quantity' },
      ],
    },
    actor,
  );
  const current = () =>
    new OperationsRepository(store).purchases(true).find((p) => p.id === purchase.id) ?? assert.fail('采购单 ' + purchase.id + ' 读不到');
  const confirm = (doc: { id: number }) => base.check(doc, shipOnDocDate(flow, doc.id));
  const receive = () =>
    confirm(
      saveDoc(flow, 
        'arrival',
        {
          date: '2026-10-20',
          supplierId: supplier.id,
          reference: randomUUID(),
          lines: [
            {
              stockId: raw.id,
              purchaseLineId: purchase.lines[0].id,
              item: raw,
              quantity: '10000',
              unitPrice: '2',
              priceBasis: 'quantity',
            },
          ],
        },
        actor,
      ),
    );
  const effective = () => current().receipts.find((r) => r.effective) ?? assert.fail('采购单上没有有效的到货记录');
  const input = (quantity: string) => ({
    expectedVersion: effective().version,
    reason: '虚构验收：历史录入错误',
    items: [{ index: 0, lineId: purchase.lines[0].id, quantity }],
  });
  const edit = (quantity: string) => {
    const key = effective().id,
      v = input(quantity),
      who = owner();
    const plan = previewCorrection(ops.store, key, v, who);
    const request = { ...v, previewDigest: plan.previewDigest, requestId: randomUUID() };
    return { key, request, result: applyCorrection(ops.store, key, request, who) };
  };
  const moves = () => store.db.prepare('SELECT * FROM stock_movements ORDER BY rowid').all();
  return { store, ops, flow, base, supplier, raw, purchase, current, confirm, receive, input, edit, moves };
}
