// 界面实测用的隔离实例：临时目录、纯虚构数据、模型替身，不接触 data/ 或用户配置。账号密码都是虚构的。
// UI_CHECK_PORT 换端口（默认 3199）；UI_CHECK_REMOTE=1 关掉“本机管理员”，模拟从域名访问。
// UI_CHECK_REAL_MODEL=1 是真实模型模式（不装模型替身，见 real-model.mts），由 preview.mjs --real-model 设。
import { randomUUID, scryptSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { Actor } from '../../server/core/index.ts';
import type { FlowDocView } from '../../shared/business/index.ts';
const port = Number(process.env.UI_CHECK_PORT || 3199);
const remote = process.env.UI_CHECK_REMOTE === '1';
const realModel = process.env.UI_CHECK_REAL_MODEL === '1';
process.env.PORT = String(port);
// 先设好端口等环境变量再加载服务端代码，所以用 import()；引用模块只走公开入口
const { createOrderWorkflowFixture } = await import('../../tests/assistant-workflow-fixture.ts');
const { AuthManager, one, rows } = await import('../../server/core/index.ts');
const { createApp } = await import('../../server/app.ts');
const { OperationsService, OrderBatchService } = await import('../../server/operations/index.ts');
const { FlowService, registerArrival } = await import('../../server/flow/index.ts');
const { productSchema, customerSchema, orderSchema, today } = await import('../../shared/core/index.ts');
const real = realModel ? await (await import('./real-model.mts')).createRealModelSettings() : null;
// 识别放慢：往 /__ui-check/replies 排一条 { recognition: { chunkDelayMs } }，下一次识别的模型回复按块慢慢吐出来，
// 页面上看得到“等 AI 读文件 → AI 正在填写”一步步出来。只放慢识别（助手对话照常），排一条放慢一次
const slowRecognitionEntry = z.object({ recognition: z.object({ chunkDelayMs: z.number() }) });
const queuedReplies = z.array(z.unknown());
const slowRecognitions: { chunkDelayMs: number }[] = [];
const slowRecognition = (next: (request: Request) => Promise<Response>) => async (request: Request) => {
  const text = new URL(request.url).pathname === '/chat/completions' ? await request.clone().text() : '';
  const response = await next(request);
  const source = response.body;
  const plan = text && !text.includes('ERP 里的业务助手小甬和小勒') && source ? slowRecognitions.shift() : undefined;
  if (!plan || !source) return response;
  const reader = source.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      await new Promise((r) => setTimeout(r, plan.chunkDelayMs));
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
  });
  return new Response(body, { status: response.status, headers: response.headers });
};
// 到货识别：模型替身固定回一张虚构送货单（supplierReply 在下面造好种子数据以后才定，识别时才读；真实模型模式用真实设置）
const { makeSettings } = await import('../../tests/assistant-fixture.ts');
const receiptSettings = real ? real.settings : makeSettings(() => supplierReply);
const f = createOrderWorkflowFixture(undefined, { ...(real ? { settings: real.settings } : { wrap: slowRecognition }), receiptSettings });
const authPath = join(f.dir, 'users.sqlite');
const auth = new AuthManager(authPath, Date.now, { localAdministration: !remote });
const db = new DatabaseSync(authPath);
const add = (name: string, pw: string, role: string, permissions = ['business:edit', 'import:execute', 'import:restore']) => {
  const salt = randomUUID();
  db.prepare('INSERT INTO users(id,name,salt,password_hash,permissions,role) VALUES(?,?,?,?,?,?)').run(randomUUID(), name, salt, scryptSync(pw, salt, 64).toString('hex'), JSON.stringify(permissions), role);
};
add('虚构业务员', 'Fictional-Audit-2026', 'admin');
add('虚构管理员', 'Fictional-Admin-2026', 'super_admin');
add('虚构出纳', 'Fictional-Cashier-2026', 'admin', ['finance:view', 'finance:cash']);
add('虚构只读', 'Fictional-Viewer-2026', 'admin', []);
db.close();
const { pageActor } = await import('../../tests/actor-fixture.ts');
const actor: Actor = pageActor({ id: 'seed', name: '虚构初始化', permissions: ['business:edit', 'import:execute'], role: 'admin' });
const { store } = f, ops = new OperationsService(store), flow = new FlowService(store);
const shift = (d: number) => { const t = new Date(today() + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + d); return t.toISOString().slice(0, 10); };
// 种子是补录历史：送货单按单据上的日期出库（真实操作里出库日就是确认那天）
const confirm = (d: FlowDocView) => { const p = flow.preview(d.id, actor); return flow.confirm(d.id, { previewDigest: p.previewDigest, requestId: randomUUID(), acknowledged: true, ...(d.kind === 'delivery' ? { shipDate: d.date } : {}) }, actor); };
const customers = ['虚构东海电器有限公司', '虚构明远食品有限公司', '虚构海曙五金制品厂', '虚构北仑灯具有限公司', '虚构慈溪小家电有限公司', '虚构余姚塑料制品有限公司'].map((name, i) =>
  store.saveCustomer(customerSchema.parse({ name, contact: '联系人' + (i + 1), phone: '0574-0000-00' + i, address: '虚构路' + (i + 1) + '号' })));
const productDefs = [['电饭煲外箱 3L', 420, 320, 300, 'K=A', 'BC'], ['电饭煲外箱 5L', 480, 360, 340, 'K=A', 'BC'], ['食品礼盒外箱', 500, 350, 260, 'B=B', 'BE'], ['五金配件箱 小', 300, 200, 150, 'A=A', 'B'], ['五金配件箱 大', 450, 300, 250, 'K=K', 'BC'], ['灯具内托箱', 620, 180, 180, 'B=B', 'E'], ['吹风机彩箱', 260, 110, 240, 'W=A', 'E'], ['水壶外箱', 380, 380, 320, 'K=A', 'BC'], ['塑料件周转箱', 600, 400, 300, 'K=K', 'AB']] as const;
const products = productDefs.map(([name, length, width, height, material, flute]) => store.saveProduct(productSchema.parse({ name, length, width, height, dimensionUnit: 'mm', material, flute, requirements: '四色印刷，钉箱', priceCents: 0 })));
store.saveProduct(productSchema.parse({ name: '资料不全的临时箱' }));
const suppliers = ['虚构鼎盛纸业', '虚构宏泰纸板厂', '虚构华美瓦楞', '虚构永信纸业'].map((name, i) => ops.saveSupplier({ name, contact: '供应联系人' + i, phone: '0574-1000-00' + i, address: '虚构工业区' + i }, actor));
const raws = [['BC五层纸板 1250×1000', 1250, 1000, 'K=A', 'BC'], ['BE五层纸板 1400×1100', 1400, 1100, 'B=B', 'BE'], ['B三层纸板 900×700', 900, 700, 'A=A', 'B'], ['E三层纸板 800×600', 800, 600, 'W=A', 'E']] as const;
const rawItems = raws.map(([name, length, width, material, flute]) => ops.saveItem({ name, kind: 'raw', unit: '张', length, width, height: null, dimensionUnit: 'mm', material, flute, specification: '', notes: '', productId: null }, actor));
rawItems.forEach((r, i) => [3200, 900, 0, 450][i] && ops.move(r.id, { action: 'in', quantity: String([3200, 900, 0, 450][i]), date: shift(-30), notes: '虚构期初', acknowledged: true, requestId: randomUUID(), expectedVersion: r.version }, actor));
const finished = products.map((p) => ops.saveItem({ name: p.name, kind: 'finished', unit: '只', length: p.length, width: p.width, height: p.height, dimensionUnit: 'mm', material: p.material, flute: p.flute, specification: '', notes: '', productId: p.id }, actor));
const statusCycle = ['已确认', '已确认', '已确认', '已确认', '待确认', '已确认', '已确认', '已确认', '已取消', '已确认'];
const finishedOf = (productId: number | null) => {
  const item = finished.find((x) => x.productId === productId);
  if (!item) throw new Error(`种子数据里没有产品 ${productId} 的成品库存品`);
  return item;
};
const orders = Array.from({ length: 28 }, (_, i) => {
  const c = customers[i % customers.length], a = products[i % products.length], b = products[(i + 3) % products.length];
  const two = i % 3 === 0;
  const orderDate = shift(-24 + i), deliveryDate = shift(-24 + i + 7 + (i % 5));
  const lines = [a, ...(two ? [b] : [])].map((p, j) => ({ productId: p.id, productName: p.name, specification: `${p.length}×${p.width}×${p.height}`, quantity: 500 * (1 + ((i + j) % 6)), unit: '只', unitPriceCents: 180 + (i * 37 + j * 91) % 900, notes: '', customerProductCode: 'KH-' + (1000 + i * 3 + j) }));
  return store.saveOrder(orderSchema.parse({ customerId: c.id, orderDate, deliveryDate, status: statusCycle[i % statusCycle.length], notes: i % 7 === 0 ? '客户要求分批送货' : '', costs: null, externalPurchaseOrder: 'PO-' + (2600 + i), taxRate: '13%', taxMode: '含税', roundingPolicy: 'half-up-cent', lines }));
});
const confirmedOrders = orders.filter((o) => o.status === '已确认');
// 财务补充场景用：上个月最后一天的一张已确认送货单（按本月启用财务时是启用前的单据），备注写明，场景脚本按它找。
// 专门造一张上个月最后一天下单的已确认订单给它，不管今天是几号都有；先入同样数量的成品
{
  const prevEnd = shift(-Number(today().slice(8, 10)));
  const p = products[0], quantity = 500;
  const o = store.saveOrder(orderSchema.parse({ customerId: customers[0].id, orderDate: prevEnd, deliveryDate: prevEnd, status: '已确认', notes: '', costs: null, externalPurchaseOrder: 'PO-虚构启用前', taxRate: '13%', taxMode: '含税', roundingPolicy: 'half-up-cent', lines: [{ productId: p.id, productName: p.name, specification: `${p.length}×${p.width}×${p.height}`, quantity, unit: '只', unitPriceCents: 260, notes: '', customerProductCode: '' }] }));
  const l = o.lines[0], fin = finishedOf(l.productId);
  ops.move(fin.id, { action: 'in', quantity: String(quantity), date: prevEnd, notes: '虚构期初', acknowledged: true, requestId: randomUUID(), expectedVersion: fin.version }, actor);
  confirm(flow.save('delivery', { date: prevEnd, plannedDate: prevEnd, customerId: o.customerId, address: '虚构收货地址', contact: '收货人', phone: '0574-2000', lines: [{ orderId: o.id, orderLineId: l.id, stockId: fin.id, quantity: String(quantity), notes: '' }], notes: '虚构启用前送货' }, actor));
}
for (let i = 0; i < 11; i++) {
  const o = confirmedOrders[i], s = suppliers[i % suppliers.length], r = raws[i % raws.length], item = rawItems[i % rawItems.length];
  const p = ops.savePurchase({ supplierId: s.id, customerOrderId: i % 2 ? o.id : null, orderDate: shift(-12 + i), expectedDate: shift(-5 + i), status: i % 4 === 3 || i >= 9 ? '待订货' : '已订货', notes: '', lines: [{ name: r[0], stockItemId: item.id, length: r[1], width: r[2], height: null, dimensionUnit: 'mm', material: r[3], flute: r[4], specification: '', notes: '', unit: '张', quantity: String(800 + i * 150), unitPrice: (2.5 + i * 0.13).toFixed(4), priceBasis: 'area' }] }, actor);
  // 前三张按订货单登记到货（已订货的采购单自动建好订货单），全部合格入库
  if (i < 3) {
    const batches = new OrderBatchService(store), batchId = batches.batchIdOf(p.id);
    if (batchId === null) throw new Error(`种子采购单 ${p.id} 没有自动建好订货单`);
    const b = batches.view(batchId);
    registerArrival(store, { batchId: b.id }, { expectedVersion: b.version, requestId: randomUUID(), date: shift(-6 + i), reference: 'GYS-SD-' + (700 + i), rows: [{ key: b.rows[0].key, quantity: String(800 + i * 150), rejectedQuantity: '0' }] }, actor);
  }
}
for (let i = 0; i < 12; i++) {
  const o = confirmedOrders[i], l = o.lines[0], fin = finishedOf(l.productId);
  // 安排生产即下达：保存出来就是已下达的任务（最后一张只排不做）
  const task = flow.save('task', { date: shift(-10 + i), plannedDate: shift(-6 + i), productId: l.productId, quantity: String(l.quantity), unit: '只', orderIds: [o.id], notes: '' }, actor);
  if (i === 11) continue;
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
const { InboxService } = await import('../../server/inbox/index.ts');
const inbox = new InboxService(f.store);
const nowIso = (m: number) => new Date(Date.now() - m * 60000).toISOString();
const { FILES } = await import('./real-suite-files.mjs');
inbox.ingest({ channel: 'wecom_bot', externalId: 'v1', senderId: 'c1', senderName: '王经理', conversation: '虚构东海电器', kind: 'file', file: { name: '11月采购单.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: (await FILES.orderXlsx()).bytes }, receivedAt: nowIso(12) });
inbox.ingest({ channel: 'wecom_bot', externalId: 'v2', senderName: '李工', conversation: '虚构明远食品', kind: 'text', text: '吹风机彩箱再加500只，下周三前能送到吗？', receivedAt: nowIso(40) });
inbox.ingest({ channel: 'wecom_bot', externalId: 'v3', senderName: '虚构华美瓦楞', conversation: '虚构华美瓦楞', kind: 'text', text: '明天上午送BC五层纸板800张，请安排卸货。', receivedAt: nowIso(95) });
inbox.ingest({ channel: 'wecom_bot', externalId: 'v4', senderName: '张会计', conversation: '虚构北仑灯具', kind: 'image', file: { name: '手写订单照片.png', mime: 'image/png', bytes: Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==','base64')) }, receivedAt: nowIso(180) });
inbox.ingest({ channel: 'manual', externalId: 'v5', kind: 'text', text: '客户电话：月底对账单已发，请核对。', receivedAt: nowIso(600) });
// 三家机器人连本机假服务端（tests/bot-fakes.ts），不会连到真的企业微信、飞书、钉钉；
// 填 tests/bot-fakes-http.ts 里的虚构凭据能看到“已连接”，填别的看“连接被拒绝”。Secret 只在这个临时目录里，不加密
const { inboxBots, BotSettings } = await import('../../server/inbox/index.ts');
const { startFakeBots } = await import('../../tests/bot-fakes.ts');
const fakeBots = await startFakeBots();
const botSettings = new BotSettings(join(f.dir, 'bots.sqlite'), { protect: (v) => v, unprotect: (v) => v });
const bots = inboxBots(f.store, botSettings, {
  fetchImpl: fakeBots.fetchImpl,
  checkHost: fakeBots.checkHost,
  WebSocketImpl: fakeBots.WebSocketImpl,
});
const supplierReply = {
  supplierName: suppliers[0].name, reference: 'GYS-SD-虚构', purchaseNumber: null, date: today(), notes: null, warnings: [],
  lines: [{ name: raws[0][0], specification: null, material: raws[0][3], flute: raws[0][4], length: String(raws[0][1]), width: String(raws[0][2]), dimensionUnit: 'mm', quantity: '500', unit: '张', area: null, unitPrice: null, priceBasis: null, notes: null }],
};
const { receiptAi } = f.deps;
// 识别好的文件（模型替身给结果，不调真实模型）：AI 导入页、助手导入卡片、“助手改的”标记要看。
// 订单那份是“聊天验收客户”的：第 1 行“聊天纸箱甲 300×200×150”这位客户以前订过（一张早就取消的老订单），第 2 行要新建产品。
if (!real) {
  const { imageFixture } = await import('../../tests/import-fixtures.ts');
  const { prepareArrivalRecognition } = await import('../../server/import/index.ts');
  const buyer = one(store.db, rows.customers.pick({ id: true }), "SELECT id FROM customers WHERE name='聊天验收客户'");
  if (!buyer) throw new Error('助手夹具里没有“聊天验收客户”');
  const old = store.saveProduct(productSchema.parse({ name: '聊天纸箱甲', length: 300, width: 200, height: 150, dimensionUnit: 'mm', material: 'K=A', flute: 'B', priceCents: 0 }));
  store.saveOrder(orderSchema.parse({ customerId: buyer.id, orderDate: shift(-90), deliveryDate: shift(-80), status: '已取消', notes: '虚构老订单', costs: null, externalPurchaseOrder: 'PO-虚构老单', taxRate: '13%', taxMode: '含税', roundingPolicy: 'half-up-cent', lines: [{ productId: old.id, productName: old.name, specification: '300×200×150', quantity: 100, unit: '只', unitPriceCents: 123, notes: '', customerProductCode: '' }] }));
  const order = (await f.imports.upload(imageFixture(), '虚构客户订单.png', false)).workspace;
  await f.imports.analyze(order.id, { expectedRevision: order.revision }, undefined, actor);
  const arrival = (await f.imports.upload(imageFixture(true), '虚构供应商送货单.jpg', false, 'arrival')).workspace;
  const { source } = await prepareArrivalRecognition(f.imports, receiptAi, arrival.id, actor);
  await receiptAi.analyze(source.id, { force: false }, actor);
}
// 出错记录和运行日志放在这个实例的临时目录里；助手的只读工具接法和 server/index.ts 一样
const { ProblemLog } = await import('../../server/core/index.ts');
const { RunLog, captureProcessOutput, programSource } = await import('../../server/system/index.ts');
const problems = new ProblemLog(join(f.dir, 'logs', 'problems.sqlite'));
const runLog = new RunLog(join(f.dir, 'logs', 'run.log'));
captureProcessOutput(runLog);
// 联网替身（只在模型替身实例）：搜索每个词回三条虚构结果（一条网址不是 http 的，来源里不该出现），读网页回一段虚构正文；
// 各等一会儿，界面上看得到“正在联网搜索：……”
if (!real) {
  const slow = () => new Promise((r) => setTimeout(r, 1500));
  f.settings.webSearch = async ({ query }) => {
    await slow();
    return [1, 2, 3].map((n) => ({
      title: `虚构资讯：${query}（${n}）`,
      url: n === 3 ? 'javascript:alert(1)' : `https://example.com/news/${encodeURIComponent(query)}/${n}`,
      siteName: '虚构资讯网', date: n === 1 ? today() : null, summary: `虚构摘要：${query} 第 ${n} 条。`, snippet: '', score: 0, authority: 0,
    }));
  };
  f.settings.webFetch = async (url) => {
    await slow();
    return { url, title: '虚构网页全文', content: '虚构正文：本周瓦楞纸价格持平。' };
  };
}
const backupRoot = mkdtempSync(join(tmpdir(), 'erp-ui-check-backups-'));
// 页面用的助手和正式装配（server/index.ts）一样一次给全；提示词表同一张也挂设置页，备份目录是这个实例自己的临时目录
const { AssistantManager } = await import('../../server/assistant/index.ts');
const { readLoginRecords } = await import('../../server/system/index.ts');
const promptModules = f.deps.prompts;
const assistant = new AssistantManager({
  store: f.store, ai: f.settings, prompts: promptModules, imports: f.imports, execution: f.execution, receiptAi,
  accounts: auth, loginRecords: (who, filter) => readLoginRecords(auth.db, who, filter), bots, deployment: null, problems, runLog,
  source: programSource(), backup: { dataDir: f.dir, backupRoot }, toolSettingsFile: ':memory:',
});
const app = createApp(f.store, { auth, assistant, imports: f.imports, execution: f.execution, aiSettings: f.settings, receiptAi, problems, promptModules, bots });
// 只有这个隔离实例有：界面实测往模型替身里排好下一次的回复（比如让助手提出删除方案），再在页面上点确认卡片
const { createServer } = await import('node:http');
const smoke = real ? (await import('./real-model.mts')).realSmokeHandler(real, (req) => auth.actor(req), assistant.agent) : null;
const server = createServer((req, res) => {
  if (smoke?.(req, res)) return;
  if (!real && req.method === 'POST' && req.url === '/__ui-check/replies') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      // { recognition: {...} } 是放慢下一次识别，别的是助手下一次的回复
      for (const r of queuedReplies.parse(JSON.parse(body || '[]'))) {
        const slow = slowRecognitionEntry.safeParse(r);
        if (slow.success) slowRecognitions.push(slow.data.recognition);
        else f.replies.push(r);
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    });
    return;
  }
  app(req, res);
}).listen(port, '127.0.0.1', () => {
  if (real) {
    console.log(real.fake ? '真实模型模式（自测：连的是假 DeepSeek）' : '真实模型模式：会调用 DeepSeek 并产生费用，密钥在设置页填');
    // 只说有没有，绝不打印密钥
    console.log('已保存密钥：' + (real.settings.view().hasKey ? '是' : '否'));
  }
  console.log('READY http://127.0.0.1:' + port + (remote ? '（模拟从域名访问）' : '') + ' data=' + f.dir);
});
const shutdown = async () => { bots.stop(); await fakeBots.close(); botSettings.close(); auth.close(); problems.close(); f.close(); rmSync(backupRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); process.exit(0); };
process.on('SIGINT', () => server.close(() => void shutdown()));
