// 第 1 类（二）：单据流转、采购到货、库存类工具。写入的两条：说清了直接办成（或出卡片 → 确认后办成），没说清先问。
// 数据都从虚构种子现查（种子见 server.mts）：已订货没到的采购单、送货中的送货单、待送货的送货单、已核对的到货单、还没开工的生产任务等。
import { check, day, flowRow, list, order, purchase, reversedDelivery, stockSum, UNITS } from './real-scenes-kit.mjs';

const ask = { writes: false, asks: true };
const docs = async (ctx, kind, test) => (await list(ctx, '/api/flow?kind=' + kind)).filter(test);
const openPurchase = (p) => p.baseStatus === '已订货' && p.lines.every((l) => l.receivedQuantity === '0');
const shipping = (d) => d.status === 'confirmed' && !d.deliveredAt && !d.archived;
const finishedWithStock = async (ctx) => (await list(ctx, '/api/warehouse/items')).find((i) => i.kind === 'finished' && Number(i.quantity) > 0);
const S = (scene) => ({ domain: 'tools', account: 'local', ...scene });
/** 单据取消了、原因是用户说的 */
const cancelled = (ctx, id, reason) => {
  const r = flowRow(ctx, id);
  return [check('取消了', r?.status === 'cancelled', r?.status, 'B'), check('原因照用户说的', (r?.doc.cancellation?.reason ?? '').includes(reason), r?.doc.cancellation?.reason, 'C')];
};

export const scenes = [
  S({ id: 'W1', title: '订货单预览', look: '订货单内容（供应商、纸板、数量）', turns: [(ctx) => `看一下采购单 ${ctx.vars.p.number} 的订货单内容`], expect: { tools: ['documents.preview'], writes: false }, setup: async (ctx) => ({ p: await purchase(ctx, openPurchase) }) }),
  S({ id: 'W2', title: '导出订货单再问交付', look: '生成 Excel 文件；第二句查交付状态', turns: [(ctx) => `把采购单 ${ctx.vars.p.number} 的订货单导出成 Excel 给我，先不要标成已订货`, '刚才那个文件交付完了吗？'],
    covers: ['documents.status'], expect: { tools: ['documents.export'], oneOf: [['documents.status', 'exports.list', 'jobs.status']] }, setup: async (ctx) => ({ p: await purchase(ctx, openPurchase) }) }),
  S({ id: 'W3a', title: '导出并正式订货（说清了）', look: '导出 Word 订货单、采购单变已订货、进待到货', turns: [{ say: (ctx) => `采购单 ${ctx.vars.p.number} 导出 Word 订货单发给供应商，标成已订货`, confirm: true }],
    expect: { tools: ['documents.export'], rows: { purchases: { changed: 1 }, order_batches: { added: 'any' }, order_batch_purchases: { added: 'any' } } },
    setup: async (ctx) => ({ p: await purchase(ctx, (p) => p.baseStatus === '待订货') }),
      check: (ctx, r) => [
        check('采购单变成已订货', ctx.q('SELECT status FROM purchases WHERE id=?', ctx.vars.p.id)[0]?.status === '已订货', ctx.q('SELECT status FROM purchases WHERE id=?', ctx.vars.p.id)[0]?.status, 'B'),
        check('订货单交付成功', (r.downloads ?? []).some((d) => d.ok), (r.downloads ?? []).map((d) => d.message).join('；') || '没下载', 'B'),
      ] }),
  S({ id: 'W3b', title: '导出订货单（没说清）', look: '先问是哪张、要不要标已订货', turns: ['把订货单导出来'], expect: ask }),
  S({ id: 'W4', title: '安排送货先算方案', look: '按交期分给在等的订单，只算不建单', turns: ['成品 吹风机彩箱 现在的库存按交期分给在等的订单，先算算怎么送，别建单'], expect: { tools: ['delivery.plan'], writes: false } }),
  S({ id: 'W5', title: '安排生产先算方案', look: '算出每张订单还要排多少，只算不建', turns: [(ctx) => `订单 ${ctx.vars.a.number} 和 ${ctx.vars.b.number} 还要排多少生产？先算一下，别建任务`], expect: { tools: ['production.plan'], writes: false },
    setup: async (ctx) => { const os = (await list(ctx, '/api/orders')).filter((o) => o.status === '已确认' && o.shippingProgress === '未发货'); return { a: os[0], b: os[1] }; } }),
  S({ id: 'W6', title: '合并订货单先看样子', look: '合并后的行、到货安排', turns: [(ctx) => `采购单 ${ctx.vars.p.number} 要发给供应商，先看看订货单合并后是什么样子`], expect: { tools: ['order_batch.draft'], writes: false },
    setup: async (ctx) => ({ p: await purchase(ctx, (p) => p.baseStatus === '待订货') }) }),
  S({ id: 'W7', title: '没到齐的订货单', look: '列出待到货、逾期的', turns: ['现在有哪些订货单还没到齐？哪些已经逾期了？'], expect: { tools: ['order_batch.list'], writes: false } }),
  S({ id: 'W8', title: '一份订货单到了多少', look: '订货、已到、还差', turns: [(ctx) => `采购单 ${ctx.vars.p.number} 那份订货单现在到了多少、还差多少？`], expect: { tools: ['order_batch.get'], writes: false }, setup: async (ctx) => ({ p: await purchase(ctx, openPurchase) }) }),
  S({ id: 'W9a', title: '改到货安排（说清了）', look: '到货安排改成那天前全到', turns: [{ say: (ctx) => `采购单 ${ctx.vars.p.number} 那份订货单的到货安排改成全部在 ${day(10)} 之前到`, confirm: true }],
    expect: { tools: ['order_batch.schedule'], rows: { order_batches: { changed: 1 } } },
    setup: async (ctx) => ({ p: (await list(ctx, '/api/purchases')).filter(openPurchase)[1] }),
      check: (ctx) => {
        const s = ctx.q('SELECT b.schedule FROM order_batches b JOIN order_batch_purchases x ON x.batch_id=b.id WHERE x.purchase_id=?', ctx.vars.p.id)[0]?.schedule ?? '';
        return [check('到货安排改成 ' + day(10) + ' 前', s.includes(day(10)), s.slice(0, 120), 'B')];
      } }),
  S({ id: 'W9b', title: '改到货安排（没说清）', look: '先问改成哪天', turns: ['那份订货单的到货时间往后挪一挪'], expect: ask }),
  S({ id: 'W10a', title: '登记到货（说清了）', look: '登记 500 张、全部合格入库，库存加 500', turns: [{ say: (ctx) => `采购单 ${ctx.vars.p.number} 今天到货 500 张，全部合格入库，供应商送货单号 GYS-SD-901`, confirm: true }],
    // 到货单一张；以前订的采购单登记到货时才补建订货批次
    expect: { tools: ['order_batch.receive'], rows: { flow_documents: { added: 1 }, purchase_lines: { changed: 1 }, stock_movements: { added: 'any' }, stock_items: 'any', order_batches: 'any', order_batch_purchases: 'any' } },
    setup: async (ctx) => ({ p: (await list(ctx, '/api/purchases')).filter(openPurchase)[2], stock: stockSum(ctx) }),
      check: (ctx) => [check('库存一共加 500 张', stockSum(ctx) - ctx.vars.stock === 500 * UNITS, '加了 ' + (stockSum(ctx) - ctx.vars.stock) / UNITS, 'A')] }),
  S({ id: 'W10b', title: '登记到货（没说清）', look: '先问到了多少、合不合格，不猜全部合格', turns: [(ctx) => `采购单 ${ctx.vars.p.number} 的货到了`], expect: ask, setup: async (ctx) => ({ p: (await list(ctx, '/api/purchases')).filter(openPurchase)[3] ?? (await purchase(ctx, openPurchase)) }) }),
  S({ id: 'W11', title: '到货记录', look: '列出那张采购单的到货记录', turns: [(ctx) => `采购单 ${ctx.vars.p.number} 的到货记录给我看看`], expect: { tools: ['arrival.records'], writes: false },
    setup: async (ctx) => ({ p: await purchase(ctx, (p) => p.lines.some((l) => l.receivedQuantity !== '0')) }) }),
  S({ id: 'W12', title: '能退多少', look: '每行还能退多少', turns: [(ctx) => `到货单 ${ctx.vars.a.number} 还能退多少货？`], expect: { tools: ['purchase_return.returnable'], writes: false }, setup: async (ctx) => ({ a: (await docs(ctx, 'arrival', (d) => d.status === 'confirmed'))[0] }) }),
  S({ id: 'W13a', title: '采购退货再撤销', look: '退 50 张（卡片确认后）；再撤销这张退货（卡片确认后）',
    turns: [{ say: (ctx) => `到货单 ${ctx.vars.a.number} 退 50 张给供应商，原因是受潮，退货日期就今天`, confirm: true }, { say: '把刚才那张退货单撤销，原因：退错了', confirm: true }],
    expect: { tools: ['purchase_return.create', 'purchase_return.reverse'], rows: { purchase_returns: { added: 1 }, stock_movements: { added: 'any' }, flow_documents: { changed: 'any' } }, confirmed: true },
    setup: async (ctx) => ({ a: (await docs(ctx, 'arrival', (d) => d.status === 'confirmed'))[1], stock: stockSum(ctx) }),
      check: (ctx) => {
        const ret = ctx.q('SELECT status, document FROM purchase_returns WHERE arrival_id=? ORDER BY id DESC LIMIT 1', ctx.vars.a.id)[0];
        const qty = JSON.parse(ret?.document ?? '{}').lines?.reduce((n, l) => n + Number(l.quantity), 0);
        return [
          check('退货单退 50 张', qty === 50, ret ? String(qty) : '没有退货单', 'A'),
          check('退货单已撤销', ret?.status === 'reversed', ret?.status, 'B'),
          check('库存回到原数', stockSum(ctx) === ctx.vars.stock, '差 ' + (stockSum(ctx) - ctx.vars.stock) / UNITS, 'A'),
        ];
      } }),
  S({ id: 'W13b', title: '采购退货（没说清）', look: '先问退多少、原因、日期', turns: [(ctx) => `到货单 ${ctx.vars.a.number} 退点货`], expect: ask, setup: async (ctx) => ({ a: (await docs(ctx, 'arrival', (d) => d.status === 'confirmed'))[2] }) }),
  S({ id: 'W14a', title: '确认送达（说清了）', look: '记送达日期，库存不动', turns: [{ say: (ctx) => `送货单 ${ctx.vars.d.number} 客户今天已经收到了，确认送达`, confirm: true }],
    expect: { tools: ['delivery.mark_delivered'], rows: { flow_documents: { changed: 1 } } },
    setup: async (ctx) => ({ d: (await docs(ctx, 'delivery', shipping))[0] }),
      check: (ctx) => [check('送达日期是今天', flowRow(ctx, ctx.vars.d.id)?.delivered_at === day(0), flowRow(ctx, ctx.vars.d.id)?.delivered_at, 'B')] }),
  S({ id: 'W14b', title: '确认送达（没说清）', look: '先问哪张、哪天到的', turns: ['那批货客户收到了'], expect: ask }),
  S({ id: 'W15a', title: '改生产计划日期（说清了）', look: '计划日期改对', turns: [{ say: (ctx) => `生产任务 ${ctx.vars.t.number} 的计划日期改到 ${day(3)}`, confirm: true }],
    expect: { tools: ['flow.schedule'], rows: { flow_documents: { changed: 1 } } },
    setup: async (ctx) => ({ t: (await docs(ctx, 'task', (t) => t.status === 'confirmed' && !t.hasProduction))[0] }),
      check: (ctx) => [check('计划日期改到 ' + day(3), flowRow(ctx, ctx.vars.t.id)?.planned_date === day(3), flowRow(ctx, ctx.vars.t.id)?.planned_date, 'B')] }),
  S({ id: 'W15b', title: '改生产计划日期（没说清）', look: '先问哪张、改到哪天', turns: ['那个生产任务往后推几天'], expect: ask }),
  S({ id: 'W16', title: '成品批次', look: '列出批次', turns: [(ctx) => `成品 ${ctx.vars.i.name} 有哪些批次？`], expect: { tools: ['inventory.batches'], writes: false }, setup: async (ctx) => ({ i: await finishedWithStock(ctx) }) }),
  S({ id: 'W17a', title: '写批次备注（说清了）', look: '最近那批的备注写成用户的原话', turns: [{ say: (ctx) => `成品 ${ctx.vars.i.name} 最近那一批的批次备注写上：用鼎盛的纸板，质量正常`, confirm: true }],
    expect: { tools: ['flow.edit_info'], rows: { flow_documents: { changed: 1 } } },
    setup: async (ctx) => ({ i: await finishedWithStock(ctx) }),
      check: (ctx) => {
        const n = ctx.q("SELECT COUNT(*) n FROM flow_documents WHERE kind='production' AND json_extract(document,'$.notes') LIKE '%用鼎盛的纸板，质量正常%'")[0].n;
        return [check('批次备注是用户的原话', n === 1, '有这句备注的完工单 ' + n + ' 张', 'B')];
      } }),
  S({ id: 'W17b', title: '写批次备注（没说清）', look: '先问哪批、写什么', turns: ['批次备注改一下'], expect: ask }),
  S({ id: 'W18', title: '到货更正先看影响', look: '只看影响不改', turns: [(ctx) => `到货单 ${ctx.vars.a.number} 的实到数量登记错了，实际是 ${ctx.vars.n} 张，先看看改了会怎样，别改`], expect: { tools: ['arrival.correct'], writes: false },
    setup: async (ctx) => { const a = (await docs(ctx, 'arrival', (d) => d.status === 'confirmed'))[0]; return { a, n: 700 }; } }),
  S({ id: 'W19a', title: '到货更正（说清了）', look: '实到改成 N 张、全部合格入库（直接或卡片确认后）', turns: [{ say: (ctx) => `到货单 ${ctx.vars.a.number} 实到改成 ${ctx.vars.n} 张，全部合格入库`, confirm: true }],
    // 原到货单冲销、被新单替代（改 1 增 1），流水按差额补
    expect: { tools: ['arrival.correct'], rows: { flow_documents: { added: 1, changed: 1 }, purchase_lines: { changed: 1 }, stock_movements: { added: 'any' } } },
    setup: async (ctx) => ({ a: (await docs(ctx, 'arrival', (d) => d.status === 'confirmed')).at(-1), n: 600 }),
      check: (ctx) => {
        const old = flowRow(ctx, ctx.vars.a.id);
        const now = old?.replaced_by ? flowRow(ctx, old.replaced_by) : null;
        const qty = (now?.doc.lines ?? []).reduce((n, l) => n + Number(l.quantity), 0);
        return [check('原单被替代', old?.status === 'reversed' && !!now, old?.status, 'B'), check('新单实到 600 张', qty === 600, String(qty), 'A')];
      } }),
  S({ id: 'W19b', title: '到货更正（没说清）', look: '先问改成多少', turns: ['那张到货单数量不对，改一下'], expect: ask }),
  S({ id: 'W19c', title: '改到货单备注', look: '只改备注（卡片确认后），库存、数量、到货时间不动，不出替代单', turns: [{ say: (ctx) => `到货单 ${ctx.vars.a.number} 的备注改成：卸货时外箱有两处压痕，已拍照。别的都不动`, confirm: true }],
    expect: { tools: ['flow.edit_info'], cardTool: 'flow.edit_info', confirmed: true, rows: { flow_documents: { changed: 1 } } },
    setup: async (ctx) => {
        const a = (await docs(ctx, 'arrival', (d) => d.status === 'confirmed'))[0];
        return { a, before: flowRow(ctx, a.id).doc };
      },
      check: (ctx) => {
        const r = flowRow(ctx, ctx.vars.a.id), was = ctx.vars.before;
        return [
          check('备注是用户的原话', (r?.doc.notes ?? '').includes('卸货时外箱有两处压痕，已拍照'), r?.doc.notes, 'B'),
          check('还是原来那张、没被替代', r?.status === 'confirmed' && r?.doc.replacedBy == null, r?.status, 'A'),
          check('到货时间和明细没动', (r?.doc.actualTime ?? null) === (was.actualTime ?? null) && JSON.stringify(r?.doc.lines) === JSON.stringify(was.lines), r?.doc.actualTime, 'A'),
        ];
      } }),
  S({ id: 'W20a', title: '取消待送货的送货单（说清了）', look: '取消（卡片确认后），原因照用户说的', turns: [{ say: (ctx) => `取消待送货的送货单 ${ctx.vars.d.number}，原因：客户改期`, confirm: true }],
    expect: { tools: ['flow.propose_cancel'], rows: { flow_documents: { changed: 1 } } },
    setup: async (ctx) => ({ d: (await docs(ctx, 'delivery', (d) => d.status === 'draft'))[0] }), check: (ctx) => cancelled(ctx, ctx.vars.d.id, '客户改期') }),
  S({ id: 'W20b', title: '取消（没说清）', look: '先问取消哪张、原因', turns: ['把那张送货单取消了'], expect: ask }),
  S({ id: 'W21a', title: '盘点调整（说清了）', look: '调到 430 张（卡片确认后）', turns: [{ say: 'E三层纸板 800×600 盘点实际是 430 张，按盘点调整库存', confirm: true }],
    expect: { tools: ['inventory.propose_movement'], rows: { stock_movements: { added: 1 } } },
    check: (ctx) => [check('调到 430', ctx.q("SELECT after_units a FROM stock_movements m JOIN stock_items i ON i.id=m.item_id WHERE i.name='E三层纸板 800×600' ORDER BY m.seq DESC LIMIT 1")[0]?.a === 430 * 1000, '', 'A')] }),
  S({ id: 'W21b', title: '盘点调整（没说清）', look: '先问实际多少', turns: ['E三层纸板的库存不对，调一下'], expect: ask }),
  S({ id: 'W22b', title: '完工登记（没说清）', look: '先问完工多少、用了多少料', turns: ['那个生产任务做完了'], expect: ask }),
  S({ id: 'W23a', title: '取消没开工的生产任务（说清了）', look: '取消（卡片确认后），原因照用户说的', turns: [{ say: (ctx) => `生产任务 ${ctx.vars.t.number} 还没开工，取消掉，原因：客户撤单`, confirm: true }],
    expect: { tools: ['flow.propose_cancel'], rows: { flow_documents: { changed: 1 }, orders: { changed: 1 } } },
    setup: async (ctx) => ({ t: (await docs(ctx, 'task', (t) => t.status === 'confirmed' && !t.hasProduction))[1] }), check: (ctx) => cancelled(ctx, ctx.vars.t.id, '客户撤单') }),
  S({ id: 'W23b', title: '核对（没说清）', look: '先问核对哪张', turns: ['那张单子确认一下'], expect: ask }),
  S({ id: 'W24a', title: '冲销送货单（说清了）', look: '冲销（卡片确认后），原因照用户说的', turns: [{ say: (ctx) => `送货单 ${ctx.vars.d.number} 冲销，原因：客户整单退回`, confirm: true }],
    expect: { tools: ['flow.propose_reversal'], rows: { flow_documents: { changed: 1 }, stock_movements: { added: 'any' } } },
    setup: async (ctx) => ({ d: (await docs(ctx, 'delivery', shipping)).at(-1) }), check: (ctx) => reversedDelivery(ctx, ctx.vars.d.id, '客户整单退回') }),
  S({ id: 'W24b', title: '冲销（没说清）', look: '先问冲哪张、原因', turns: ['那张单冲掉'], expect: ask }),
  S({ id: 'W26a', title: '更正送货单（说清了）', look: '数量改成 N 只（卡片确认后）：原单已更正、另出一张替代单，库存和订单已发按差额变',
    turns: [{ say: (ctx) => `送货单 ${ctx.vars.d.number} 的数量登记错了，实际只发了 ${ctx.vars.n} 只，原因：仓库点数点错了`, confirm: true }],
    // 原送货单撤销、被新单替代（改 1 增 1），流水按差额补，订单的发货进度跟着变
    expect: { tools: ['delivery.correct'], rows: { flow_documents: { added: 1, changed: 1 }, stock_movements: { added: 'any' }, orders: 'any' } },
    setup: async (ctx) => {
        const d = (await docs(ctx, 'delivery', (x) => shipping(x) && x.lines.length === 1 && Number(x.lines[0].quantity) > 10)).at(0);
        return { d, n: Number(d.lines[0].quantity) - 10 };
      },
      check: (ctx) => {
        const old = flowRow(ctx, ctx.vars.d.id);
        const now = old?.replaced_by ? flowRow(ctx, old.replaced_by) : null;
        const qty = (now?.doc.lines ?? []).reduce((n, l) => n + Number(l.quantity), 0);
        return [check('原单被替代', old?.status === 'reversed' && !!now, old?.status, 'B'), check('新单发 ' + ctx.vars.n + ' 只', qty === ctx.vars.n, String(qty), 'A')];
      } }),
  S({ id: 'W26b', title: '更正送货单（没说清）', look: '先问哪张、改成多少', turns: ['那张送货单数量不对，改一下'], expect: ask }),
  S({ id: 'W27a', title: '更正完工单（说清了）', look: '合格数改成 N 只（卡片确认后）：原单已更正、另出一张替代单，成品库存按差额加',
    turns: [{ say: (ctx) => `完工单 ${ctx.vars.p.number} 的合格数登记少了，实际合格 ${ctx.vars.n} 只，原因：漏点了一箱`, confirm: true }],
    // 原完工单撤销、被新单替代；生产任务的已入库跟着变
    expect: { tools: ['production.correct'], rows: { flow_documents: { added: 1, changed: 'any' }, stock_movements: { added: 'any' }, orders: 'any' } },
    setup: async (ctx) => {
        const p = (await docs(ctx, 'production', (x) => x.status === 'confirmed' && !x.replacedBy)).at(0);
        return { p, n: Number(p.goodQuantity) + 10 };
      },
      check: (ctx) => {
        const old = flowRow(ctx, ctx.vars.p.id);
        const now = old?.replaced_by ? flowRow(ctx, old.replaced_by) : null;
        return [check('原单被替代', old?.status === 'reversed' && !!now, old?.status, 'B'), check('新单合格 ' + ctx.vars.n + ' 只', Number(now?.doc.goodQuantity) === ctx.vars.n, now?.doc.goodQuantity, 'A')];
      } }),
  S({ id: 'W25', title: '订单关联和处理路径', look: '关联单据、怎么删怎么改', turns: [(ctx) => `订单 ${ctx.vars.o.number} 关联了哪些单据？要是删掉或更正该怎么走？`], expect: { oneOf: [['management.context', 'history.records']], tools: ['management.context'], writes: false },
    setup: async (ctx) => ({ o: await order(ctx, (o) => o.shippingProgress !== '未发货') }) }),
];
