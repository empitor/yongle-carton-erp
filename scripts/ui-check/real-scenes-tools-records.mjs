// 第 1 类（一）：档案和查询类工具，每个工具至少一条“普通人会说的话”；写入的两条：说清了直接办成、没说清先问或出卡片。
// 财务查询用“财务”账号（顺带测这个账号）；其余本机管理员。
import { check, freshCustomer, order, replies } from './real-scenes-kit.mjs';

const ask = { writes: false, asks: true };
const fin = (id, title, say, tool) => ({ id, domain: 'tools', account: 'finance', title, look: '查到并按查到的说', turns: [say], expect: { tools: [tool], writes: false } });
export const scenes = [
  fin('R-F1', '财务概览', '财务这边现在有哪些待处理的事？资金账户余额多少？', 'finance.summary'),
  fin('R-F2', '本月盈亏', '这个月理论上赚了多少钱？', 'finance.monthly'),
  fin('R-F3', '某客户欠款', '虚构东海电器有限公司现在还欠我们多少钱？', 'finance.receivables'),
  fin('R-F4', '欠供应商', '我们还欠虚构鼎盛纸业多少钱？', 'finance.payables'),
  fin('R-F5', '凭证明细账', '看一下本月的凭证明细账', 'finance.ledger'),
  fin('R-F6', '正式报表', '出一下上个月的利润表', 'finance.reports'),
  fin('R-F7', '发票', '这个月开了哪些发票？', 'finance.invoices'),
  fin('R-F8', '收付款', '最近有哪些收款和付款？', 'finance.cash'),
  { id: 'R1', domain: 'tools', account: 'local', title: '按客户查订单', look: '列出这家客户的订单', turns: ['虚构东海电器有限公司最近有哪些订单？'], expect: { tools: ['records.search'], writes: false } },
  { id: 'R2', domain: 'tools', account: 'local', title: '一张订单的完整信息', look: '单号、客户、明细、交期对',
    setup: async (ctx) => ({ o: await order(ctx) }),
    turns: [(ctx) => `订单 ${ctx.vars.o.number} 的完整信息给我看看`],
    expect: { oneOf: [['records.get', 'records.search']], writes: false },
    check: (ctx, r) => [check('回答里有客户名', replies(r).includes(ctx.vars.o.customerName.replace('有限公司', '')), '', 'C')] },
  { id: 'R3', domain: 'tools', account: 'local', title: '汇总', look: '按客户汇总的只数，和库里一致', turns: ['所有已确认的订单一共多少只？按客户分别是多少？'], expect: { tools: ['records.summarize'], writes: false } },
  { id: 'R4', domain: 'tools', account: 'local', title: '经营概况', look: '最近两个月订单、采购、流水概况', turns: ['最近两个月经营概况怎么样？'], expect: { tools: ['overview.get'], writes: false } },
  { id: 'R5a', domain: 'tools', account: 'local', title: '新建客户（说清了）', look: '出新建卡片，点确认后建好',
    turns: [{ say: '新建客户 虚构测试新客户甲，联系人 张三，电话 0574-2222-3333，地址 虚构路9号', confirm: true }],
    expect: { tools: ['records.propose_save'], rows: { customers: { added: 1 } } },
    check: (ctx) => [check('建对了', ctx.q("SELECT phone FROM customers WHERE name='虚构测试新客户甲'")[0]?.phone === '0574-2222-3333', '', 'B')] },
  { id: 'R5b', domain: 'tools', account: 'local', title: '新建客户（没说清）', look: '先问名字、联系方式，不编，不出卡片、不写库', turns: ['新建一个客户'], expect: { writes: false, card: false, reply: { has: [/名称|名字|客户名/] } } },
  { id: 'R6a', domain: 'tools', account: 'local', title: '归档再恢复一个客户', look: '归档、恢复都办成（直接或卡片确认后）',
    setup: async (ctx) => ({ c: await freshCustomer(ctx) }),
    turns: [{ say: (ctx) => `把客户 ${ctx.vars.c.name} 归档`, confirm: true }, { say: (ctx) => `把刚才归档的客户 ${ctx.vars.c.name} 恢复`, confirm: true }],
    expect: { tools: ['records.propose_lifecycle'] },
    check: (ctx, r) => [check('归档、恢复都办成', r.confirmations.filter((c) => c.ok && c.tool === 'records.propose_lifecycle').length >= 2, r.confirmations.map((c) => c.card + (c.ok ? '' : '：' + c.message)).join('；'), 'B'), check('最后没归档', !ctx.q("SELECT 1 FROM record_lifecycle WHERE entity='customers' AND record_id=? AND archived_at IS NOT NULL", ctx.vars.c.id).length, '', 'B')] },
  { id: 'R6b', domain: 'tools', account: 'local', title: '归档（没说清）', look: '先问是哪个', turns: ['把那个不用的客户归档'], expect: ask },
  { id: 'R7', domain: 'tools', account: 'local', title: '批量归档', look: '两个一起归档（卡片确认后）',
    setup: async (ctx) => ({ a: await freshCustomer(ctx), b: await freshCustomer(ctx) }),
    turns: [{ say: (ctx) => `把客户 ${ctx.vars.a.name} 和 ${ctx.vars.b.name} 都归档`, confirm: true }],
    expect: { tools: ['records.propose_batch_lifecycle'], rows: { record_lifecycle: { added: 2 } } },
    check: (ctx) => {
      const n = ctx.q("SELECT COUNT(*) n FROM record_lifecycle WHERE entity='customers' AND record_id IN (?,?)", ctx.vars.a.id, ctx.vars.b.id)[0].n;
      return [check('两个客户都归档了', n === 2, '归档了 ' + n + ' 个', 'B')];
    } },
  { id: 'R8', domain: 'tools', account: 'local', title: '删除（没说清）', look: '先问删哪个，不出删除卡片', turns: ['把没用的客户删了'], expect: { ...ask, card: false } },
  { id: 'R9', domain: 'tools', account: 'local', title: '查唛头', look: '说有没有唛头', turns: ['电饭煲外箱 3L 有没有唛头？'], expect: { tools: ['marks.list'], writes: false } },
  { id: 'R10', domain: 'tools', account: 'local', title: '收件箱列表', look: '列出待处理消息', turns: ['收件箱里有什么新消息？'], expect: { tools: ['inbox.list'], writes: false } },
  { id: 'R11', domain: 'tools', account: 'local', title: '一条收件的详情', look: '读那一条的完整内容和状态', turns: ['收件箱里李工那条消息，把完整内容、发送人和现在的处理状态给我'], expect: { tools: ['inbox.list'], writes: false } },
  { id: 'R12a', domain: 'tools', account: 'local', title: '收件标成已处理（说清了）', look: '那一条变成已处理',
    turns: [{ say: '把收件箱里李工那条（吹风机彩箱再加500只）标成已处理', confirm: true }],
    expect: { tools: ['inbox.set_status'], rows: { inbox_items: { changed: 1 } } },
    check: (ctx) => {
      const s = ctx.q("SELECT status FROM inbox_items WHERE sender_name='李工' AND text LIKE '%吹风机彩箱%'")[0]?.status;
      return [check('李工那条标成已处理', s === 'converted', s, 'B')];
    } },
  { id: 'R12b', domain: 'tools', account: 'local', title: '收件标状态（没说清）', look: '先问是哪条、标成什么', turns: ['收件箱那条处理掉'], expect: ask },
  { id: 'R13a', domain: 'tools', account: 'local', title: '放进收件箱（说清了）', look: '收件箱多一条', turns: [{ say: '把这句话放进收件箱：虚构客户来电，下周要 500 只五金配件箱 小', confirm: true }], expect: { tools: ['inbox.add'], rows: { inbox_items: { added: 1 } } },
    check: (ctx) => {
      const t = ctx.q("SELECT text FROM inbox_items ORDER BY id DESC LIMIT 1")[0]?.text ?? '';
      return [check('收件箱多的那条是用户的原话', t.includes('五金配件箱') && t.includes('500'), t.slice(0, 60), 'C')];
    } },
  { id: 'R13b', domain: 'tools', account: 'local', title: '放进收件箱（没说清）', look: '先问放什么', turns: ['帮我往收件箱里放一条'], expect: ask },
  { id: 'R14', domain: 'tools', account: 'local', title: '修改历史', look: '谁在什么时候改了什么', turns: ['客户 虚构东海电器有限公司 的资料谁改过？什么时候建的？'], expect: { tools: ['history.records'], writes: false } },
  { id: 'R15', domain: 'tools', account: 'local', title: 'AI 状况', look: '余额、密钥、识别失败', turns: ['AI 现在余额还剩多少？最近识别有没有失败的？'], expect: { tools: ['ai.status'], writes: false } },
  { id: 'R16', domain: 'tools', account: 'local', title: '后台任务', look: '识别排队、没导出完的单据', turns: ['后台现在有没有在识别的文件，或者没导出完的单据？'], expect: { tools: ['jobs.status'], writes: false } },
  { id: 'R17', domain: 'tools', account: 'local', title: '最近导出', look: '列出最近导出的单据或说没有', turns: ['最近导出过哪些单据文件？'], expect: { tools: ['exports.list'], writes: false } },
  { id: 'R18', domain: 'tools', account: 'local', title: '打开页面', look: '打开那张订单的页面',
    setup: async (ctx) => ({ o: await order(ctx) }),
    turns: [(ctx) => `打开订单 ${ctx.vars.o.number} 的页面`], expect: { tools: ['ui.open'], writes: false } },
  { id: 'R19', domain: 'tools', account: 'local', title: '当天仓库安排', look: '今天的送货、到货', turns: ['今天仓库有哪些送货和到货安排？'], expect: { tools: ['flow.daily'], writes: false } },
  { id: 'R20', domain: 'tools', account: 'local', title: '单据模板', look: '订货单、送货单用的模板', turns: ['订货单和送货单现在用的是哪个模板、什么格式？'], expect: { tools: ['documents.templates'], writes: false } },
  { id: 'R21', domain: 'tools', account: 'local', title: '使用说明', look: '照使用说明讲怎么登记到货', turns: ['使用说明里是怎么讲登记到货的？'], expect: { tools: ['guide.read'], writes: false } },
];
