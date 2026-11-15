// 第 5 类：会话上下文。隔几轮说“刚才那张”“第二个”“改回去”；二十轮以上不丢前面的；思考四个档位；点停止；压缩真的跑一次。
import { check, freshCustomer, list, order } from './real-scenes-kit.mjs';

const S = (scene) => ({ domain: 'context', account: 'local', ...scene });
const phoneOf = (ctx, id) => ctx.q('SELECT phone FROM customers WHERE id=?', id)[0]?.phone;
const last = (r) => r.turns.at(-1)?.reply ?? '';
/** 回答里提到了这一天（2026-12-09、12-09、12 月 9 日都算） */
const sameDay = (text, date) => text.includes(date) || text.includes(date.slice(5)) || new RegExp(Number(date.slice(5, 7)) + '\\s*月\\s*' + Number(date.slice(8)) + '\\s*日').test(text);
const LEVELS = ['off', 'low', 'high', 'max'];
// 撑大历史用的查询：每句都会带回一长串记录
const FILLERS = ['把所有订单按客户列出来，单号、交期、状态都要', '所有采购单列一下，单号、供应商、状态、到货进度', '库存里所有库存品和数量列出来', '最近一个月所有送货单和到货单都列出来', '所有客户的联系人和电话列一下', '所有产品的规格、材质、楞型列一下'];

export const scenes = [
  S({ id: 'C1', title: '隔几轮说“刚才那张”', look: '第五句的交期是第一句那张订单的',
    turns: [(ctx) => `查一下订单 ${ctx.vars.o.number}`, '今天几号？', '这个月有几个新客户？', '最近有哪些到货？', '刚才那张订单的交期是哪天？'],
    expect: { writes: false }, setup: async (ctx) => ({ o: await order(ctx) }), check: (ctx, r) => [check('答的是第一张的交期', sameDay(last(r), ctx.vars.o.deliveryDate), last(r).slice(0, 80))] }),
  S({ id: 'C2', title: '“第二个”', look: '第二句说的是上一句列表里的第二张，不反问', turns: ['最近两周哪些订单还没发货？按交期从早到晚列出来', '第二个是哪家客户的？交期哪天？'], expect: { writes: false },
    check: (ctx, r) => [check('没反问“哪个”', !/哪一个|哪个订单|哪张/.test(last(r)), last(r).slice(0, 80))] }),
  S({ id: 'C3', title: '“改回去”', look: '改电话、隔一句、改回原来的',
    turns: [{ say: (ctx) => `把客户 ${ctx.vars.c.name} 的电话改成 0574-1000-0001`, confirm: true, after: (ctx) => (ctx.vars.mid = phoneOf(ctx, ctx.vars.c.id)) }, '它的地址是什么？', { say: '电话改回去', confirm: true }],
    // 改了又改回去：最后那一行和原来一样（版本号、修改时间不算），所以 rows 是空的，靠中间那次核对看真改过
    expect: { rows: {} }, setup: async (ctx) => ({ c: await freshCustomer(ctx) }), check: (ctx) => [check('第一句改成了 0574-1000-0001', ctx.vars.mid === '0574-1000-0001', ctx.vars.mid, 'B'), check('电话回到原来的 0574-5555-0000', phoneOf(ctx, ctx.vars.c.id) === '0574-5555-0000', phoneOf(ctx, ctx.vars.c.id), 'B')] }),
  S({ id: 'C4', title: '二十二轮不丢前面的', look: '第 22 句问第 1 句的暗号和第 2 句的订单交期，都答对',
    turns: [
      '这次对话里先约定个暗号：蓝鲸 37。只在这次对话用，不用长期记。',
      (ctx) => `查一下订单 ${ctx.vars.o.number}`,
      '今天几号？', '虚构东海电器有限公司的电话是多少？', '最近有哪些到货？', 'BC五层纸板 1250×1000 现在库存多少张？', '有几家供应商？', '吹风机彩箱的规格是多少？',
      '这个月接了几张订单？', '收件箱有几条待处理？', '有没有还没开工的生产任务？', '水壶外箱有库存吗？', '最近一张送货单是哪天的？', '虚构华美瓦楞的联系人是谁？',
      '有没有逾期没到的订货单？', '食品礼盒外箱是什么楞型？', '有几个客户？', '五金配件箱 大 的尺寸是多少？', 'E三层纸板现在多少张？', '最近一张采购单是哪家的？', '今天有送货安排吗？',
      '最开始我说的暗号是什么？我第二句查的那张订单交期是哪天？',
    ],
    expect: { writes: false }, setup: async (ctx) => ({ o: await order(ctx) }), check: (ctx, r) => [check('暗号答对', /蓝鲸\s*37/.test(last(r)), last(r).slice(0, 80)), check('那张订单的交期答对', sameDay(last(r), ctx.vars.o.deliveryDate), ctx.vars.o.deliveryDate)] }),
  S({ id: 'C5', title: '思考档位：多步排查', look: '四个档位都答清部分发货（送了多少、还差多少）；看耗时和费用',
    turns: [(ctx) => `订单 ${ctx.vars.o.number} 为什么显示部分发货？送了多少、还差多少？`], expect: { writes: false },
    approaches: LEVELS, setup: async (ctx) => ({ o: (await list(ctx, '/api/orders')).find((o) => o.shippingProgress === '部分发货') ?? (await order(ctx)) }) }),
  S({ id: 'C6', title: '思考档位：简单查询', look: '四个档位都列对未发货订单；看耗时和费用', turns: ['最近两周哪些订单还没发货？'], expect: { writes: false }, approaches: LEVELS }),
  S({ id: 'C7', title: '联网时点停止', look: '停下来、说已停止；下一句照常', turns: [{ say: '上网搜一下 2026 年瓦楞纸价格走势，多找几个来源仔细对比', cancel: { afterMs: 6000 } }, '今天几号？'],
    expect: { writes: false, allowError: true }, check: (ctx, r) => [check('第一句停下了', r.turns[0]?.cancelled, '', 'B'), check('停止后下一句正常', !r.turns[1]?.error && !r.turns[1]?.turnError && (r.turns[1]?.reply ?? '').length > 0, r.turns[1]?.error ?? '', 'B')] }),
  S({ id: 'C8', title: '多步中点停止', look: '停在半路不留半截写入；下一句正常', turns: [{ say: '把最近两周所有没发货的订单逐张查一遍生产和送货进度，列成表', cancel: { afterMs: 8000 } }, '刚才查到哪了？接着把剩下的说完'],
    expect: { writes: false, allowError: true }, check: (ctx, r) => [check('第一句停下了', r.turns[0]?.cancelled, '', 'B'), check('停止后下一句正常', !r.turns[1]?.error && !r.turns[1]?.turnError, r.turns[1]?.error ?? '', 'B')] }),
  // 压缩真的跑一次：触发线临时调到 3 万 token、原样留 8000 token（测试入口 /__real-smoke/session），十几轮后问最早的事
  S({ id: 'C9', title: '压缩真的跑一次', look: '压缩后还记得最早查的单号和交期、改过的电话、约定；压缩那轮和之后不报错；之后还命中缓存',
    turns: [
      (ctx) => `查一下订单 ${ctx.vars.o.number}，交期是哪天？`,
      { say: (ctx) => `把客户 ${ctx.vars.c.name} 的电话改成 0574-3333-0001`, confirm: true },
      '这次对话约定：报数量都带“只”或“张”，金额保留两位小数。只在这次对话用，不用长期记。',
      ...FILLERS,
      ...FILLERS.slice(0, 4),
      '最早我查的那张订单是哪张？交期哪天？',
      '我前面改过哪个客户的电话、改成了多少？',
      '我们这次对话约定的数量和金额写法是什么？',
    ],
    expect: { rows: { customers: { changed: 1 } } },
    session: { compactAboveTokens: 30000, retainTokens: 8000 },
      setup: async (ctx) => ({ o: await order(ctx), c: await freshCustomer(ctx) }),
      check: (ctx, r) => {
        const n = r.turns.length;
        const summaries = r.turns.reduce((n, t) => n + (t.compacted ?? 0), 0);
        const at = (i) => r.turns[n - 3 + i]?.reply ?? '';
        const after = r.turns.slice(-4);
        const hit = after.reduce((a, t) => a + (t.usage?.cached ?? 0), 0) / Math.max(1, after.reduce((a, t) => a + (t.usage?.input ?? 0), 0));
        // 哪一轮第一次压缩：事件流里报了“压缩”那一步的那轮（不看压缩怎么实现）
        const from = r.turns.findIndex((t) => t.compacted > 0);
        return [
          check('电话真的改成了 0574-3333-0001', phoneOf(ctx, ctx.vars.c.id) === '0574-3333-0001', phoneOf(ctx, ctx.vars.c.id), 'B'),
          check('真的压缩了', summaries > 0, '压了 ' + summaries + ' 次；第 ' + (from + 1) + ' 轮第一次压缩', 'B'),
          check('三个问题都在压缩之后问', from >= 0 && from <= n - 3, '压缩在第 ' + (from + 1) + ' 轮', 'B'),
          check('记得最早那张订单和交期', at(0).includes(ctx.vars.o.number) && sameDay(at(0), ctx.vars.o.deliveryDate), at(0).slice(0, 100)),
          check('记得改过的客户和电话', at(1).includes(ctx.vars.c.name) && at(1).includes('0574-3333-0001'), at(1).slice(0, 100)),
          check('记得约定', /两位/.test(at(2)) && /只|张/.test(at(2)), at(2).slice(0, 100)),
          check('压缩后各轮不报错', r.turns.every((t) => !t.error && !t.turnError), '', 'B'),
          check('压缩后最后几轮还命中缓存（命中率过半）', hit > 0.5, '命中率 ' + (hit * 100).toFixed(0) + '%', 'D'),
        ];
      } }),
  // 发话中途断网：测试入口 /__real-smoke/cut 让接下来两次流式请求收到 600 字节后掐断，程序应自动重发接上，回答完整、不留半截
  S({ id: 'C10', title: '中途断网自动接上', look: '断两次后自动重发接上；回答完整，没有“没收全”“中途断开”',
    turns: ['虚构东海电器有限公司现在有几张没发完的订单？各差多少只？'], expect: { writes: false },
    setup: async (ctx) => {
        await ctx.admin.smoke('traffic', {});
        return { cut: (await ctx.admin.smoke('cut', { times: 2, afterBytes: 600 })).result };
      },
      check: async (ctx, r) => {
        const t = r.turns[0] ?? {};
        const left = (await ctx.admin.smoke('cut', { times: 0 })).result?.left;
        const traffic = (await ctx.admin.smoke('traffic', {})).result ?? [];
        const cut = traffic.filter((x) => x.cut).length;
        return [
          check('真的掐断了两次', cut === 2 && left === 0, '掐断 ' + cut + ' 次；这一轮请求 ' + traffic.length + ' 次', 'B'),
          check('程序报了重发', (t.retries ?? 0) >= 2, '重发事件 ' + (t.retries ?? 0) + ' 次', 'D'),
          check('回答完整、不报错', !t.error && !t.turnError && (t.reply ?? '').length > 0, (t.error ?? '') + (t.reply ?? '').slice(0, 80), 'B'),
          check('没有半截字和断线提示', !/没收全|未完整|中途断开|连接中断/.test(t.reply ?? ''), (t.reply ?? '').slice(0, 80), 'C'),
        ];
      } }),
];
