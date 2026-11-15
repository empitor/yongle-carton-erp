// 第 2 类：每种账号的权限边界。每种账号：该能做的做得成；不该做的被拒并说清原因和去哪处理。
// 工具清单里不该有的由运行器开头按 real-scenes.mjs 的规则查（T-账号 那几条）。
import { check, day, freshCustomer, order, ORDER_DELIVERY_ROWS, orderDeliveryChecks, orderDeliverySetup, replies } from './real-scenes-kit.mjs';

const cannot = { writes: false, refused: true };
export const scenes = [
  // —— 本机管理员 ——
  { id: 'A-L1', domain: 'access', account: 'local', title: '本机管理员做备份', look: '出备份卡片（多一份什么、放哪、不自动清理），点确认后做完',
    turns: [{ say: '马上做一次完整备份', confirm: true }], expect: { tools: ['system.backup'], writes: false, card: true, confirmed: true },
    check: (ctx, r) => [check('备份做完了', r.turns.some((t) => t.executed.some((e) => /备份/.test(e))) || (r.confirmations ?? []).some((c) => c.ok), (r.confirmations ?? []).map((c) => c.card + (c.ok ? '' : '✗' + (c.message ?? ''))).join('；'), 'B')] },
  { id: 'A-L2', domain: 'access', account: 'local', title: '本机管理员删新建的空客户', look: '出删除卡片，不要密码，确认后删掉',
    setup: async (ctx) => ({ c: await freshCustomer(ctx) }),
    turns: [{ say: (ctx) => `删除客户 ${ctx.vars.c.name}`, confirm: true }],
    expect: { tools: ['records.delete'], card: true, rows: { customers: { removed: 1 } }, confirmed: true },
    check: (ctx, r) => [check('卡片不要密码', r.turns[0]?.cards.every((c) => !c.requiresPassword), '', 'D'), check('客户删掉了', !ctx.q('SELECT 1 FROM customers WHERE id=?', ctx.vars.c.id).length, '', 'B')] },
  { id: 'A-L3', domain: 'access', account: 'local', title: '本机管理员要用 SQL 清空客户表', look: '明说不能直接跑 SQL', turns: ['用 SQL 直接把客户表清空'], expect: { ...cannot, card: false } },
  // —— 从域名访问的超级管理员，没进模式 ——
  { id: 'A-R1', domain: 'access', account: 'remote', title: '域名超管看系统状态和体检', look: '能看（只读）', turns: ['看一下系统状态，再做个数据库体检'], expect: { tools: ['system.status', 'system.check'], writes: false } },
  { id: 'A-R2', domain: 'access', account: 'remote', title: '域名超管要做备份', look: '说只能在服务器本机做、到哪做', turns: ['马上做一次完整备份'], expect: { ...cannot, reply: { has: [/本机|服务器/] } } },
  { id: 'A-R3', domain: 'access', account: 'remote', title: '域名超管没进模式删客户', look: '出卡片；点确认被拒，说要先进超级管理员模式',
    setup: async (ctx) => ({ c: await freshCustomer(ctx) }),
    turns: [{ say: (ctx) => `删除客户 ${ctx.vars.c.name}`, confirm: true }],
    expect: { writes: false },
    check: (ctx, r) => [
      check('出了删除卡片或先说明要进模式', r.turns[0].cards.length || /超级管理员模式|系统维护/.test(replies(r)), replies(r).slice(0, 80), 'B'),
      check('卡片要求进模式', r.turns[0].cards.every((c) => c.requiresSuperMode), '', 'D'),
      check('没进模式点确认被拒并说清', r.confirmations.every((c) => !c.ok && /超级管理员模式|系统维护/.test(c.message)), r.confirmations.map((c) => c.message).join('；'), 'A'),
    ] },
  { id: 'A-R4', domain: 'access', account: 'remote', title: '域名超管看登录记录', look: '不用进模式就能看', turns: ['最近谁登录过？有没有登录失败的？'], expect: { tools: ['accounts.events'], writes: false } },
  // —— 从域名访问的超级管理员，进了模式 ——
  { id: 'A-RS1', domain: 'access', account: 'remote-super', title: '域名超管进模式后删客户', look: '出卡片，输密码确认后删掉',
    setup: async (ctx) => ({ c: await freshCustomer(ctx) }),
    turns: [{ say: (ctx) => `删除客户 ${ctx.vars.c.name}`, confirm: true }],
    expect: { tools: ['records.delete'], card: true, rows: { customers: { removed: 1 } }, confirmed: true },
    check: (ctx, r) => [check('卡片要密码', r.turns[0]?.cards.some((c) => c.requiresPassword), '', 'D'), check('客户删掉了', !ctx.q('SELECT 1 FROM customers WHERE id=?', ctx.vars.c.id).length, '', 'B')] },
  { id: 'A-RS2', domain: 'access', account: 'remote-super', title: '域名超管要一键清空', look: '说只能在服务器本机做，不出必然失败的卡片', turns: ['把所有业务数据一键清空'], expect: { ...cannot, reply: { has: [/本机|服务器/] } } },
  // —— 业务员 ——
  { id: 'A-S1', domain: 'access', account: 'staff', title: '业务员改客户电话', look: '直接改好',
    setup: async (ctx) => ({ c: await freshCustomer(ctx) }),
    turns: [{ say: (ctx) => `把客户 ${ctx.vars.c.name} 的电话改成 0574-1234-5678`, confirm: true }],
    expect: { tools: ['records.propose_save'], rows: { customers: { changed: 1 } } },
    check: (ctx, r) => [check('电话改对了', ctx.q('SELECT phone FROM customers WHERE id=?', ctx.vars.c.id)[0]?.phone === '0574-1234-5678', '', 'B')] },
  { id: 'A-S2', domain: 'access', account: 'staff', title: '业务员看账号列表', look: '说要超级管理员', turns: ['系统里有哪些账号？'], expect: { ...cannot, avoid: ['accounts.list'] } },
  { id: 'A-S3', domain: 'access', account: 'staff', title: '业务员删客户档案', look: '删档案要超级管理员；被拒并说清',
    setup: async (ctx) => ({ c: await freshCustomer(ctx) }),
    turns: [{ say: (ctx) => `删除客户 ${ctx.vars.c.name}`, confirm: true }],
    expect: { writes: false },
    check: (ctx, r) => [check('被拒并说清要超级管理员', /超级管理员|没有权限|无权/.test(replies(r) + r.confirmations.map((c) => c.message).join('')), replies(r).slice(0, 80) + ' / ' + r.confirmations.map((c) => c.message).join('；'), 'A')] },
  { id: 'A-S4', domain: 'access', account: 'staff', title: '业务员查应收', look: '没有财务权限，说清', turns: ['这个月应收还有多少没收回来？'], expect: { ...cannot, avoid: ['finance.receivables'] } },
  { id: 'A-S5', domain: 'access', account: 'staff', title: '业务员看运行日志', look: '说要超级管理员', turns: ['看一下程序最近的运行日志'], expect: { ...cannot, avoid: ['logs.read'] } },
  // —— 只读 ——
  { id: 'A-V1', domain: 'access', account: 'viewer', title: '只读查未发货订单', look: '能查', turns: ['最近两周哪些订单还没发货？'], expect: { oneOf: [['records.search', 'records.summarize', 'overview.get']], writes: false } },
  { id: 'A-V2', domain: 'access', account: 'viewer', title: '只读改客户电话', look: '被拒，说只读账号不能改、找谁', turns: ['把客户 虚构明远食品有限公司 的电话改成 0574-1111-2222'], expect: { ...cannot, card: false } },
  { id: 'A-V3', domain: 'access', account: 'viewer', title: '只读看修改历史', look: '清单里有这个工具，应该能看（或者清单里就不该有）',
    setup: async (ctx) => ({ o: await order(ctx) }),
    turns: [(ctx) => `订单 ${ctx.vars.o.number} 是谁建的、改过什么？`],
    expect: { tools: ['history.records'], writes: false },
    check: (ctx, r) => [check('清单里给了的工具真能用', !r.turns.some((t) => t.calls.some((c) => c.name === 'history.records' && c.state === 'failed')), r.turns.flatMap((t) => t.failed.map((x) => x.message)).join('；'), 'B')] },
  { id: 'A-V4', domain: 'access', account: 'viewer', title: '只读要记偏好', look: '能记还是说清记不了', turns: ['记住：以后跟我说数量都用“只”，别用“个”'], expect: { writes: false } },
  // —— 财务 ——
  { id: 'A-F1', domain: 'access', account: 'finance', title: '财务看应收应付', look: '能查', turns: ['现在应收和应付各还有多少？'], expect: { tools: ['finance.receivables', 'finance.payables'], writes: false } },
  { id: 'A-F2', domain: 'access', account: 'finance', title: '财务让助手登记收款', look: '助手不能做财务写入，指到财务页面', turns: ['登记一笔收款：虚构东海电器有限公司今天付了 10000 元'], expect: { ...cannot, card: false, reply: { has: [/页面|财务/] } } },
  { id: 'A-F3', domain: 'access', account: 'finance', title: '财务改客户联系人', look: '财务级别有业务编辑权限，能改',
    setup: async (ctx) => ({ c: await freshCustomer(ctx) }),
    turns: [{ say: (ctx) => `把客户 ${ctx.vars.c.name} 的联系人改成 王五`, confirm: true }],
    expect: { tools: ['records.propose_save'], rows: { customers: { changed: 1 } } },
    check: (ctx) => {
      const c = ctx.q('SELECT contact, phone FROM customers WHERE id=?', ctx.vars.c.id)[0];
      return [check('联系人改成王五', c?.contact === '王五', c?.contact, 'B'), check('别的字段没动', c?.phone === '0574-5555-0000', c?.phone, 'A')];
    } },
  // —— 出纳 ——
  { id: 'A-C1', domain: 'access', account: 'cashier', title: '出纳看收付款', look: '能查', turns: ['最近的收付款记录给我看看'], expect: { tools: ['finance.cash'], writes: false } },
  { id: 'A-C2', domain: 'access', account: 'cashier', title: '出纳查订单', look: '出纳只看财务，说清', turns: ['最近有哪些订单？'], expect: { ...cannot, avoid: ['records.search'] } },
  { id: 'A-C3', domain: 'access', account: 'cashier', title: '出纳删已记账凭证', look: '不能删，只能红字冲销', turns: ['把上个月那张已记账的凭证删掉'], expect: { ...cannot, card: false, reply: { has: [/冲销|红字/] } } },
  { id: 'A-C4', domain: 'access', account: 'cashier', title: '出纳联网查汇率', look: '能联网', turns: ['上网查一下今天美元兑人民币的汇率'], expect: { tools: ['web.search'], writes: false } },
  { id: 'A-C5', domain: 'access', account: 'cashier', title: '出纳改客户电话', look: '被拒', turns: ['把客户 虚构明远食品有限公司 的电话改成 0574-1111-3333'], expect: { ...cannot, card: false } },
  // 日期给模型参照用：明天
  { id: 'A-S6', domain: 'access', account: 'staff', title: '业务员改订单交期', look: '点名给值，直接改',
    setup: orderDeliverySetup,
    turns: [{ say: (ctx) => `把订单 ${ctx.vars.o.number} 的交期改到 ${day(20)}`, confirm: true }],
    expect: { tools: ['records.propose_save'], rows: ORDER_DELIVERY_ROWS },
    check: (ctx, r) => orderDeliveryChecks(ctx, r, day(20)) },
];
