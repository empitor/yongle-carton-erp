// 单据导出和仓库每日记录的测试底子（内存库、虚构数据）：一张待订货的采购单（10000 张纸板）、成品期初 10000 只、
// 一张 10000 只的订单；saveDelivery 存待送货的送货单，exp 拼导出请求，pendingArrival、receive 按订货单登记到货。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type ExcelJS from 'exceljs';
import yauzl, { type Entry } from 'yauzl';
import { Store } from '../server/core/db.js';
import type { FlowService } from '../server/flow/service.js';
import { WarehouseDaily } from '../server/flow/daily.js';
import { BusinessDocuments } from '../server/documents/service.js';
import { OrderBatchService } from '../server/operations/batches.js';
import { registerArrival } from '../server/flow/register-arrival.js';
import { shipOnDocDate } from './ship-date.js';
import { receiveLines } from './receive-fixture.js';
import { actor } from './actor-fixture.js';
import { businessBase } from './business-base-fixture.js';

type Base = ReturnType<typeof businessBase>;

export function setup(store = new Store(':memory:')) {
  const base = businessBase(actor, store),
    { ops, flow } = base,
    daily = new WarehouseDaily(store),
    docs = new BusinessDocuments(store);
  const buying = purchaseSide(base),
    selling = salesSide(base);
  return {
    store,
    ops,
    flow,
    daily,
    docs,
    ...buying,
    ...selling,
    ...deliveryActions(base, selling),
    exp: exportRequest(flow, buying.current),
    ...arrivalActions(store, buying),
  };
}

/** 采购这边：供应商、纸板 raw、一张待订货的采购单（10000 张、1.2345 元/张）；current() 读采购单现在的样子，ordered() 改成已订货 */
function purchaseSide({ ops, supplier: newSupplier, raw: newRaw }: Base) {
  const supplier = newSupplier({ name: '虚构春芳纸板厂', contact: '虚构联系人', phone: '000-0000', address: '虚构供应商地址' });
  const raw = newRaw({ name: '虚构纸板A', length: 1000, width: 800, dimensionUnit: 'mm', specification: 'K=A B楞' });
  const purchase = ops.savePurchase(
    {
      supplierId: supplier.id,
      orderDate: '2026-10-29',
      expectedDate: '2026-11-02',
      status: '待订货',
      notes: '按原单位与尺寸供货',
      lines: [{ ...raw, stockItemId: raw.id, quantity: '10000', unitPrice: '1.2345', priceBasis: 'quantity' }],
    },
    actor,
  );
  const current = () => ops.repo.purchases(true, purchase.id)[0];
  const ordered = () => ops.savePurchase({ ...current(), status: '已订货', version: current().version }, actor, purchase.id);
  return { raw, purchase, current, ordered };
}

/** 销售这边：客户、有尺寸的产品、它的成品库存（期初 10000 只）、一张 10000 只的订单 */
function salesSide(base: Base) {
  const customer = base.customer({ name: '虚构包装客户', contact: '虚构收货人', phone: '000-111', address: '虚构收货地址' });
  const product = base.product({ name: '虚构纸箱产品', length: 300, width: 200, height: 150, dimensionUnit: 'mm' });
  const stock = base.finished(product, { name: product.name, specification: '纸箱300×200×150mm' }, { quantity: '10000', date: '2026-10-29' });
  const order = base.order(
    customer,
    [base.line(product, 10000, { productName: product.name, specification: stock.specification })],
    { orderDate: '2026-10-29', deliveryDate: '2026-11-03' },
  );
  return { customer, stock, order };
}

/** saveDelivery(数量, 别的字段) 存一张待送货的送货单（计划 2026-10-30 14:30）；confirm(单据) 核对（出库日按单据日期） */
function deliveryActions({ flow, check }: Base, { customer, order, stock }: ReturnType<typeof salesSide>) {
  const saveDelivery = (quantity = '4000', extra: Record<string, unknown> = {}) =>
    flow.save(
      'delivery',
      {
        date: '2026-10-29',
        plannedDate: '2026-10-30',
        plannedTime: '14:30',
        actualTime: '15:00',
        customerId: customer.id,
        lines: [{ orderId: order.id, orderLineId: order.lines[0].id, stockId: stock.id, quantity }],
        ...extra,
      },
      actor,
    );
  const confirm = (d: { id: number }) => check(d, shipOnDocDate(flow, d.id));
  return { saveDelivery, confirm };
}

/** 导出请求：采购单默认标成已订货，版本号取现在的；extra 并进去（format、markOrdered 等） */
function exportRequest(flow: FlowService, purchase: () => { version: number }) {
  return (kind: 'purchase' | 'delivery', id: number, extra: Record<string, unknown> = {}) => ({
    kind,
    id,
    format: 'docx',
    markOrdered: kind === 'purchase',
    expectedVersion: kind === 'purchase' ? purchase().version : flow.get(id).version,
    requestId: randomUUID(),
    ...extra,
  });
}

/** pendingArrival 像 AI 识别的送货单那样按订货单存成待入库（还没核对）；receive 按采购明细登记到货并入库 */
function arrivalActions(store: Store, { purchase, current }: ReturnType<typeof purchaseSide>) {
  const pendingArrival = (date = '2026-10-30', q = '5000') => {
    const batches = new OrderBatchService(store),
      batchId = batches.batchIdOf(purchase.id);
    if (batchId === null) throw new Error('测试数据：采购单还没订货（先 ordered()）');
    const batch = batches.view(batchId);
    return registerArrival(
      store,
      { batchId: batch.id },
      {
        expectedVersion: batch.version,
        requestId: randomUUID(),
        date,
        reference: randomUUID(),
        pending: true,
        rows: [{ key: batch.rows[0].key, quantity: q }],
      },
      actor,
    ).arrival;
  };
  const receive = (q = '5000') =>
    receiveLines(
      store,
      purchase.id,
      {
        reference: randomUUID(),
        date: '2026-10-29',
        actualTime: '14:00',
        requestId: randomUUID(),
        items: [{ lineId: current().lines[0].id, quantity: q, acceptedQuantity: q, rejectedQuantity: '0', stockedQuantity: q }],
      },
      actor,
    );
  return { pendingArrival, receive };
}

/** 读出 Word、Excel 包里的各个 XML */
export function zipEntries(bytes: Buffer): Promise<Map<string, string>> {
  return new Promise((resolve, reject) =>
    yauzl.fromBuffer(bytes, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('读不出压缩包'));
      const result = new Map<string, string>();
      zip.on('error', reject);
      zip.on('end', () => resolve(result));
      zip.on('entry', (entry: Entry) => {
        zip.openReadStream(entry, (e, stream) => {
          if (e || !stream) return reject(e ?? new Error('读不出 ' + entry.fileName));
          const chunks: Buffer[] = [];
          stream.on('data', (c: Buffer) => chunks.push(c));
          stream.on('end', () => {
            if (entry.fileName.endsWith('.xml'))
              result.set(entry.fileName, Buffer.concat(chunks).toString());
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    }),
  );
}

/** 生成的 Word 正文 */
export async function wordXml(bytes: Buffer) {
  const xml = (await zipEntries(bytes)).get('word/document.xml');
  assert.ok(xml, 'Word 里有正文');
  return xml;
}

/** Excel 表里从第 1 行到最后一行 */
export function allRows(sheet: ExcelJS.Worksheet) {
  const rows = sheet.getRows(1, sheet.rowCount);
  assert.ok(rows, '表格里有行');
  return rows;
}
