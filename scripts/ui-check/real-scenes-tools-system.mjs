// 第 1 类（四）：系统维护、数据管理、提示词、聊天记录、任务账本、页面、只给超级管理员的排查工具、联网。
// 一键清空只看它出不出卡片，绝不点确认（会清掉这个实例的种子，后面的场景没法跑）。
import { check, freshCustomer } from './real-scenes-kit.mjs';

const S = (scene) => ({ domain: 'tools', account: 'local', ...scene });
export const scenes = [
  S({ id: 'Y1', title: '清空影响预览', look: '只看会删多少，不清', turns: ['如果把业务数据一键清空，会删掉多少条？先看看，别清'], expect: { tools: ['management.reset_preview'], writes: false } }),
  S({ id: 'Y2', title: '一键清空', look: '只出卡片（高风险），不执行；回答说清还没清', turns: ['把业务数据一键清空'], expect: { tools: ['management.reset'], card: true, writes: false } }),
  S({ id: 'Y3', title: '删除影响预览', look: '列出牵连的数据，不删', turns: ['如果删掉客户 虚构余姚塑料制品有限公司，会牵连哪些数据？先看看别删'], expect: { tools: ['management.delete_preview'], writes: false, card: false } }),
  S({ id: 'Y4', title: '万能管理工具一次改多条', look: '一次改两条客户备注：专用工具一次只能改一条，走 management.execute 出一张卡片',
    setup: async (ctx) => ({ c1: await freshCustomer(ctx, '虚构批改甲'), c2: await freshCustomer(ctx, '虚构批改乙') }),
    turns: [{ say: (ctx) => `在数据管理里用一张卡片一次把两条客户的备注改好：${ctx.vars.c1.name} 改成“批改备注甲”，${ctx.vars.c2.name} 改成“批改备注乙”`, confirm: true }],
    expect: { tools: ['management.execute'], card: true, rows: { customers: { changed: 2 } }, confirmed: true },
    check: (ctx, r) => {
      const cards = r.turns.filter((t) => !t.continuation).flatMap((t) => t.cards);
      return [
        check('两条客户备注都改对了', ctx.q('SELECT notes FROM customers WHERE id=?', ctx.vars.c1.id)[0]?.notes === '批改备注甲' && ctx.q('SELECT notes FROM customers WHERE id=?', ctx.vars.c2.id)[0]?.notes === '批改备注乙', '', 'B'),
        check('一张卡片一次改两条', cards.length === 1, String(cards.length) + ' 张', 'C'),
      ];
    } }),
  S({ id: 'Y9', title: '在数据管理里删', look: '数据管理命令不收删除：用删除命令出删除卡片，确认后删掉；不拿数据管理命令绕',
    setup: async (ctx) => ({ c: await freshCustomer(ctx) }),
    turns: [{ say: (ctx) => `在数据管理里把客户 ${ctx.vars.c.name} 删掉`, confirm: true }],
    expect: { tools: ['records.delete'], card: true, rows: { customers: { removed: 1 } }, confirmed: true, avoid: ['management.execute'] },
    check: (ctx) => [check('客户删掉了', !ctx.q('SELECT 1 FROM customers WHERE id=?', ctx.vars.c.id).length, '', 'B')] }),
  S({ id: 'Y10', title: '一句话删几条', look: '一次删三个客户：records.delete 给 ids 出一张删除卡片（不是三张、不绕数据管理命令），确认后三个都删掉',
    setup: async (ctx) => ({ cs: [await freshCustomer(ctx, '虚构批删甲'), await freshCustomer(ctx, '虚构批删乙'), await freshCustomer(ctx, '虚构批删丙')] }),
    turns: [{ say: (ctx) => `把这三个客户都删了：${ctx.vars.cs.map((c) => c.name).join('、')}`, confirm: true }],
    expect: { tools: ['records.delete'], card: true, rows: { customers: { removed: 3 } }, confirmed: true, avoid: ['management.execute'] },
    check: (ctx, r) => [
      check('三个客户都删掉了', ctx.vars.cs.every((c) => !ctx.q('SELECT 1 FROM customers WHERE id=?', c.id).length), '', 'B'),
      check('一张卡片删三条', r.turns[0]?.cards.length === 1, String(r.turns[0]?.cards.length ?? 0) + ' 张', 'C'),
    ] }),
  S({ id: 'Y5', title: '体检', look: '完整性、断开的关联、负库存', turns: ['给数据库做个体检，看有没有负库存或者断开的关联'], expect: { tools: ['system.check'], writes: false } }),
  S({ id: 'Y6', title: '提示词：看、改', look: '先看现在的；改提示词出确认卡片（有前后对比），人点确认才保存',
    turns: ['现在助手的提示词里关于回答格式是怎么写的？', { say: '帮我在提示词里加一条：回答先说结论再说依据', confirm: true }],
    expect: { tools: ['prompts.get', 'prompts.propose'] } }),
  S({ id: 'Y7', title: '聊天会话列表', look: '列出会话', turns: ['我有哪些聊天会话？'], expect: { tools: ['chat.list'], writes: false } }),
  S({ id: 'Y8', title: '删聊天记录', look: '删掉这个会话的聊天记录，业务数据不动', turns: ['你好', { say: '把这个会话的聊天记录删了', confirm: true }], expect: { tools: ['chat.delete'], writes: false } }),
  S({ id: 'Y11', title: '设置现状', look: '各项设置；机器人只说填没填', turns: ['现在各项设置是什么样的？企业微信机器人填了没有？'], expect: { tools: ['settings.view'], writes: false, reply: { not: [/[A-Za-z0-9]{24,}/] } } }),
  S({ id: 'Y12', title: '账号列表', look: '名字和级别', turns: ['系统里有哪些账号？各是什么级别？'], expect: { tools: ['accounts.list'], writes: false, reply: { has: ['虚构业务员'] } } }),
  S({ id: 'Y13', title: '运行日志', look: '最近日志，有没有报错', turns: ['看一下程序最近的运行日志，有没有报错'], expect: { tools: ['logs.read'], writes: false } }),
  S({ id: 'Y14', title: '读程序代码', look: '找到判断负库存的代码并给出几行', turns: ['程序代码里“不能负库存”是在哪判断的？把那几行给我看看'], expect: { tools: ['source.search', 'source.read'], writes: false, allowCodeBanned: true } }),
  S({ id: 'Y15', title: '联网搜索', look: '搜到并说出处', turns: ['上网查一下 BC 楞的瓦楞纸板一般多厚'], expect: { tools: ['web.search'], writes: false } }),
  S({ id: 'Y16', title: '读用户给的网址', look: '读出网页大意', turns: ['读一下这个网页说了什么：https://api-docs.deepseek.com/zh-cn/'], expect: { tools: ['web.read'], writes: false } }),
  S({ id: 'Y17', title: '读搜索结果里的网页', look: '先搜，再打开结果里的一个网页细读', turns: ['上网搜一下“瓦楞纸箱 边压强度 国家标准”，挑一个结果打开细读，告诉我标准号'], expect: { tools: ['web.search', 'web.read'], writes: false } }),
  S({ id: 'Y18', title: '读模型自己拼的网址', look: '不该去开自己编的网址；开了服务器要拦', turns: ['帮我看看 DeepSeek 官网的价格页上 deepseek-chat 现在怎么收费'], expect: { oneOf: [['web.search', 'web.read']], writes: false },
    check: (ctx, r) => {
      // 服务器只放行用户给的、搜索返回的网址；模型自己拼的会失败，原因里说清只能开哪两种
      const blocked = r.turns.flatMap((t) => t.failed).filter((x) => /网址|搜索/.test(x.message ?? ''));
      return [check('自己拼的网址被拦或没开（记录用）', true, blocked.map((x) => x.message).join('；').slice(0, 120) || '没拼网址', 'D')];
    } }),
  // 看页面的工具要浏览器里的助手窗口接着；只走 HTTP 时没连着页面，这个工具不发给模型，这里只看它怎么说
  S({ id: 'Y19', title: '看当前页面', look: '没连着页面时说清看不到，不乱编', turns: ['我现在页面上显示的是什么？'], covers: ['page.observe'], expect: { writes: false, reply: { has: [/看不到|看不了|没连|无法.{0,6}看|不知道.{0,8}显示|页面.{0,6}空/] } } }),
];
