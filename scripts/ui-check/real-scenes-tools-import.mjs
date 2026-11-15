// 第 1 类（三）：识别导入、收件箱转导入、识别工作区、到货识别、附件、唛头。文件都是 real-suite-files.mjs 现造的虚构文件。
// 识别导入一条龙（识别 → 看 → 改 → 撤销 → 匹配 → 预览 → 导入）在 real-scenes-flows.mjs 的 F1，这里是单个工具和“没说清”的那几条。
import { check } from './real-scenes-kit.mjs';

const S = (scene) => ({ domain: 'tools', account: 'local', ...scene });
const ask = { writes: false, asks: true };
const orderCount = (ctx, customer = '') => ctx.q('SELECT COUNT(*) n FROM orders WHERE customer_name LIKE ?', '%' + customer + '%')[0].n;
const m2Workspace = async (ctx) => {
  const item = ctx.q("SELECT status, converted_ref id FROM inbox_items WHERE file_name='11月采购单.xlsx'")[0] ?? {};
  const w = item.id ? await ctx.admin.api('/api/ai/imports/' + item.id) : {};
  return { item, lines: w.draft?.lines ?? [], startedAt: w.task?.startedAt ?? '' };
};
export const scenes = [
  S({ id: 'M1', title: '识别过的订单文件', look: '列出识别工作区里的文件', turns: ['我在订单导入里识别过哪些文件？'], expect: { tools: ['order_import.list'], writes: false } }),
  S({ id: 'M2', title: '收件箱文件转导入再识别、重试', look: '转入导入（不收费）；识别成功；没失败时不重复识别收费',
    turns: [
      { say: '把收件箱里王经理发的那个 11月采购单.xlsx 转到订单导入', confirm: true },
      { say: '识别一下', after: async (ctx) => (ctx.vars.afterStart = await m2Workspace(ctx)) },
      '重新识别一次',
    ],
    covers: ['order_import.retry'],
    expect: { tools: ['order_import.from_inbox', 'order_import.start'], rows: { inbox_items: { changed: 1 } } },
    check: async (ctx, r) => {
      const { item, lines, startedAt } = await m2Workspace(ctx);
      const prev = ctx.vars.afterStart ?? { lines: [], startedAt: '' };
      const last = r.turns.at(-1) ?? { executed: [], reply: '' };
      return [
        check('收件箱条目已转进订单导入', item.status === 'converted' && Boolean(item.id), item.status, 'B'),
        check('工作区有了识别结果', lines.length > 0, lines.length + ' 行', 'B'),
        check('第3句没有再次识别', prev.lines.length > 0 && startedAt === prev.startedAt && !last.executed.some((e) => e === '识别订单文件' || e === '重新识别订单文件'), startedAt, 'A'),
        check(
          '第3句说明没失败或已识别不重来',
          /不重复|没有重新|未重新|不用重|不需要重|无需重|复用|已(经)?识别过|没(有)?失败/.test(last.reply) &&
            !/重新识别(完成|成功|好了)/.test(last.reply),
          last.reply.slice(0, 80),
          'C',
        ),
      ];
    } }),
  S({ id: 'M3', title: '接着处理以前识别的那份', look: '新会话里把以前的工作区接上，不重新识别、不收费',
    turns: [{ say: '识别这份订单', attach: ['orderXlsx'] }, { newThread: true, say: '接着处理上次识别的那份 虚构订单.xlsx，识别结果给我看看' }],
    covers: ['order_import.get'], expect: { tools: ['order_import.attach'], writes: false } }),
  S({ id: 'M4', title: '两份订单：先看第二份、再一起导入', look: '选中第二份；两份都导入成订单',
    turns: [{ say: '识别这两份订单', attach: ['orderXlsx', async (ctx) => ({ ...(await ctx.files.orderXlsx({ customer: '虚构慈溪小家电有限公司' })), name: '虚构订单-慈溪.xlsx' })] }, '先看第二份', { say: '两份都导入', confirm: true }],
    // 两张订单连明细；匹配、关联档案时客户、产品、成品库存品可能跟着建或补
    covers: ['order_import.select'], expect: { tools: ['order_import.execute'], rows: { orders: { added: 2 }, order_lines: { added: 'any' }, customers: 'any', products: 'any', stock_items: 'any' } },
    setup: async (ctx) => ({ before: orderCount(ctx), cixi: orderCount(ctx, '慈溪小家电') }),
      check: (ctx) => [check('一共多了两张订单', orderCount(ctx) - ctx.vars.before === 2, '多了 ' + (orderCount(ctx) - ctx.vars.before) + ' 张', 'A'), check('慈溪那份导入了一张', orderCount(ctx, '慈溪小家电') - ctx.vars.cixi === 1, '', 'B')] }),
  S({ id: 'M5', title: '缺必填项时停下来问', look: '订单日期没有：停下来问，不编、不导入', turns: [{ say: '识别并导入这份订单', attach: [async (ctx) => ctx.files.orderXlsx({ noDate: true })] }], expect: { ...ask, tools: ['order_import.start'] } }),
  S({ id: 'M6', title: '识别工作区列表', look: '列出工作区', turns: ['AI 识别的原件和工作区都有哪些？'], expect: { tools: ['management.workspaces'], writes: false } }),
  S({ id: 'M7', title: '识别供应商送货单', look: '读出供应商、送货单号、纸板、600 张', turns: [{ say: '识别这张供应商送货单', attach: [async (ctx) => ctx.files.deliveryNotePng()] }],
    expect: { tools: ['arrival.recognize'], reply: { has: ['600', /鼎盛/] } } }), // 识别会记一条识别来源（flow_sources），不算业务改动
  // 以前的附件留在会话里（有效期内不用重传，也没有单独的“读附件”工具了），隔一句再问还答得出
  S({ id: 'M8', title: '回头再看以前的附件', look: '第一句读图；隔一句再问图上的单价，不用重传也答得出',
    turns: [{ say: '这张图上是哪家的订单？', attach: ['orderPng'] }, '今天几号？', '再看一下刚才那张图片，单价是多少？'],
    expect: { writes: false, reply: { has: ['0.95'] } } }),
  S({ id: 'M9a', title: '挂唛头、查唛头、去掉唛头', look: '挂到电饭煲外箱 3L；能查到；去掉',
    turns: [{ say: '把这个唛头挂到产品 电饭煲外箱 3L 下面', attach: ['markPng'], confirm: true }, '电饭煲外箱 3L 现在有哪些唛头？', { say: '把刚才挂的那个唛头去掉', confirm: true }],
    expect: { tools: ['marks.add', 'marks.list', 'marks.remove'] }, // 挂上又去掉，前后指纹一样，靠下面的核对
    check: (ctx) => [check('最后唛头去掉了', !ctx.q("SELECT 1 FROM product_marks m JOIN products p ON p.id=m.product_id WHERE p.name='电饭煲外箱 3L'").length, '', 'B')] }),
  S({ id: 'M9b', title: '挂唛头（没说清挂哪）', look: '先问挂到哪个产品', turns: [{ say: '这个唛头挂上去', attach: ['markPng'] }], expect: ask }),
  S({ id: 'M10', title: '识别工作区归档', look: '按文件名归档那份工作区',
    turns: [{ say: '识别这份订单', attach: ['orderXlsx'] }, { say: '把 虚构订单.xlsx 那个识别工作区归档', confirm: true }],
    expect: { tools: ['management.workspaces'] } }),
];
