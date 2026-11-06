// 界面实测用的隔离实例：临时目录、纯虚构数据、模型替身，不接触 data/ 或用户配置。账号密码都是虚构的。
import { randomUUID, scryptSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
const P = new URL('../../', import.meta.url).href;
process.env.PORT = '3199';
const { createOrderWorkflowFixture } = await import(P + 'tests/assistant-workflow-fixture.ts');
const { AuthManager } = await import(P + 'server/auth.ts');
const { createApp } = await import(P + 'server/app.ts');
const { OperationsService } = await import(P + 'server/operations/service.ts');
const { FlowService } = await import(P + 'server/flow/service.ts');
const { productSchema, customerSchema, orderSchema, today } = await import(P + 'shared/domain.ts');
const f = createOrderWorkflowFixture();
const authPath = join(f.dir, 'users.sqlite');
const auth = new AuthManager(authPath, Date.now, { localDevelopment: false, localAdministration: true });
const db = new DatabaseSync(authPath);
const add = (name: string, pw: string, role: string) => {
  const salt = randomUUID();
  db.prepare('INSERT INTO users(id,name,salt,password_hash,permissions,role) VALUES(?,?,?,?,?,?)').run(randomUUID(), name, salt, scryptSync(pw, salt, 64).toString('hex'), JSON.stringify(['business:edit', 'import:execute', 'import:restore']), role);
};
add('虚构业务员', 'Fictional-Audit-2026', 'admin');
add('虚构管理员', 'Fictional-Admin-2026', 'super_admin');
db.close();
const actor: any = { id: 'seed', name: '虚构初始化', permissions: ['business:edit', 'import:execute'], role: 'admin' };
const { store } = f, ops = new OperationsService(store), flow = new FlowService(store);
const shift = (d: number) => { const t = new Date(today() + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + d); return t.toISOString().slice(0, 10); };
const confirm = (d: any) => { const p = flow.preview(d.id, actor, 'seed'); return flow.confirm(d.id, { previewId: p.previewId, requestId: randomUUID(), acknowledged: true }, actor, 'seed'); };
const customers = ['虚构东海电器有限公司', '虚构明远食品有限公司', '虚构海曙五金制品厂', '虚构北仑灯具有限公司', '虚构慈溪小家电有限公司', '虚构余姚塑料制品有限公司'].map((name, i) =>
  store.saveCustomer(customerSchema.parse({ name, contact: '联系人' + (i + 1), phone: '0574-0000-00' + i, address: '虚构路' + (i + 1) + '号' })));
const productDefs = [['电饭煲外箱 3L', 420, 320, 300, 'K=A', 'BC'], ['电饭煲外箱 5L', 480, 360, 340, 'K=A', 'BC'], ['食品礼盒外箱', 500, 350, 260, 'B=B', 'BE'], ['五金配件箱 小', 300, 200, 150, 'A=A', 'B'], ['五金配件箱 大', 450, 300, 250, 'K=K', 'BC'], ['灯具内托箱', 620, 180, 180, 'B=B', 'E'], ['吹风机彩箱', 260, 110, 240, 'W=A', 'E'], ['水壶外箱', 380, 380, 320, 'K=A', 'BC'], ['塑料件周转箱', 600, 400, 300, 'K=K', 'AB']] as const;
const products = productDefs.map(([name, length, width, height, material, flute]) => store.saveProduct(productSchema.parse({ name, length, width, height, dimensionUnit: 'mm', material, flute, requirements: '四色印刷，钉箱', priceCents: 0 })));
store.saveProduct(productSchema.parse({ name: '资料不全的临时箱' }));
const suppliers = ['虚构鼎盛纸业', '虚构宏泰纸板厂', '虚构华美瓦楞'].map((name, i) => ops.saveSupplier({ name, contact: '供应联系人' + i, phone: '0574-1000-00' + i, address: '虚构工业区' + i }, actor));
const raws = [['BC五层纸板 1250×1000', 1250, 1000, 'K=A', 'BC'], ['BE五层纸板 1400×1100', 1400, 1100, 'B=B', 'BE'], ['B三层纸板 900×700', 900, 700, 'A=A', 'B'], ['E三层纸板 800×600', 800, 600, 'W=A', 'E']] as const;
const rawItems = raws.map(([name, length, width, material, flute]) => ops.saveItem({ name, kind: 'raw', unit: '张', length, width, height: null, dimensionUnit: 'mm', material, flute, specification: '', notes: '', productId: null }, actor));
rawItems.forEach((r, i) => [3200, 900, 0, 450][i] && ops.move(r.id, { action: 'in', quantity: String([3200, 900, 0, 450][i]), date: shift(-30), notes: '虚构期初', acknowledged: true, requestId: randomUUID(), expectedVersion: r.version }, actor));
const finished = products.map((p) => ops.saveItem({ name: p.name, kind: 'finished', unit: '只', length: p.length, width: p.width, height: p.height, dimensionUnit: 'mm', material: p.material, flute: p.flute, specification: '', notes: '', productId: p.id }, actor));
const statusCycle = ['已确认', '已确认', '已确认', '已确认', '草稿', '已确认', '已确认', '已确认', '已取消', '已确认'];
const orders: any[] = [];
for (let i = 0; i < Number(process.env.SEED_ORDERS || 28); i++) {
  const c = customers[i % customers.length], a = products[i % products.length], b = products[(i + 3) % products.length];
  const two = i % 3 === 0;
  const orderDate = shift(-24 + i), deliveryDate = shift(-24 + i + 7 + (i % 5));
  const lines = [a, ...(two ? [b] : [])].map((p, j) => ({ productId: p.id, productName: p.name, specification: `${p.length}×${p.width}×${p.height}`, quantity: 500 * (1 + ((i + j) % 6)), unit: '只', unitPriceCents: 180 + (i * 37 + j * 91) % 900, notes: '', customerProductCode: 'KH-' + (1000 + i * 3 + j) }));
  orders.push(store.saveOrder(orderSchema.parse({ customerId: c.id, orderDate, deliveryDate, status: statusCycle[i % statusCycle.length], notes: i % 7 === 0 ? '客户要求分批送货' : '', costs: null, externalPurchaseOrder: 'PO-' + (2600 + i), taxRate: '13%', taxMode: '含税', roundingPolicy: 'half-up-cent', lines })));
}
const confirmedOrders = orders.filter((o) => o.status === '已确认');
for (let i = 0; i < 9; i++) {
  const o = confirmedOrders[i], s = suppliers[i % suppliers.length], r = raws[i % raws.length], item = rawItems[i % rawItems.length];
  const p = ops.savePurchase({ supplierId: s.id, customerOrderId: i % 2 ? o.id : null, orderDate: shift(-12 + i), expectedDate: shift(-5 + i), status: i % 4 === 3 ? '待订货' : '已订货', notes: '', lines: [{ name: r[0], stockItemId: item.id, length: r[1], width: r[2], height: null, dimensionUnit: 'mm', material: r[3], flute: r[4], specification: '', notes: '', unit: '张', quantity: String(800 + i * 150), unitPrice: (2.5 + i * 0.13).toFixed(4), priceBasis: 'area' }] }, actor);
  if (i < 3) flow.receivePurchase({ purchaseId: p.id, expectedPurchaseVersion: p.version, requestId: randomUUID(), date: shift(-6 + i), reference: 'GYS-SD-' + (700 + i), notes: '', items: [{ lineId: p.lines[0].id, quantity: String(i === 3 ? 300 : 800 + i * 150), acceptedQuantity: String(i === 3 ? 300 : 800 + i * 150), rejectedQuantity: '0', stockedQuantity: String(i === 3 ? 300 : 800 + i * 150) }] }, actor);
}
for (let i = 0; i < 12; i++) {
  const o = confirmedOrders[i], l = o.lines[0], fin = finished.find((x: any) => x.productId === l.productId)!;
  const t = flow.save('task', { date: shift(-10 + i), plannedDate: shift(-6 + i), productId: l.productId, quantity: String(l.quantity), unit: '只', orderIds: [o.id], notes: '' }, actor);
  if (i === 11) continue;
  const task = confirm(t);
  if (i < 8) {
    const good = i < 6 ? String(l.quantity) : String(Math.floor(l.quantity / 2));
    confirm(flow.save('production', { date: shift(-8 + i), taskId: task.id, productId: l.productId, finishedStockId: fin.id, goodQuantity: good, scrapQuantity: String(i * 3), operator: '虚构机长' + (i % 3), materials: [{ stockId: rawItems[0].id, issued: String(Math.ceil(l.quantity / 4)), returned: '0' }] }, actor));
    if (i < 5) {
      const ship = i < 3 ? String(l.quantity) : String(Math.floor(l.quantity / 2));
      const d = flow.save('delivery', { date: shift(-5 + i), plannedDate: shift(-5 + i), customerId: o.customerId, address: '虚构收货地址', contact: '收货人', phone: '0574-2000', lines: [{ orderId: o.id, orderLineId: l.id, stockId: fin.id, quantity: ship, notes: '' }], notes: '' }, actor);
      if (i < 4) confirm(d);
    }
  }
}
const { InboxService } = await import(P + 'server/inbox/service.ts');
const inbox = new InboxService(f.store);
const nowIso = (m: number) => new Date(Date.now() - m * 60000).toISOString();
inbox.ingest({ channel: 'wecom_kf', externalId: 'v1', senderId: 'c1', senderName: '王经理', conversation: '虚构东海电器', kind: 'file', file: { name: '11月采购单.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: new TextEncoder().encode('fictional') }, receivedAt: nowIso(12) });
inbox.ingest({ channel: 'wecom_kf', externalId: 'v2', senderName: '李工', conversation: '虚构明远食品', kind: 'text', text: '吹风机彩箱再加500只，下周三前能送到吗？', receivedAt: nowIso(40) });
inbox.ingest({ channel: 'wecom_kf', externalId: 'v3', senderName: '虚构华美瓦楞', conversation: '虚构华美瓦楞', kind: 'text', text: '明天上午送BC五层纸板800张，请安排卸货。', receivedAt: nowIso(95) });
inbox.ingest({ channel: 'wecom_kf', externalId: 'v4', senderName: '张会计', conversation: '虚构北仑灯具', kind: 'image', file: { name: '手写订单照片.png', mime: 'image/png', bytes: Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==','base64')) }, receivedAt: nowIso(180) });
inbox.ingest({ channel: 'manual', externalId: 'v5', kind: 'text', text: '客户电话：月底对账单已发，请核对。', receivedAt: nowIso(600) });
const server = createApp(f.store, { auth, assistant: f.manager, imports: f.imports, aiSettings: f.settings, enableReviewedImports: true, importArchiveDirectory: join(f.dir, 'archive') }).listen(3199, '127.0.0.1', () => console.log('READY http://127.0.0.1:3199 data=' + f.dir));
process.on('SIGINT', () => server.close(() => { auth.close(); f.close(); process.exit(0); }));
