// 第 3 类：多步业务流程，一段对话里连着办。出了卡片就点确认（新的确认规则下多数写入会出卡片），再看数据真的变没变。
// 要用的订单都在准备阶段现建，每条各用各的，互不影响。
import { check, day, flowRow, freshCustomer, list, replies, reversedDelivery, stockSum, UNITS } from './real-scenes-kit.mjs';

/** 现建一张已确认的订单（一行，单位只） */
async function freshOrder(ctx, productName, quantity) {
  const c = await freshCustomer(ctx);
  const p = ctx.q('SELECT id,name FROM products WHERE name=?', productName)[0];
  return ctx.admin.api('/api/orders', {
    customerId: c.id, orderDate: day(0), deliveryDate: day(5), status: '已确认', notes: '', costs: null, externalPurchaseOrder: '', taxRate: '13%', taxMode: '含税', roundingPolicy: 'half-up-cent',
    lines: [{ productId: p.id, productName: p.name, specification: '', quantity, unit: '只', unitPriceCents: 250, notes: '', customerProductCode: '' }],
  });
}
/** 现建一张两个产品的已确认订单 */
async function freshOrder2(ctx, names, quantity) {
  const c = await freshCustomer(ctx);
  const lines = names.map((n) => ctx.q('SELECT id,name FROM products WHERE name=?', n)[0]).map((p) => ({ productId: p.id, productName: p.name, specification: '', quantity, unit: '只', unitPriceCents: 250, notes: '', customerProductCode: '' }));
  return ctx.admin.api('/api/orders', { customerId: c.id, orderDate: day(0), deliveryDate: day(20), status: '已确认', notes: '', costs: null, externalPurchaseOrder: '', taxRate: '13%', taxMode: '含税', roundingPolicy: 'half-up-cent', lines });
}
const confirmAll = (say) => ({ say, confirm: true });
const TASK_NO = /SC-\d{8}-\d{3,6}/g;
const count = (ctx, sql, ...p) => ctx.q(sql, ...p)[0]?.n ?? 0;
const BOARD = 'BC五层纸板 1250×1000';

export const scenes = [
  { id: 'F1', domain: 'flows', account: 'local', title: '订单识别→核对修改→导入', look: '识别、看、改数量、撤销、再改、匹配客户、预览、导入（还差产品关联时补一句）；只导入一次，水壶外箱 900 只',
    // 订单号每次不同：两种做法在同一个实例上跑，同一张单第二次会被查重拦下
    setup: async (ctx) => ({ before: count(ctx, "SELECT COUNT(*) n FROM orders WHERE customer_name LIKE '%东海电器%'"), po: 'PO-XG-' + Date.now().toString().slice(-6) }),
    turns: [{ say: '识别这份订单', attach: [(ctx) => ctx.files.orderXlsx({ po: ctx.vars.po })] }, '识别结果给我看看，客户、数量、金额对不对？', '把水壶外箱的数量改成 900 只', '撤销刚才的修改', '还是改成 900 只吧', '客户匹配一下', { say: '导入前给我看看预览', after: (ctx) => (ctx.vars.afterPreview = count(ctx, "SELECT COUNT(*) n FROM orders WHERE customer_name LIKE '%东海电器%'")) }, confirmAll('导入'), confirmAll('要是还没导入：电饭煲外箱 3L 和 水壶外箱 都关联已有的同名产品档案，然后导入；已经导入了就不用再导')],
    expect: { tools: ['order_import.start', 'order_import.edit', 'order_import.undo', 'order_import.match', 'order_import.preview', 'order_import.execute'], oneOf: [['order_import.get']],
      // 一张订单连明细；匹配、关联档案时客户、产品、成品库存品可能跟着建或补
      rows: { orders: { added: 1 }, order_lines: { added: 'any' }, customers: 'any', products: 'any', stock_items: 'any' } },
    check: (ctx) => {
      const made = count(ctx, "SELECT COUNT(*) n FROM orders WHERE customer_name LIKE '%东海电器%'") - ctx.vars.before;
      const qty = ctx.q("SELECT l.quantity q FROM order_lines l JOIN orders o ON o.id=l.order_id WHERE l.product_name LIKE '%水壶外箱%' AND o.external_purchase_order=? ORDER BY o.id DESC LIMIT 1", ctx.vars.po)[0]?.q;
      return [
        check('只导入了一张', made === 1, '新增 ' + made + ' 张', 'A'),
        check('水壶外箱 900 只', qty === 900, String(qty), 'A'),
        check('“导入前给我看看预览”没有导入', ctx.vars.afterPreview === ctx.vars.before, '看预览后多了 ' + (ctx.vars.afterPreview - ctx.vars.before) + ' 张', 'A'),
      ];
    } },
  { id: 'F2', domain: 'flows', account: 'local', title: '采购→导出订货单→待到货→到货→更正→退货', look: '每一步都办成，数量对，没有重复建单、重复入库',
    setup: async (ctx) => ({ before: count(ctx, "SELECT COUNT(*) n FROM purchases WHERE supplier_name='虚构华美瓦楞'"), stock: stockSum(ctx, BOARD), ret: ctx.q('SELECT COALESCE(MAX(id),0) m FROM purchase_returns')[0].m }),
    turns: [
      { say: `给虚构华美瓦楞下一张采购单：BC五层纸板 1250×1000 1000 张，单价 3.2000 元一张，预计 ${day(7)} 到`, confirm: 'chain' },
      confirmAll('这张采购单导出 Excel 订货单发给供应商，标成已订货'),
      '待到货里有它吗？还差多少？',
      confirmAll('这张采购单今天到货 800 张，其中 20 张不合格，合格的全部入库，供应商送货单号 HM-SD-1'),
      confirmAll('刚才那张到货单登记错了，实到其实是 780 张，不合格还是 20 张，合格的全部入库'),
      confirmAll('从这张到货单退 30 张给供应商，原因：边角压坏，退货日期今天'),
    ],
    // 采购单一张；到货单两张（登记错的那张被冲销替代，新单接上）；退货单一张
    expect: { tools: ['records.propose_save', 'documents.export', 'order_batch.receive', 'arrival.correct', 'purchase_return.create'], oneOf: [['order_batch.get', 'order_batch.list']],
      rows: { purchases: { added: 1 }, purchase_lines: { added: 'any' }, order_batches: { added: 'any' }, order_batch_purchases: { added: 'any' }, flow_documents: { added: 2 }, purchase_returns: { added: 1 }, stock_movements: { added: 'any' }, stock_items: 'any' } },
    check: (ctx) => {
      const p = ctx.q("SELECT id, status FROM purchases WHERE supplier_name='虚构华美瓦楞' ORDER BY id DESC LIMIT 1")[0];
      const net = (stockSum(ctx, BOARD) - ctx.vars.stock) / UNITS;
      const back = ctx.q('SELECT document FROM purchase_returns WHERE id>?', ctx.vars.ret).flatMap((r) => JSON.parse(r.document).lines ?? []);
      return [
        check('只建了一张采购单', count(ctx, "SELECT COUNT(*) n FROM purchases WHERE supplier_name='虚构华美瓦楞'") - ctx.vars.before === 1, '', 'A'),
        check('采购单已订货', p?.status === '已订货', p?.status, 'B'),
        check('退了 30 张', back.reduce((n, l) => n + Number(l.quantity), 0) === 30, back.map((l) => l.quantity).join('、') || '没有退货', 'A'),
        check('纸板库存净增 730 张（合格 760 退 30）', net === 730, '净增 ' + net, 'A'),
      ];
    } },
  { id: 'F3', domain: 'flows', account: 'local', title: '安排生产→下达→完工→批次备注', look: '建一张任务、下达、完工 200 只领料 60 张、写备注；不用万能工具绕路',
    setup: async (ctx) => ({ o: await freshOrder(ctx, '五金配件箱 大', 400), tasks: count(ctx, "SELECT COUNT(*) n FROM flow_documents WHERE kind='task'"), last: ctx.q('SELECT COALESCE(MAX(id),0) m FROM flow_documents')[0].m, seq: ctx.q('SELECT COALESCE(MAX(seq),0) m FROM stock_movements')[0].m }),
    turns: [confirmAll((ctx) => `给订单 ${ctx.vars.o.number} 安排生产`), confirmAll('刚才那张生产任务下达'), confirmAll('刚才那张任务完工了，做了 200 只，用了 BC五层纸板 1250×1000 60 张'), confirmAll('今天完工的，200 只都是良品，没有废品'), confirmAll('这一批的批次备注写上：首批试产')],
    // 生产任务一张、完工单一张；成品库存品第一次完工才建
    expect: { tools: ['records.propose_save', 'flow.propose_production_completion', 'flow.edit_info'], oneOf: [['production.plan'], ['flow.propose_confirmation', 'records.propose_save']], avoid: ['management.execute'],
      rows: { flow_documents: { added: 2 }, stock_movements: { added: 'any' }, orders: { changed: 1 }, stock_items: 'any' } },
    check: (ctx) => {
      const made = ctx.q('SELECT id, kind FROM flow_documents WHERE id>?', ctx.vars.last).map((d) => flowRow(ctx, d.id));
      const task = made.find((d) => d.kind === 'task'),
        prod = made.find((d) => d.kind === 'production');
      const moves = ctx.q("SELECT delta_units d FROM stock_movements WHERE source_kind='flow_production' AND seq>?", ctx.vars.seq).map((m) => m.d / UNITS);
      return [
        check('只建了一张任务', count(ctx, "SELECT COUNT(*) n FROM flow_documents WHERE kind='task'") - ctx.vars.tasks === 1, '', 'A'),
        check('任务 400 只、完工 200 只', Number(task?.doc.quantity) === 400 && Number(prod?.doc.goodQuantity) === 200, `任务 ${task?.doc.quantity}，完工 ${prod?.doc.goodQuantity}`, 'A'),
        check('入库 200 只、领料 60 张', moves.includes(200) && moves.includes(-60) && moves.length === 2, moves.join(',') || '没有流水', 'A'),
        check('批次备注写上了', (prod?.doc.notes ?? '').includes('首批试产'), prod?.doc.notes, 'B'),
      ];
    } },
  { id: 'F4', domain: 'flows', account: 'local', title: '安排送货→出库→确认送达→冲销', look: '建送货单、出库、记送达、冲销；库存先减后回',
    setup: async (ctx) => {
      const item = (await list(ctx, '/api/warehouse/items')).filter((i) => i.kind === 'finished' && Number(i.availableUnits ?? i.quantity) >= 100).sort((a, b) => Number(b.quantity) - Number(a.quantity))[0];
      return { item, o: await freshOrder(ctx, item.name, 100), last: ctx.q('SELECT COALESCE(MAX(id),0) m FROM flow_documents')[0].m, stock: stockSum(ctx, item.name) };
    },
    turns: [
      confirmAll((ctx) => `成品 ${ctx.vars.item.name} 给订单 ${ctx.vars.o.number} 安排送货 100 只，送货日期今天`),
      confirmAll('这张送货单现在出库'),
      confirmAll('客户今天收到了，确认送达'),
      confirmAll('这张送货单冲销，原因：送错了货'),
    ],
    expect: { tools: ['records.propose_save', 'delivery.mark_delivered', 'flow.propose_reversal'], oneOf: [['flow.propose_confirmation', 'documents.export']], rows: { flow_documents: { added: 1 }, stock_movements: { added: 'any' } } },
    check: (ctx) => {
      const d = ctx.q("SELECT id FROM flow_documents WHERE kind='delivery' AND id>?", ctx.vars.last);
      return [
        check('只建了一张送货单', d.length === 1, d.length + ' 张', 'A'),
        ...(d.length ? reversedDelivery(ctx, d[0].id, '送错') : []),
        check('成品库存回到原数', stockSum(ctx, ctx.vars.item.name) === ctx.vars.stock, '差 ' + (stockSum(ctx, ctx.vars.item.name) - ctx.vars.stock) / UNITS, 'A'),
      ];
    } },
  { id: 'F5', domain: 'flows', account: 'finance', title: '财务查询串', look: '应收应付、账龄、凭证、报表、盈亏各答各的，数字来自工具',
    turns: ['这个月应收应付大概什么情况？', '虚构东海电器有限公司的欠款账龄怎么样，有没有逾期的？', '本月凭证明细账有吗？', '上个月的资产负债表出得来吗？', '这个月理论盈亏多少？'],
    expect: { tools: ['finance.receivables', 'finance.ledger', 'finance.reports', 'finance.monthly'], writes: false } },
  { id: 'F6', domain: 'flows', account: 'local', title: '归档→查归档→恢复', look: '归档、能查到归档的、恢复',
    setup: async (ctx) => ({ c: await freshCustomer(ctx) }),
    turns: [confirmAll((ctx) => `把客户 ${ctx.vars.c.name} 归档`), '现在有哪些归档了的客户？', confirmAll('把它恢复')],
    expect: { tools: ['records.propose_lifecycle'] },
    check: (ctx, r) => [check('归档、恢复都办成', r.confirmations.filter((c) => c.ok && c.tool === 'records.propose_lifecycle').length >= 2, r.confirmations.map((c) => c.card + (c.ok ? '' : '：' + c.message)).join('；'), 'B'), check('最后没归档', !ctx.q("SELECT 1 FROM record_lifecycle WHERE entity='customers' AND record_id=? AND archived_at IS NOT NULL", ctx.vars.c.id).length, '', 'B')] },
  { id: 'F7', domain: 'flows', account: 'local', title: '删除：卡片、改库存处理、确认', look: '删完工单出删除卡片；卡片上改成“库存不动”再确认；删掉了、库存数量没变',
    setup: async (ctx) => {
      const prod = (await list(ctx, '/api/flow?kind=production')).find((d) => d.status === 'confirmed' && !d.archived);
      const stock = ctx.q('SELECT SUM(delta_units) s FROM stock_movements')[0].s;
      return { prod, stock };
    },
    turns: [{ say: (ctx) => `删除完工单 ${ctx.vars.prod.number}`, policy: 'preserve', confirm: true }],
    // 完工单删掉；它的流水留着改挂成“系统维护”流水（库存不动），生产任务的完工数跟着变；留 2 条流水修订记录
    expect: { tools: ['records.delete'], card: true, rows: { flow_documents: { removed: 1, changed: 'any' }, stock_movements: { changed: 'any' }, stock_movement_revisions: { added: 2 } }, confirmed: true },
    check: (ctx, r) => [
      check('完工单删掉了', !ctx.q('SELECT 1 FROM flow_documents WHERE id=?', ctx.vars.prod.id).length, '', 'B'),
      check('库存数量没变（库存不动）', ctx.q('SELECT SUM(delta_units) s FROM stock_movements')[0].s === ctx.vars.stock, '', 'A'),
      check('卡片说了库存怎么处理', /库存/.test(replies(r) + r.turns[0].cards.map((c) => c.label).join('')), '', 'D'),
    ] },
  // 一句话给同一张订单的两种产品安排生产：一条命令、一张卡片，确认后两个任务都建出来；助手报的单号是真的
  ...[['F8', false], ['F8b', true]].map(([id, stale]) => ({
    id, domain: 'flows', account: 'local',
    title: stale ? '安排生产：出卡片后订单变了' : '两个产品一起安排生产',
    look: stale ? '出卡片后改一下订单再点确认：被拦、说清哪条记录变了；助手按最新数据重新出一张，确认后两个任务都建出来' : '一张卡片；确认后两个任务都建出来，助手报的单号都查得到',
    setup: async (ctx) => ({ o: await freshOrder2(ctx, ['食品礼盒外箱', '吹风机彩箱'], 300), last: ctx.q('SELECT MAX(id) m FROM flow_documents')[0].m ?? 0 }),
    turns: [{
      say: (ctx) => `给订单 ${ctx.vars.o.number} 的两个产品都安排生产，各做 300 只，计划 ${day(10)} 完工`,
      confirm: true,
      ...(stale ? { beforeConfirm: async (ctx) => {
        // 卡片绑定的是生产任务、客户、产品的数据（改订单数量不拦，见报告）：出卡片后把这张订单的客户电话改一下
        const c = await ctx.admin.api('/api/customers/' + ctx.vars.o.customerId);
        const r = await ctx.admin.request('/api/customers/' + c.id, { ...c, phone: '0574-6000-7777' }, 'PUT');
        ctx.vars.changed = r.ok ? '改了客户电话' : '改客户失败：' + r.message;
        ctx.vars.customer = c.name;
      } } : {}),
    }],
    expect: { card: true, rows: { flow_documents: { added: 2 }, orders: { changed: 1 }, ...(stale ? { customers: { changed: 1 } } : {}) } },
    check: (ctx, r) => {
      const t0 = r.turns[0] ?? { cards: [] };
      const made = ctx.q("SELECT number FROM flow_documents WHERE kind='task' AND id>?", ctx.vars.last).map((x) => x.number);
      const said = [...new Set(r.turns.slice(1).map((t) => t.reply ?? '').join(' ').match(TASK_NO) ?? [])];
      const first = (r.confirmations ?? [])[0];
      const out = [
        check('第一次只出一张卡片', t0.cards.length === 1, t0.cards.map((c) => c.label).join('；'), 'D'),
        check('两个任务都建出来了', made.length === 2, made.join('、') || '一张都没有', 'B'),
        check('助手报的单号都查得到', said.every((n) => made.includes(n)), '报了 ' + (said.join('、') || '没报') + '；实际 ' + made.join('、'), 'C'),
      ];
      if (stale) out.push(
        check('真的改了客户', ctx.vars.changed === '改了客户电话', ctx.vars.changed ?? '没改', 'B'),
        check('点确认被拦，说清哪条记录变了', first && !first.ok && first.code === 'card-stale' && (first.message ?? '').includes(ctx.vars.customer), first ? (first.code ?? '') + ' ' + first.message : '没点', 'B'),
        check('助手按最新数据重新出了卡片', r.turns.slice(1).some((t) => t.cards.length), r.turns.slice(1).map((t) => t.cards.map((c) => c.label).join('；') || '没出').join(' | '), 'B'),
      );
      return out;
    },
  })),
  // 导出订货单并标已订货：只出导出那一张卡片；确认后采购单是已订货、文件交付成功
  { id: 'F9', domain: 'flows', account: 'local', title: '导出订货单只出一张卡片', look: '只出“导出订货单并标记已订货”一张；确认后已订货、导出交付成功',
    setup: async (ctx) => {
      const s = (await list(ctx, '/api/suppliers'))[0];
      const item = ctx.q("SELECT id FROM stock_items WHERE name='BC五层纸板 1250×1000'")[0]?.id ?? null;
      const p = await ctx.admin.api('/api/purchases', { supplierId: s.id, customerOrderId: null, orderDate: day(0), expectedDate: day(7), status: '待订货', notes: '虚构测试采购单', lines: [{ name: 'BC五层纸板 1250×1000', unit: '张', specification: '', length: 1250, width: 1000, height: null, dimensionUnit: 'mm', material: 'K=A', flute: 'BC', notes: '', stockItemId: item, customerOrderId: null, quantity: '500', priceBasis: 'quantity', unitPrice: '3.1000' }] });
      return { p };
    },
    turns: [confirmAll((ctx) => `把采购单 ${ctx.vars.p.number} 导出 Excel 订货单发给供应商，标成已订货`)],
    expect: { tools: ['documents.export'], card: true, confirmed: true },
    check: (ctx, r) => {
      const cards = r.turns[0]?.cards ?? [];
      const status = ctx.q('SELECT status FROM purchases WHERE id=?', ctx.vars.p.id)[0]?.status;
      return [
        check('只出了导出那一张卡片', cards.length === 1 && /导出/.test(cards[0].label ?? ''), cards.map((c) => c.label).join('；'), 'D'),
        check('采购单已订货', status === '已订货', status, 'B'),
        check('导出交付成功', (r.downloads ?? []).some((d) => d.ok), (r.downloads ?? []).map((d) => d.message).join('；') || '没下载', 'B'),
      ];
    } },
];
