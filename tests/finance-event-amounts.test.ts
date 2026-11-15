// 财务事件的金额：启用前单据、0 元单据、缺数量还是缺价格、更正单直接入账（全部是虚构数据，只用内存库）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../server/core/db.js';
import { FinanceEvents } from '../server/finance/events.js';
import { FinanceReports } from '../server/finance/reports.js';
import { FinanceMonthly } from '../server/finance/monthly.js';
import { FinanceEventVouchers } from '../server/finance/event-voucher.js';
import { FinanceEventHandling } from '../server/finance/event-handling.js';
import { FinanceClosing } from '../server/finance/closing.js';
import { maker, newSettings, physical, deliveryDoc, arrivalDoc, event, eventsStep, setDoc } from './finance-fixture.js';
import { evaluateSource } from '../server/finance/event-evaluate.js';
import { readSnapshot } from '../server/finance/source-snapshot.js';
import { count } from '../server/core/index.js';

test('启用前的单据启用后被改（补价格、编辑、冲销）：仍算启用前，不生成事件，结账不卡', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s, '2026-03');
    const events = new FinanceEvents(s);
    physical(s, 1, 'delivery', '2026-02-10', deliveryDoc('1'));
    physical(s, 2, 'delivery', '2026-02-11', deliveryDoc('1'));
    events.sync(maker, { requestId: 'scan-1' });
    assert.equal(event(s, 1).status, 'before_opening');
    // 改单据内容（版本加一）：setDoc 只改给的那一项
    const reprice = (price: string) => setDoc(s, 1, '$.lines[0].unitPriceExact', price);
    reprice('120.0000');
    s.db.prepare("UPDATE flow_documents SET version=version+1,status='reversed' WHERE id=2").run();
    events.sync(maker, { requestId: 'scan-2' });
    assert.equal(event(s, 1).status, 'before_opening', '改价后仍是启用前');
    assert.equal(event(s, 2).status, 'before_opening', '冲销后仍是启用前');
    assert.equal(
      count(s.db, "SELECT count(*) FROM fin_events WHERE status<>'before_opening'"),
      0,
      '没生成日期早于启用月的事件',
    );
    assert.equal(eventsStep(s, '2026-03').ok, true, '结账的事件步骤放行');
    // 结账检查多一条不卡结账的提醒：核对期初往来，列出这两张
    const openingStep = () => {
      const step = new FinanceClosing(s).check(maker, { period: '2026-03' }).steps.find((x) => x.key === 'opening');
      assert.ok(step && 'items' in step, '结账检查有“核对期初往来”这一步');
      return step;
    };
    assert.equal(openingStep().blocking, false);
    assert.deepEqual(
      openingStep().items?.map((r) => [r.source_id, r.number, r.problem]),
      [
        ['1', 'FICT-1', '启用前的单据启用后改过单价、数量等，请核对期初往来。'],
        ['2', 'FICT-2', '启用前的单据启用后被冲销或更正，请核对期初往来。'],
      ],
    );
    // 核对无误清掉提醒，仍是启用前；不再变就不再提醒
    const flagged = event(s, 1);
    new FinanceEventHandling(s).acknowledgeStatisticalCorrection(maker, flagged.id, {
      version: Number(flagged.version),
      requestId: 'ack-opening',
      reason: '已核对期初往来',
    });
    assert.deepEqual([event(s, 1).status, event(s, 1).problem], ['before_opening', null]);
    // 只改备注这类财务不看的内容：版本变了也不再提醒
    setDoc(s, 1, '$.notes', '虚构备注');
    events.sync(maker, { requestId: 'scan-3' });
    assert.equal(event(s, 1).problem, null);
    assert.deepEqual(openingStep().items?.map((r) => r.source_id), ['2']);
    // 再改价又提醒
    reprice('130.0000');
    events.sync(maker, { requestId: 'scan-4' });
    assert.deepEqual(openingStep().items?.map((r) => r.source_id), ['1', '2']);
  } finally {
    s.close();
  }
});

test('金额算出来就是 0 的送货、到货：不要求补税率，月度台账不算缺价格、明细不列出，报表和结账不卡', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s);
    const events = new FinanceEvents(s);
    // 1：0 元送货（赠品），行上、单头、客户约定都没写含税口径和税率
    physical(s, 1, 'delivery', '2026-01-10', {
      customerId: 1,
      customerName: '虚构客户',
      lines: [{ unit: '只', quantity: '5', unitPriceExact: '0.0000' }],
    });
    // 2：到货整批拒收，实际入库 0
    physical(s, 2, 'arrival', '2026-01-12', {
      ...arrivalDoc('10'),
      lines: [{ ...arrivalDoc('10').lines[0], stockedQuantity: '0', taxMode: '', taxRate: '' }],
    });
    // 3：到货单价明确填了 0、没写口径
    physical(s, 3, 'arrival', '2026-01-13', {
      ...arrivalDoc('10'),
      lines: [{ ...arrivalDoc('10').lines[0], unitPrice: '0', taxMode: '', taxRate: '' }],
    });
    events.sync(maker, { requestId: 'scan' });
    for (const id of [1, 2, 3]) {
      const e = event(s, id);
      assert.equal(e.status, 'no_amount', '单据 ' + id + ' 金额为 0，不算资料待补');
      assert.equal(e.amount_cents, 0);
      const theoretical = readSnapshot(e).theoretical;
      assert.ok(theoretical, '单据 ' + id + ' 的快照带理论金额');
      assert.equal(theoretical.gross, 0, '理论金额 0 带在快照里');
    }
    assert.equal(count(s.db, 'SELECT count(*) FROM fin_obligations'), 0, '0 元不挂往来');
    const monthly = new FinanceMonthly(s);
    const month = monthly.get(maker, { period: '2026-01' });
    assert.deepEqual(
      [month.missingPrice, month.missingTax, month.theoreticalIncome, month.theoreticalExpense],
      [0, 0, 0, 0],
    );
    assert.deepEqual(monthly.detail(maker, { period: '2026-01' }).rows, [], '0 元单据不列进明细');
    assert.equal(new FinanceReports(s).readiness(maker, { period: '2026-01' }).ready, true);
    assert.equal(eventsStep(s).ok, true, '结账的事件步骤放行');
  } finally {
    s.close();
  }
});

test('金额为 0 的边界：单价没填仍是缺价格；一张单子有 0 元行也有缺税率的非 0 行，仍要补税率', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s);
    const events = new FinanceEvents(s);
    // 1：送货单价没填（未知），不当成 0
    physical(s, 1, 'delivery', '2026-01-10', {
      customerId: 1,
      customerName: '虚构客户',
      lines: [{ unit: '只', quantity: '5' }],
    });
    // 2：到货单价没填（未知），不当成 0
    physical(s, 2, 'arrival', '2026-01-11', {
      ...arrivalDoc('10'),
      lines: [{ ...arrivalDoc('10').lines[0], unitPrice: null }],
    });
    // 3：送货一行 0 元（赠品）、一行 2 只每只 10 元，都没写口径
    physical(s, 3, 'delivery', '2026-01-12', {
      customerId: 1,
      customerName: '虚构客户',
      lines: [
        { unit: '只', quantity: '5', unitPriceExact: '0.0000' },
        { unit: '只', quantity: '2', unitPriceExact: '10.0000' },
      ],
    });
    events.sync(maker, { requestId: 'scan' });
    for (const id of [1, 2]) {
      const e = event(s, id);
      assert.equal(e.status, 'info_pending', '单据 ' + id + ' 单价未知仍是资料待补');
      assert.equal(e.amount_cents, null);
      assert.deepEqual(readSnapshot(e).missing, ['price'], '报错里带“单位”也记成缺价格');
    }
    const mixed = event(s, 3);
    assert.equal(mixed.status, 'info_pending', '非 0 行缺税率，整张仍要补');
    const snapshot = readSnapshot(mixed);
    assert.deepEqual(snapshot.missing, ['tax']);
    assert.equal(mixed.amount_cents, 2000, '理论金额先进账');
    assert.deepEqual(
      snapshot.financialLines?.map((l) => [l.mode, l.rate]),
      [
        ['未税', '0'],
        ['', ''],
      ],
      '0 元行按未税 0 计，非 0 行留空待补',
    );
    const month = new FinanceMonthly(s).get(maker, { period: '2026-01' });
    assert.deepEqual([month.missingPrice, month.missingTax, month.theoreticalIncome], [2, 1, 2000]);
    assert.equal(new FinanceReports(s).readiness(maker, { period: '2026-01' }).ready, false);
    // 补上税率后照常生成凭证：0 元行跟着按补的口径算，还是 0
    new FinanceEventHandling(s).resolveBatch(maker, {
      requestId: 'tax',
      items: [{ id: Number(mixed.id), version: Number(mixed.version) }],
      rate: '13',
      mode: '含税',
    });
    const done = event(s, 3);
    assert.equal(done.status, 'generated');
    assert.equal(done.amount_cents, 2000);
    assert.deepEqual(
      readSnapshot(done).money?.lines.map((l) => l.gross),
      [0, 2000],
    );
  } finally {
    s.close();
  }
});

test('资料待补缺的是数量还是价格：按出错的那一步记，不看报错文字', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s);
    const events = new FinanceEvents(s);
    const arrivalLine = arrivalDoc('10').lines[0];
    const arrival = (id: number, line: Record<string, unknown>) =>
      physical(s, id, 'arrival', '2026-01-1' + id, { ...arrivalDoc('10'), lines: [{ ...arrivalLine, ...line }] });
    // 到货：没记入库数量、计量单位空着、按面积计价但规格缺尺寸，都是缺数量
    arrival(1, { stockedQuantity: undefined });
    arrival(2, { item: { name: '虚构纸板', unit: '' } });
    arrival(3, { priceBasis: 'area' });
    // 到货：有单价没计价方式、没填单价，都是缺价格（报错“缺少到货价格或计价单位”里带“单位”也不算缺数量）
    arrival(4, { priceBasis: null });
    arrival(5, { unitPrice: null });
    // 送货：没写数量单位（就算单价也没填，先报数量）是缺数量；单价写坏了是缺价格
    physical(s, 6, 'delivery', '2026-01-16', {
      customerId: 1,
      customerName: '虚构客户',
      lines: [{ quantity: '1' }],
    });
    physical(s, 7, 'delivery', '2026-01-17', {
      customerId: 1,
      customerName: '虚构客户',
      lines: [{ unit: '只', quantity: '2', unitPriceExact: '1.23456' }],
    });
    events.sync(maker, { requestId: 'scan' });
    const missing = (id: number) => {
      const e = event(s, id);
      assert.equal(e.status, 'info_pending', '单据 ' + id + ' 资料待补');
      assert.equal(e.amount_cents, null);
      return readSnapshot(e).missing?.[0];
    };
    assert.deepEqual(
      [1, 2, 3, 4, 5, 6, 7].map(missing),
      ['quantity', 'quantity', 'quantity', 'price', 'price', 'quantity', 'price'],
    );
  } finally {
    s.close();
  }
});

test('有效的到货更正单直接入账（原单没入过账）：金额按不含税暂估，和普通到货同一个口径', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s);
    const events = new FinanceEvents(s);
    // 到货明细写 13% 税率（口径照旧未税）
    const taxed = (qty: string, extra: Record<string, unknown> = {}) => arrivalDoc(qty, { ...extra, line: { taxRate: '13' } });
    physical(s, 1, 'arrival', '2026-01-10', taxed('10'));
    events.sync(maker, { requestId: 'scan' });
    assert.equal(Number(event(s, 1).amount_cents), 10000, '普通到货按不含税');
    // 原单还没入账就冲销，按 8 张开更正单：更正单当成一张新单据直接入账
    s.db.exec("UPDATE flow_documents SET status='reversed',version=2 WHERE id=1");
    physical(s, 2, 'arrival', '2026-01-12', taxed('8', { correctionOf: 1 }));
    events.sync(maker, { requestId: 'rescan' });
    const replacement = event(s, 2);
    assert.equal(replacement.event_type, 'arrival.corrected');
    assert.equal(Number(replacement.amount_cents), 8000, '不含税 80 元，不是含税 90.40 元');
    new FinanceEventVouchers(s).generate(maker, replacement.id, { version: Number(replacement.version), requestId: 'generate-2' });
    const payable = s.db.prepare("SELECT amount_cents FROM fin_obligations WHERE event_id=? AND kind='payable'").get(replacement.id);
    assert.equal(Number(payable?.amount_cents), 8000, '暂估应付也按不含税');
  } finally {
    s.close();
  }
});

test('事件金额直接算：税率齐的可记账，缺税率待补并带理论金额，缺单价记缺价格，盘点调整记有差异', () => {
  const s = new Store(':memory:');
  try {
    const source = {
      kind: 'delivery' as const, id: '1', version: 1, status: 'confirmed' as const, date: '2026-01-20',
      document: '{}', at: '2026-01-20T09:00:00.000Z', number: 'FICT-1', previous: null,
    };
    const ready = evaluateSource(s.db, source, deliveryDoc('2'), { policy: 'delivery' });
    assert.equal(ready.status, 'ready');
    assert.equal(ready.money?.gross, 20000);
    const noTax = deliveryDoc('2');
    noTax.lines[0] = { ...noTax.lines[0], taxRate: '' };
    const pending = evaluateSource(s.db, source, noTax, { policy: 'delivery' });
    assert.equal(pending.status, 'info_pending');
    assert.deepEqual(pending.missing, ['tax']);
    assert.equal(pending.theoretical?.gross, 20000);
    const noPrice = { customerId: 1, customerName: '虚构客户', lines: [{ unit: '个', quantity: '2' }] };
    const missing = evaluateSource(s.db, source, noPrice, { policy: 'delivery' });
    assert.deepEqual([missing.status, missing.missing], ['info_pending', ['price']]);
    assert.equal(evaluateSource(s.db, source, deliveryDoc('2'), { policy: 'invoice' }).status, 'waiting_invoice');
    assert.equal(evaluateSource(s.db, { ...source, kind: 'stock' as const }, {}, { policy: 'delivery' }).status, 'difference');
  } finally {
    s.close();
  }
});
