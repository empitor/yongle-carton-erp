// 业务页面的界面逻辑：今日分组、订单编辑窗、列表筛选、归档结果提示、只读账号、数据管理下拉。直接调用或渲染成 HTML。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { canEditBusiness, readOnlyNotice } from '../src/ui/auth-state.js';
import { notify, readNotice } from '../src/ui/events.js';
import { joinReasons, lifecycleOutcome } from '../src/recordkit/lifecycle.js';
import { currentRelated, relatedKey } from '../src/records/useRelatedData.js';
import CommandPalette, { paletteActions } from '../src/CommandPalette.js';
import { fieldChoices } from '../src/admin/field-rules.js';
import { batchAfterSave } from '../src/operations/OrderBatchDialog.js';
import OrderEditor from '../src/editors/OrderEditor.js';
import CustomerEditor from '../src/editors/CustomerEditor.js';
import SupplierEditor from '../src/editors/SupplierEditor.js';
import { finishInboxOrder, inboxOrderSource } from '../src/import/InboxOrderDialog.js';
import { productSchema, today } from '../shared/core/domain.js';
import { trackedOrderViewSchema } from '../shared/core/index.js';
import TodayRow from '../src/records/TodayRow.js';
import { daysLate, specCheckOrders, todayGroups } from '../src/records/today-groups.js';
import { archivedRoute, readListFilters, recordListQueries } from '../src/records/record-filters.js';
import { orderStepDialog } from '../src/records/order-step.js';
import { blankLine, initialLines, orderPayload, orderTotals } from '../src/editors/order-draft.js';

test('订单详情换了一张单：上一张单读回来的关联单据不再用，读失败也不留旧数据', () => {
  const a = relatedKey('orders', 1),
    b = relatedKey('orders', 2);
  const loaded = { key: a, data: { tasks: [{ id: 9 }] }, error: '' };
  assert.deepEqual(currentRelated(loaded, a, true), { data: loaded.data, error: '' });
  // 切到第二张，第一张的结果不能拿来算“下一步”
  assert.deepEqual(currentRelated(loaded, b, true), { data: null, error: '' });
  // 读失败：不留旧数据，只给原因
  assert.deepEqual(currentRelated({ key: b, data: { tasks: [] }, error: '服务暂时不可用' }, b, true), {
    data: null,
    error: '服务暂时不可用',
  });
  // 只读账号不读
  assert.deepEqual(currentRelated(loaded, a, false), { data: null, error: '' });
});

test('窗口关了但没办成：底部提示用红色说原因；原来只给文字的提示照常是办成了', () => {
  assert.deepEqual(readNotice('已安排生产'), { message: '已安排生产', tone: 'done' });
  assert.deepEqual(readNotice({ message: '没找到这张单据', tone: 'error' }), { message: '没找到这张单据', tone: 'error' });
  assert.equal(readNotice(''), null);
  assert.equal(readNotice({ tone: 'error' }), null);
  // 只是提醒（不是办成了）的口气认得出，不认识的口气按办成了
  assert.deepEqual(readNotice({ message: '关掉当前窗口后进入 AI 导入', tone: 'info' }), { message: '关掉当前窗口后进入 AI 导入', tone: 'info' });
  assert.deepEqual(readNotice({ message: '已保存', tone: 'other' }), { message: '已保存', tone: 'done' });
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'window'),
    target = new EventTarget(),
    seen: unknown[] = [];
  Object.defineProperty(globalThis, 'window', { value: target, configurable: true, writable: true });
  target.addEventListener('erp-notice', (e: Event) => seen.push(e instanceof CustomEvent ? e.detail : undefined));
  try {
    notify('核对没通过：库存不够', 'error');
    assert.deepEqual(seen.map(readNotice), [{ message: '核对没通过：库存不够', tone: 'error' }]);
  } finally {
    if (saved) Object.defineProperty(globalThis, 'window', saved);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('只读账号：搜索面板不给新建、安排、登记这类操作，新建链接只提示一句', () => {
  type Auth = NonNullable<Parameters<typeof canEditBusiness>[0]>;
  const viewer: Auth = { actor: { id: 'v', name: '虚构只读', permissions: [] } },
    staff: Auth = { actor: { id: 's', name: '虚构业务员', permissions: ['business:edit'] } },
    superAdmin: Auth = { actor: { id: 'a', name: '虚构管理员', permissions: [], superAdminMode: true } };
  assert.equal(canEditBusiness(viewer), false);
  assert.equal(canEditBusiness(null), false);
  assert.equal(canEditBusiness(staff), true);
  assert.equal(canEditBusiness(superAdmin), true);
  assert.deepEqual(paletteActions(false), []);
  assert.ok(paletteActions(true).some((a) => a.label === '新建订单'));
  const html = renderToStaticMarkup(h(CommandPalette, { close: () => {}, canEdit: false }));
  assert.doesNotMatch(html, /新建订单|新建采购单|安排生产|安排送货|登记到货|输入“新建”/);
  assert.match(readOnlyNotice, /只能查看/);
});

test('数据管理的下拉：存的值不变，显示中文，不出现“草稿”和英文代码', () => {
  const texts = (key: string, current: unknown, module?: string) =>
    (fieldChoices(key, current, module) || []).map(([, text]) => text).join('|');
  const values = (key: string, current: unknown, module?: string) =>
    (fieldChoices(key, current, module) || []).map(([value]) => value);
  assert.doesNotMatch(texts('status', '待确认', 'orders'), /草稿/);
  assert.match(texts('status', '待确认', 'orders'), /待确认/);
  assert.ok(values('status', '待确认', 'orders').includes('待确认'), '存的就是待确认');
  assert.match(texts('status', '已订货', 'purchases'), /待到货/);
  assert.match(texts('status', 'draft', 'delivery'), /待送货/);
  assert.match(texts('status', 'reversed', 'arrival'), /已撤销/);
  assert.equal(texts('kind', 'raw', 'stock_items'), '原材料|成品');
  assert.equal(texts('priceBasis', 'area'), '按平方米|按张');
  assert.doesNotMatch(texts('roundingPolicy', 'exact-cents'), /exact|half/);
  assert.doesNotMatch(texts('dimensionUnit', 'mm'), /^mm$/m);
  // 不在清单里的老值也列出来，不会一打开就被改掉
  assert.ok(values('status', '部分到货', 'purchases').includes('部分到货'));
  assert.equal(fieldChoices('notes', 'x'), null);
});

test('重新导出订货单：到货安排存进批次后换成新版本，导出失败再点不会拿旧版本去存', () => {
  const batch = { id: 3, number: 'DH-虚构-3', version: 4 };
  assert.deepEqual(batchAfterSave(batch, { id: 3, version: 5, rows: [] }), { ...batch, version: 5 });
  assert.deepEqual(batchAfterSave(batch, null), batch);
});

test('新建订单的交货日期留空要自己填（不猜日期），下单日期默认今天', () => {
  const html = renderToStaticMarkup(
    h(OrderEditor, { customers: [], products: [], close: () => {}, saved: () => {} }),
  );
  const [orderDate = '', deliveryDate = ''] = html.match(/<input[^>]*type="date"[^>]*>/g) || [];
  assert.match(orderDate, new RegExp('value="' + today() + '"'), '下单日期是今天');
  assert.match(deliveryDate, /value=""/, '交货日期空着');
  assert.match(deliveryDate, /required/);
});

test('订单编辑窗：不传对照原文时不显示原文区，传入后显示原文和下载链接', () => {
  const plain = renderToStaticMarkup(
    h(OrderEditor, { customers: [], products: [], close: () => {}, saved: () => {} }),
  );
  assert.doesNotMatch(plain, /<aside\b/, '没传对照原文时不显示原文区');
  const source = inboxOrderSource({
    id: 7,
    status: 'pending',
    senderName: '虚构李工',
    conversation: '虚构客户群',
    text: '外箱加急 500 只',
    fileName: '说明.txt',
  });
  const withSource = renderToStaticMarkup(
    h(OrderEditor, { customers: [], products: [], source, close: () => {}, saved: () => {} }),
  );
  assert.match(withSource, /aria-label="收件箱原文"/);
  assert.match(withSource, /虚构李工 · 虚构客户群/);
  assert.match(withSource, /保存订单后标为已处理/);
  assert.match(withSource, /外箱加急 500 只/);
  assert.match(withSource, /href="\/api\/inbox\/7\/file"/);
  assert.match(withSource, /下载 说明\.txt/);
});

test('收件箱建订单：保存成功后按原收件编号和版本标为已处理并提示结果', async () => {
  const seen: Array<{ id: number; version: number }> = [];
  const ok = await finishInboxOrder(
    { id: 7, version: 3, status: 'pending' },
    { number: 'SO-虚构-7' },
    '订单 SO-虚构-7 已建立并确认。',
    async (item) => {
      seen.push({ id: item.id, version: item.version });
    },
  );
  assert.deepEqual(seen, [{ id: 7, version: 3 }]);
  assert.deepEqual(ok, { message: '订单 SO-虚构-7 已建立并确认，收件已标为已处理。', tone: 'done' });
});

test('收件箱建订单：标为已处理失败时不吞错，返回带单号和原因的错误提示', async () => {
  const seen: Array<{ id: number; version: number }> = [];
  const failed = await finishInboxOrder(
    { id: 7, version: 3, status: 'pending' },
    { number: 'SO-虚构-7' },
    '订单 SO-虚构-7 已建立，待确认。',
    async (item) => {
      seen.push({ id: item.id, version: item.version });
      throw new Error('记录已修改，请刷新。');
    },
  );
  assert.deepEqual(seen, [{ id: 7, version: 3 }]);
  assert.deepEqual(failed, {
    message: '订单 SO-虚构-7 已建立，但收件没能标为已处理：记录已修改，请刷新。',
    tone: 'error',
  });
});

test('收件箱建订单：已处理收件不再重复调用标记，沿用订单保存提示', async () => {
  let called = false;
  const alreadyDone = await finishInboxOrder(
    { id: 7, version: 2, status: 'converted' },
    { number: 'SO-虚构-7' },
    '订单 SO-虚构-7 已建立，待确认。',
    async () => {
      called = true;
    },
  );
  assert.equal(called, false);
  assert.deepEqual(alreadyDone, { message: '订单 SO-虚构-7 已建立，待确认。', tone: 'done' });
});

test('订单编辑窗：有一项单价超上限算不出金额时，合计显示“—”并说明是哪一项，不显示 0.00', () => {
  const line = { productId: 1, productName: '虚构外箱', unit: '只', specification: '', notes: '', shippedQuantity: 0, shippingStatus: '未发货' };
  // 读出来的订单视图要的其余几项（编号、客户名、合计、时间）照样填上，编辑窗按明细自己算合计
  const value = trackedOrderViewSchema.parse({
    id: 1,
    number: 'SO-虚构-1',
    version: 1,
    customerId: 1,
    customerName: '虚构客户',
    orderDate: '2026-11-01',
    deliveryDate: '2026-11-20',
    status: '待确认',
    shippingProgress: '未发货',
    shippingSummary: { progress: '未发货', completedLines: 0, totalLines: 2 },
    materialProgress: 'none',
    notes: '',
    costs: null,
    totalCents: 0,
    costCents: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    lines: [
      { ...line, id: 11, quantity: 100, remainingQuantity: 100, unitPriceExact: '1.5', unitPriceCents: 150 },
      { ...line, id: 12, quantity: 10, remainingQuantity: 10, unitPriceExact: '2000000', unitPriceCents: 200000000 },
    ],
  });
  const html = renderToStaticMarkup(h(OrderEditor, { customers: [], products: [], close: () => {}, saved: () => {}, value }));
  const total = html.split('class="sales-order-total"')[1] || '';
  assert.match(total, /第 2 项金额算不出来/);
  assert.match(total, /<strong>—<\/strong>/);
  assert.doesNotMatch(total, /¥0\.00/);
});


test('成品库存的材质、楞型不重复：规格说明里已有的段，列表规格列去掉，详情页头不再接一遍', async () => {
  const { specWithoutMaterial } = await import('../src/records/RecordPanel.js');
  const finished = { specification: '420 × 320 × 300 mm / K=A / BC / 四色印刷，钉箱', material: 'K=A', flute: 'BC' };
  assert.equal(specWithoutMaterial(finished), '420 × 320 × 300 mm / 四色印刷，钉箱');
  // 原材料的规格是人写的，不按“ / ”拼，原样保留
  assert.equal(specWithoutMaterial({ specification: 'K=A/BE 1400×1100', material: 'K=A', flute: 'BE' }), 'K=A/BE 1400×1100');
  assert.equal(specWithoutMaterial({ specification: '', material: 'K=A', flute: 'BC' }), '');
});

test('手机卡片只把地址、备注、加工要求这类长字段标成可隐藏', () => {
  const list = readFileSync('src/records/record-columns.tsx', 'utf8');
  const marked = [...list.matchAll(/<td className="[^"]*\bm-long\b[^"]*">\{row\.(\w+)/g)].map((m) => m[1]).sort();
  // 只标地址、备注、加工要求这类长字段（库存备注、客户和供应商的地址和备注、产品加工要求）
  assert.deepEqual(marked, ['address', 'notes', 'notes', 'requirements']);
});

test('归档、恢复没办成：只在列表上方说一次，全没办成不写“已归档 0 种”，用危险色或提醒色', () => {
  const name = (id: number) => '虚构' + id;
  assert.deepEqual(lifecycleOutcome('archive', [{ id: 1, success: true }], name, '张').notice, '已归档 虚构1，在列表的“已归档”里能找到和恢复。');
  const none = lifecycleOutcome('archive', [{ id: 1, success: false, message: '还没核对的单据不能归档。' }], name, '张');
  assert.equal(none.problem, '虚构1 没能归档：还没核对的单据不能归档。');
  assert.equal(none.tone, 'danger');
  const some = lifecycleOutcome('restore', [{ id: 1, success: true }, { id: 2, success: false, message: '记录已修改，请刷新。' }], name, '种');
  assert.equal(some.problem, '已恢复 1 种；1 种没能恢复。虚构2：记录已修改，请刷新。');
  assert.equal(some.tone, 'warning');
  // 几条服务端原因（自带句号）连成一句：不出现“。；”“。。”，整句一个句号收尾
  const joined = joinReasons([
    '虚构水壶外箱：库存还不是零，不能归档；要删的话可以直接删除。',
    '虚构礼盒外箱：订单还没发完货，不能归档。',
  ]);
  assert.equal(joined, '虚构水壶外箱：库存还不是零，不能归档；要删的话可以直接删除；虚构礼盒外箱：订单还没发完货，不能归档。');
  assert.doesNotMatch(joined, /。；|。。|；。/);
  assert.equal(joinReasons(['虚构原因；', '  ', '虚构原因二']), '虚构原因；虚构原因二。');
  // 几条都带同一句后半句（服务端按账号补的删除说法）：只在最后说一次
  assert.equal(
    joinReasons([
      '虚构水壶外箱：库存还不是零，不能归档；要删的话可以直接删除。',
      '虚构礼盒外箱：库存还不是零，不能归档；要删的话可以直接删除。',
    ]),
    '虚构水壶外箱：库存还不是零，不能归档；虚构礼盒外箱：库存还不是零，不能归档；要删的话可以直接删除。',
  );
  assert.equal(joinReasons(['']), '');
});

test('今日页：明细规格对不上的订单显示和订单详情“下一步”同一句提示，每张单只在一组里出现', () => {
  // 句子来自服务端 specMismatch / todo[].mismatches（和 orderNextSteps 的 notes 同一句），界面原样显示
  const sentence =
    '虚构彩箱：规格和产品现在的不一样，订单明细写的是 300×200×100，产品现在是 310×200×100，请核对这张订单的明细，核对好之前送不了货';
  const queue = {
    todo: [{ id: 2, group: 'ship', mismatches: [] }],
    specMismatch: [
      { id: 1, number: 'SO-虚构-1', mismatches: [sentence] },
      { id: 2, number: 'SO-虚构-2', mismatches: ['已经在“可发货”里的那张'] },
    ],
  };
  // 已进分组的（2 号）提示挂在那一行下面，不再单独列；没进分组的（1 号）列进“要核对订单”
  assert.deepEqual(
    specCheckOrders(queue).map((o) => o.id),
    [1],
  );
  assert.deepEqual(specCheckOrders({ todo: [] }), [], '老数据没有 specMismatch 也不出错');
  const html = renderToStaticMarkup(
    h(TodayRow, {
      row: { key: 's1', number: 'SO-虚构-1', main: '虚构客户 · 虚构彩箱', href: '#orders?order=1', hints: [sentence] },
    }),
  );
  assert.match(html, /<li class="td-row has-hint">/);
  assert.ok(html.includes('<p class="record-hint tone-warning">' + sentence + '</p>'), '用公共的黄色提示，整句显示');
  const plain = renderToStaticMarkup(
    h(TodayRow, { row: { key: 'o2', number: 'SO-虚构-2', main: '虚构客户', href: '#orders?order=2' } }),
  );
  assert.match(plain, /^<li class="td-row">/);
  assert.doesNotMatch(plain, /record-hint/, '没有提示的行不多出空的提示');
});

test('今日分组、订单下一步对应的窗口、订单编辑窗的合计和提交内容：纯计算直接调用', () => {
  const groups = todayGroups({
    data: {
      todo: [
        { id: 1, group: 'schedule', number: 'SO-虚构-1', customerName: '虚构客户', lines: [{ productName: '虚构箱' }], deliveryDate: '2026-11-01', lateDays: 2, step: { kind: 'schedule', label: '安排生产' } },
        { id: 2, group: 'ship', number: 'SO-虚构-2', customerName: '虚构客户', summary: '虚构箱 等2项', deliveryDate: '2026-11-20' },
      ],
      specMismatch: [],
      draftDeliveries: [{ id: 9, number: 'SH-虚构-9', customerName: '虚构客户', plannedDate: '2026-11-01' }],
      toOrder: [],
      arrivalsDue: [],
    },
    pendingConfirm: { rows: [], total: 0 },
    mail: { rows: [], total: 0 },
    imports: [],
    today: '2026-11-13',
  });
  const group = (id: string) => {
    const found = groups.find((g) => g.id === id);
    if (!found) throw new Error('今日页没有分组 ' + id);
    return found;
  };
  assert.equal(group('schedule').rows[0].action?.kind, 'step');
  assert.equal(group('schedule').rows[0].note, '交期 11-01');
  // 可发货：逾期的送货单（12 天）排在没逾期的订单前面
  assert.deepEqual(group('ship').rows.map((r) => [r.key, r.late, r.action?.kind]), [['d9', 12, 'export'], ['o2', undefined, 'ship']]);
  assert.deepEqual(daysLate('2026-11-01', '2026-11-13'), 12);

  // 今日页和订单详情的“下一步”打开同一个窗口
  assert.deepEqual(orderStepDialog(1, { kind: 'schedule' }), { type: 'task', orderIds: [1] });
  assert.deepEqual(orderStepDialog(1, { kind: 'delivery' }), { type: 'delivery', orderIds: [1] });
  assert.deepEqual(orderStepDialog(1, { kind: 'purchase', params: { order: '1', products: '3,4' } }), { type: 'purchase', orderId: 1, productIds: [3, 4] });
  assert.equal(orderStepDialog(1, { kind: 'confirm' }), null);

  // 订单编辑窗：从产品新建带出参考单价；单价没填的那行不算合计；提交带上分和精确单价
  let n = 0;
  const key = () => 'line-' + n++;
  const box = { ...productSchema.parse({ name: '虚构箱', priceCents: 150 }), id: 2, version: 1, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' };
  const lines = initialLines(undefined, { productIds: [2] }, [box], key);
  assert.equal(lines[0].price, '1.50');
  const filled = [{ ...lines[0], quantity: '10' }, { ...blankLine(key()), quantity: '5' }];
  const costs = { material: '1', processing: '', waste: '', other: '', basis: '' };
  assert.deepEqual(orderTotals(filled, costs).uncounted, [2]);
  assert.equal(orderTotals([filled[0]], { ...costs, material: '0' }).total, 1500);
  const payload = orderPayload({ extras: {}, customerId: '3', orderDate: '2026-11-13', deliveryDate: '2026-11-20', status: '待确认', notes: '', lines: [filled[0]], costed: false, costs });
  assert.equal(payload.customerId, 3);
  assert.equal(payload.lines[0].unitPriceCents, 150);
  assert.equal(payload.lines[0].unitPriceExact, '1.50');
  assert.equal(payload.costs, null);
});

test('订单、客户、产品列表的条件：从地址读筛选、拼读列表的参数（直接调用）', () => {
  const f = readListFilters('#orders?status=' + encodeURIComponent('已确认') + '&customerId=7&range=custom&start=2026-11-01&end=2026-11-30');
  assert.deepEqual(f, { view: 'pending', preset: 'custom', start: '2026-11-01', end: '2026-11-30', status: '已确认', customerId: '7' });
  assert.equal(readListFilters('#orders?status=abc&customerId=x').status, '');
  assert.equal(readListFilters('#orders?customerId=x&range=bogus').customerId, '', '不认识的客户编号当作没筛选');
  // 自定义日期两头都写坏：当作没有日期筛选（筛选按钮上不计数）；只坏一头的照另一头筛
  assert.deepEqual(
    (({ preset, start, end }) => ({ preset, start, end }))(readListFilters('#orders?range=custom&start=bad&end=2026-13-45')),
    { preset: 'all', start: '', end: '' },
  );
  assert.equal(readListFilters('#orders?range=custom&start=bad&end=2026-11-30').preset, 'custom');
  assert.equal(readListFilters('#orders?range=custom&start=bad&end=2026-11-30').start, '');
  assert.equal(archivedRoute('#customers?scope=archived'), true);
  const base = {
    page: 'orders', search: '虚构', customerId: '7', status: '已确认', start: '2026-11-01', end: '2026-11-30',
    orderView: 'pending' as const, archivedView: false, allRecordsView: false, productAttention: false,
    superMode: false, orderPage: 2, orderSort: 'due' as const, pageSize: 50,
  };
  const q = recordListQueries(base);
  assert.equal(q.orders.view, 'pending');
  assert.equal(q.orders.page, 2);
  assert.equal(q.orders.q, '虚构');
  assert.equal(q.customers.archived, undefined);
  // 归档页只读已归档的，不带筛选
  const trash = recordListQueries({ ...base, page: 'trash' });
  assert.equal(trash.orders.archived, '1');
  assert.equal(trash.orders.customerId, undefined);
  assert.equal(trash.products.archived, '1');
  // 超级管理员勾了“全部记录”：连同已归档的
  assert.equal(recordListQueries({ ...base, superMode: true, allRecordsView: true }).orders.archived, 'all');
});

test('客户和供应商编辑窗各自独立：标题、名称栏、保存按钮和代理标识按各自的档案种类渲染，共用怎么联系和底栏', () => {
  const newCustomer = renderToStaticMarkup(h(CustomerEditor, { close: () => {}, saved: () => {} }));
  assert.match(newCustomer, /新建客户/);
  assert.match(newCustomer, /aria-label="客户名称"/);
  assert.match(newCustomer, /aria-label="客户地址"/);
  assert.match(newCustomer, /aria-label="客户备注"/);
  assert.match(newCustomer, /保存客户/);
  assert.doesNotMatch(newCustomer, /供应商/);

  const editCustomer = renderToStaticMarkup(
    h(CustomerEditor, {
      value: { id: 11, version: 2, name: '虚构客户甲', contact: '张工', phone: '0574-1111', address: '虚构路1号', notes: '客户备注', createdAt: '2026-11-01', updatedAt: '2026-11-01' },
      close: () => {},
      saved: () => {},
    }),
  );
  assert.match(editCustomer, /编辑客户/);
  assert.match(editCustomer, /data-agent-module="customers"/);
  assert.match(editCustomer, /data-agent-record="11"/);

  const newSupplier = renderToStaticMarkup(h(SupplierEditor, { quick: true, close: () => {}, saved: () => {} }));
  assert.match(newSupplier, /新建供应商/);
  assert.match(newSupplier, /保存后直接选进当前单据，已填的内容保留/);
  assert.match(newSupplier, /aria-label="供应商名称"/);
  assert.match(newSupplier, /aria-label="供应商地址"/);
  assert.match(newSupplier, /aria-label="供应商备注"/);
  assert.match(newSupplier, /保存供应商/);
  assert.doesNotMatch(newSupplier, /客户/);

  const editSupplier = renderToStaticMarkup(
    h(SupplierEditor, {
      value: { id: 22, version: 3, name: '虚构纸板厂', contact: '李工', phone: '0574-2222', address: '虚构路2号', notes: '供应商备注', createdAt: '2026-11-01', updatedAt: '2026-11-01' },
      close: () => {},
      saved: () => {},
    }),
  );
  assert.match(editSupplier, /编辑供应商/);
  assert.match(editSupplier, /data-agent-module="suppliers"/);
  assert.match(editSupplier, /data-agent-record="22"/);
});

