// 全量测试场景共用的小工具（现查数据、现建虚构档案、核对），和“工具清单里不该有什么”的规则。场景的加载在 real-scenes.mjs。
import { randomUUID } from 'node:crypto';

const rows = (v) => (Array.isArray(v) ? v : Object.values(v ?? {}).find(Array.isArray) ?? []);
/** 用管理员会话现查一张列表 */
export const list = async (ctx, path) => rows(await ctx.admin.api(path));
/** 北京时间的日期，days 天以后 */
export const day = (days = 0) => new Date(Date.now() + 8 * 3600_000 + days * 86400_000).toISOString().slice(0, 10);
const tag = () => randomUUID().slice(0, 4);
/** 现建一个虚构客户（名字带随机尾巴，几条场景互不干扰） */
export async function freshCustomer(ctx, prefix = '虚构测试客户') {
  return ctx.admin.api('/api/customers', { name: `${prefix}${tag()}`, contact: '测试联系人', phone: '0574-5555-0000', address: '虚构测试路1号' });
}
/** 现建一个虚构供应商 */
export async function freshSupplier(ctx, prefix = '虚构测试纸业') {
  return ctx.admin.api('/api/suppliers', { name: `${prefix}${tag()}`, contact: '测试联系人', phone: '0574-5555-1000', address: '虚构测试工业区' });
}
/** 第一条符合条件的单据（flow：task / production / delivery / arrival） */
export const flowDoc = async (ctx, kind, test = () => true) => (await list(ctx, '/api/flow?kind=' + kind)).find(test);
export const order = async (ctx, test = () => true) => (await list(ctx, '/api/orders')).find(test);
export const purchase = async (ctx, test = () => true) => (await list(ctx, '/api/purchases')).find(test);
/** 记录里某张表某行现在的样子（判数字用） */
export const row = (ctx, table, id) => ctx.q(`SELECT * FROM "${table}" WHERE id=?`, id)[0];
/** 库存流水合计（库里按千分之一只/张存）：给了库存品名就只算这一种 */
export const stockSum = (ctx, itemName) =>
  itemName
    ? ctx.q('SELECT COALESCE(SUM(m.delta_units),0) s FROM stock_movements m JOIN stock_items i ON i.id=m.item_id WHERE i.name=?', itemName)[0].s
    : ctx.q('SELECT COALESCE(SUM(delta_units),0) s FROM stock_movements')[0].s;
export const UNITS = 1000;
/** 一张单据现在的样子（状态、计划日期、送达日期、被谁替代），doc 是解析好的 document */
export const flowRow = (ctx, id) => {
  const r = ctx.q('SELECT * FROM flow_documents WHERE id=?', id)[0];
  return r && { ...r, doc: JSON.parse(r.document) };
};
/** 场景自己的核对：一条 */
export const check = (name, ok, detail = '', level = 'C') => ({ name, ok: !!ok, detail: String(detail), level });
/** 送货单冲销了、原因是用户说的、出库的数全部退回 */
export const reversedDelivery = (ctx, id, reason) => {
  const r = flowRow(ctx, id);
  const net = ctx.q("SELECT COALESCE(SUM(delta_units),0) s FROM stock_movements WHERE source_kind IN ('flow_delivery','flow_reversal') AND source_id=?", String(id))[0].s;
  return [
    check('冲销了', r?.status === 'reversed', r?.status, 'B'),
    check('原因照用户说的', (r?.doc.reversal?.reason ?? '').includes(reason), r?.doc.reversal?.reason, 'C'),
    check('出库的数全部退回', net === 0, '还差 ' + net / UNITS, 'A'),
  ];
};
/** 这一条场景所有回答拼起来 */
export const replies = (record) => record.turns.map((t) => t.reply ?? '').join('\n');
export const ORDER_DELIVERY_ROWS = { orders: { changed: 1 }, order_lines: { added: 'any', removed: 'any' } };
const ORDER_COLS = 'number, customer_id, customer_name, order_date, delivery_date, status, total_cents, currency, rounding_policy, tax_rate, tax_mode, external_purchase_order, supplier_name, notes, cost_estimate, terms';
/** 改订单交期（G8、A-S6 共用）：记下改前订单与明细，用于核对只有交期变了、明细没动 */
export async function orderDeliverySetup(ctx) {
  const o = await order(ctx, (x) => x.status === '已确认' && x.shippingProgress === '未发货');
  const rowBefore = ctx.q(`SELECT ${ORDER_COLS} FROM orders WHERE id=?`, o.id)[0];
  const lines = ctx.q('SELECT product_id, product_name, quantity, unit_price_e4 FROM order_lines WHERE order_id=? ORDER BY id', o.id);
  return { o, rowBefore, lines };
}
/** 核对只改了订单交期：目标日期对、其余列没变、order_lines 增删相等且内容条数没变 */
export function orderDeliveryChecks(ctx, r, expectedDate) {
  const after = ctx.q(`SELECT ${ORDER_COLS} FROM orders WHERE id=?`, ctx.vars.o.id)[0];
  const lines = ctx.q('SELECT product_id, product_name, quantity, unit_price_e4 FROM order_lines WHERE order_id=? ORDER BY id', ctx.vars.o.id);
  const lineDiff = r.diff?.order_lines ?? { added: 0, removed: 0, changed: 0 };
  return [
    check('交期改对了', after?.delivery_date === expectedDate, after?.delivery_date ?? '', 'B'),
    check('订单只有交期变了', JSON.stringify({ ...after, delivery_date: null }) === JSON.stringify({ ...ctx.vars.rowBefore, delivery_date: null }), '', 'A'),
    check('order_lines 增删条数相等', lineDiff.added === lineDiff.removed && lineDiff.changed === 0, `增${lineDiff.added} 删${lineDiff.removed} 改${lineDiff.changed}`, 'A'),
    check('订单明细内容和条数没变', JSON.stringify(lines) === JSON.stringify(ctx.vars.lines), `${ctx.vars.lines.length}→${lines.length}`, 'A'),
  ];
}
/** 某个工具有没有被调用并执行完（不是失败、被拒）；写入类执行完也只是出了卡片 */
export const ran = (record, tool) => record.turns.some((t) => (t.calls ?? []).some((c) => c.name === tool && c.state === 'completed'));

// —— 每种账号的工具清单规则：清单里出现了它用不了（或不该给）的工具就是问题 ——
const LOCAL_ONLY_WRITES = ['management.execute', 'management.reset', 'management.workspaces', 'management.reset_preview', 'system.backup'];
const SUPER_ONLY = ['accounts.list', 'settings.view', 'accounts.events', 'logs.read', 'source.search', 'source.read', 'prompts.propose', 'production.correct', 'system.status', 'system.check', 'management.context', 'management.delete_preview'];
const CASHIER_OK = (n) => /^(finance|page|chat|task|attachments|ui)\./.test(n) || ['system.status', 'system.check', 'web.search', 'web.read', 'guide.read', 'diagnostics.errors'].includes(n);
const READ_ONLY = (n) => /\.(search|list|get|read|status|check|summary|monthly|receivables|payables|ledger|reports|invoices|cash|plan|draft|records|returnable|batches|preview|templates|daily|observe|act|verify|open|events|errors|context|delete_preview|reset_preview|propose|activate|finish|summarize)$/.test(n) && !/^(order_import|management\.workspaces)/.test(n);
export function toolListChecks(account, usable) {
  const has = (n) => usable.includes(n);
  const out = [];
  const none = (label, names, level = 'A') => {
    const bad = names.filter(has);
    out.push(check(label, !bad.length, bad.join(' '), level));
  };
  if (account !== 'local') none('清单里没有只能在服务器本机做的写入', LOCAL_ONLY_WRITES);
  if (!['local', 'remote', 'remote-super'].includes(account)) none('清单里没有只给超级管理员的工具', SUPER_ONLY);
  if (['staff', 'viewer'].includes(account)) none('清单里没有财务工具', usable.filter((n) => n.startsWith('finance.')));
  if (account === 'viewer') none('只读账号清单里没有写入工具', usable.filter((n) => !READ_ONLY(n)));
  if (account === 'cashier') none('出纳清单里只有财务和通用工具', usable.filter((n) => !CASHIER_OK(n)));
  if (['finance', 'cashier', 'local'].includes(account)) out.push(check('清单里有财务查询', usable.some((n) => n.startsWith('finance.')), usable.length + ' 个工具', 'B'));
  out.push(check('清单里没有财务写入工具', !usable.some((n) => n.startsWith('finance.') && !READ_ONLY(n)), '', 'A'));
  return out;
}
