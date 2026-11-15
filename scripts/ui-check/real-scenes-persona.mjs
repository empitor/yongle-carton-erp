// 两个助手的人设：同一个问题分别点名小甬、小勒各问一次（各开一个会话），看两人答得是不是真的不一样、接力有没有实质内容。
// 判定只看点到的那位是不是开口的人；答得像不像本人、接力有没有用，在报告里把两人的回答并排贴出来人看。
import { check, order } from './real-scenes-kit.mjs';

const ASK = [
  ['P1', '跨两边：能不能发货', (ctx) => `订单 ${ctx.vars.o.number} 这周能发货吗？`],
  ['P2', '纯查询：库存', () => 'BC五层纸板 1250×1000 现在还有多少张？'],
  ['P3', '纯查询：客户', () => '虚构东海电器有限公司最近怎么样？'],
  ['P4', '要办事：改交期', (ctx) => `把订单 ${ctx.vars.o.number} 的交期往后推三天`],
  ['P5', '跨两边：这个月生意', () => '这个月生意怎么样？'],
  ['P6', '要办事：安排生产', (ctx) => `订单 ${ctx.vars.o.number} 还没排生产的话安排一下`],
];
const who = (t) => (t.speakers ?? []).join('、') || '没有标人';
const NAME = { yong: '小甬', le: '小勒' };
/** 接力：同一轮里第二位开口的那段 */
const SELF_CONTACT = /我(会|去|先|来|现在|马上|这就)[^，。；]{0,6}(联系|问|找|催|确认|打招呼|说)|回话了|再报给你|拿到答复|回头告诉你/;
const relayOf = (t) => (t.parts ?? []).find((p, i) => i > 0 && p.speaker && p.speaker !== t.parts[0].speaker);
// 会触发接力的问题：first 是该先答的人；by 是该接的人，has 是接的那句该有的实质（小勒补数字，小甬补找客户、供应商的下一步）
const RELAY = [
  ['P7', '小甬答应送货而库存有缺口', (ctx) => `小甬，订单 ${ctx.vars.o.number} 客户催了，帮我安排明天全部送过去`, 'yong', 'le', /\d/],
  ['P8', '小甬答应交期而库存有缺口', (ctx) => `小甬，订单 ${ctx.vars.o.number} 的客户问下周一能不能全部送到，我打算答应他，你帮我排上`, 'yong', 'le', /\d/],
  ['P9', '小勒报缺口，下一步该找客户', (ctx) => `小勒，订单 ${ctx.vars.o.number} 现在还差多少货？`, 'le', 'yong', /客户|东海|北仑|余姚|慈溪|明远|海曙/],
  ['P10', '小勒报逾期，下一步该找客户', () => '小勒，现在有哪些订单过了交期还没发完？', 'le', 'yong', /客户|东海|北仑|余姚|慈溪|明远|海曙/],
  ['P11', '小勒报到货逾期，下一步该找供应商', () => '小勒，有没有过了约定到货日期还没到齐的采购单？', 'le', 'yong', /供应商|鼎盛|华美|宏泰|催|打电话/],
];
const relayScenes = RELAY.map(([id, title, say, first, by, has]) => ({
  id,
  domain: 'persona',
  account: 'local',
  title: '接力：' + title,
  look: `点名的${NAME[first]}先答；${NAME[by]}另起一段补一句有实质的，不重复、不说“没有要补充的”`,
  setup: async (ctx) => ({ o: await order(ctx, (o) => o.status === '已确认' && o.shippingProgress === '未发货') }),
  turns: [say],
  expect: { writes: false },
  check: (ctx, r) => {
    const t = r.turns[0] ?? {};
    const relay = relayOf(t);
    return [
      check(`点名${NAME[first]}是${NAME[first]}答`, t.speakers?.[0] === first, who(t), 'D'),
      check(`${NAME[by]}接了一句`, relay?.speaker === by, who(t), 'D'),
      check('接的那句有实质', !relay || (has.test(relay.text) && !/没有要补充|没什么要补充|无需补充/.test(relay.text)), (relay?.text ?? '').slice(0, 100), 'D'),
      // 助手发不了消息：接的那句该提醒用户去联系谁、问什么，不说成自己去联系、回头再报
      check('接的那句不说助手自己去联系', !relay || !SELF_CONTACT.test(relay.text), (relay?.text ?? '').slice(0, 100), 'C'),
    ];
  },
}));
export const scenes = [...ASK.map(([id, title, say]) => ({
  id,
  domain: 'persona',
  account: 'local',
  title: '人设：' + title,
  look: '点名谁就是谁答；两人的说法、侧重真的不一样，接力有实质内容',
  setup: async (ctx) => ({ o: await order(ctx, (o) => o.status === '已确认' && o.shippingProgress === '未发货') }),
  turns: [{ say: (ctx) => '小甬，' + say(ctx) }, { newThread: true, say: (ctx) => '小勒，' + say(ctx) }],
  expect: { writes: false },
  check: (ctx, r) => [
    check('点名小甬是小甬答', r.turns[0]?.speakers?.[0] === 'yong', who(r.turns[0] ?? {}), 'D'),
    check('点名小勒是小勒答', r.turns[1]?.speakers?.[0] === 'le', who(r.turns[1] ?? {}), 'D'),
  ],
})), ...relayScenes];
