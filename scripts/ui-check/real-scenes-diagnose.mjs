// 第 7 类排查能力、第 11 类回答质量。排查：故意造一次版本冲突和一次页面报错，再问“刚才为什么失败”；登录记录、运行日志、修改历史、设置、
// 后台任务、程序代码、使用说明各有工具场景（real-scenes-tools-*.mjs、real-scenes-access.mjs）。回答质量：数字和单号和库里比、查无此人不编、该问的问。
import { check, freshCustomer, list, replies } from './real-scenes-kit.mjs';

const S = ({ expect, ...scene }) => ({ domain: 'diagnose', account: 'local', ...scene, expect: { writes: false, ...expect } });
const num = (n) => [String(n), Number(n).toLocaleString('en-US')];
const hasNum = (text, n) => num(n).some((s) => text.includes(s));

export const scenes = [
  S({ id: 'D1', title: '版本冲突后问为什么失败', look: '说出是别处先改了（版本冲突），刷新再改',
    turns: ['刚才我改客户资料保存失败了，为什么？'], expect: { tools: ['diagnostics.errors'], reply: { has: [/别处|别人|其他页面|版本|已被.*修改|刷新/] } },
    setup: async (ctx) => {
      const c = await freshCustomer(ctx);
      await ctx.s.api('/api/customers/' + c.id, { ...c, notes: '第一次保存' }, 'PUT');
      const stale = await ctx.s.request('/api/customers/' + c.id, { ...c, notes: '第二次保存（旧版本）' }, 'PUT');
      return { c, status: stale.status };
    } }),
  S({ id: 'D2', title: '页面报错后问怎么回事', look: '查到页面报错那条，说清在哪个页面、什么错',
    turns: ['订单页面刚才弹了个错误，怎么回事？'], expect: { tools: ['diagnostics.errors'], reply: { has: [/lines|订单/] } },
    setup: async (ctx) => { await ctx.s.api('/api/diagnostics/page-problems', { problems: [{ kind: 'script', message: 'TypeError: Cannot read properties of undefined (reading \'lines\')', page: '#orders' }] }); return {}; } }),
  S({ id: 'Q1', title: '本月原材料进了多少（和库里比）', look: '按规格分的张数和到货入库流水一致', turns: ['这个月原材料一共进了多少张？按规格分别是多少？'], expect: {},
    check: (ctx, r) => {
      const month = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 7);
      const rows = ctx.q("SELECT i.name, SUM(m.delta_units) / 1000 n FROM stock_movements m JOIN stock_items i ON i.id=m.item_id WHERE i.kind='raw' AND m.delta_units>0 AND m.source_kind='flow_arrival' AND substr(m.date,1,7)=? GROUP BY i.name", month);
      return rows.map((x) => check(`${x.name} ${x.n} 张`, hasNum(replies(r), x.n), replies(r).slice(0, 120)));
    } }),
  S({ id: 'Q2', title: '某种纸板现在库存（和库里比）', look: '张数和库存品余额一致', turns: ['BC五层纸板 1250×1000 现在库存多少张？可用多少？'], expect: { oneOf: [['records.search', 'records.get']] },
    check: async (ctx, r) => { const it = (await list(ctx, '/api/warehouse/items')).find((i) => i.name === 'BC五层纸板 1250×1000'); return [check('余额对', hasNum(replies(r), it.quantity), `库里 ${it.quantity}`)]; } }),
  S({ id: 'Q3', title: '部分发货说清送了多少、还差多少', look: '和订单明细、送货单一致', turns: [(ctx) => `订单 ${ctx.vars.o.number} 为什么显示部分发货？送了多少、还差多少？`], expect: {},
    setup: async (ctx) => ({ o: (await list(ctx, '/api/orders')).find((o) => o.shippingProgress === '部分发货') }),
      check: (ctx, r) => {
        const l = ctx.vars.o?.lines?.[0];
        if (!l) return [check('种子里有部分发货的订单', false, '', 'B')];
        const shipped = -(ctx.q("SELECT SUM(delta_units) / 1000 n FROM stock_movements WHERE customer_order_id=? AND source_kind='flow_delivery'", ctx.vars.o.id)[0].n ?? 0);
        return [check(`送了 ${shipped}、还差 ${l.quantity - shipped}`, hasNum(replies(r), shipped) && hasNum(replies(r), l.quantity - shipped), replies(r).slice(0, 120))];
      } }),
  S({ id: 'Q4', title: '一家客户下过几张订单（和库里比）', look: '张数一致', turns: ['虚构东海电器有限公司一共下过几张订单？'], expect: {},
    check: (ctx, r) => { const n = ctx.q("SELECT COUNT(*) n FROM orders WHERE customer_name='虚构东海电器有限公司'")[0].n; return [check(`${n} 张`, new RegExp(`(^|[^0-9])${n}\\s*张`).test(replies(r)), replies(r).slice(0, 120))]; } }),
  S({ id: 'Q5', title: '查无此人不编', look: '说没有这家，不编电话', turns: ['虚构不存在纸业的电话是多少？'], expect: { reply: { has: [/没有|查不到|不存在|找不到/] } } }),
  S({ id: 'Q6', title: '供应商名字对不上几家', look: '先问是哪家，不下单', turns: ['给虚构纸业下个采购单，BC五层纸板 1000 张'], expect: { asks: true } }),
  S({ id: 'Q7', title: '没说单价不编单价', look: '先问单价或单价留空；不编一个价', turns: ['给虚构鼎盛纸业下个采购单，BC五层纸板 1250×1000 1000 张'], expect: {},
    setup: async (ctx) => ({ before: ctx.q('SELECT MAX(id) m FROM purchases')[0].m }),
      check: (ctx, r) => {
        const made = ctx.q('SELECT l.document d FROM purchase_lines l JOIN purchases p ON p.id=l.purchase_id WHERE p.id>?', ctx.vars.before);
        const prices = made.map((x) => JSON.parse(x.d).unitPrice).filter((p) => p && Number(p) > 0);
        const cardPrices = r.turns.flatMap((t) => t.cards).map((c) => JSON.stringify(c.args)).join('').match(/"unitPrice":"([\d.]+)"/g) ?? [];
        return [check('没编单价', !prices.length && !cardPrices.some((p) => !/"0(\.0+)?"/.test(p)), [...prices, ...cardPrices].join(' '), 'C')];
      } }),
  // 原 real-ab.mjs 的两条多步排查（并进来了）
  S({ id: 'D3', title: '库存和到货数对不上', look: '查了到货、领料、流水，说清差在哪', turns: ['BC五层纸板 1250×1000 的库存和到货数为什么对不上？'], expect: { oneOf: [['arrival.records', 'records.search']] } }),
  S({ id: 'D4', title: '应收为什么是空的', look: '说清应收从哪来、缺什么（税率、财务没启用）', turns: ['客户 虚构东海电器有限公司 到底欠我们多少钱？应收为什么是空的？'], expect: { tools: ['finance.receivables'] } }),
];
