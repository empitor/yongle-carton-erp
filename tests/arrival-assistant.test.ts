import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { arrivalAssistantFixture } from './arrival-assistant-fixture.js';
import { arrivalReviewSchema } from '../shared/arrival-assistant.js';
import { FlowService } from '../server/flow/service.js';
import { AuthManager } from '../server/auth.js';
import { createApp } from '../server/app.js';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import ArrivalDraftForm from '../src/import/ArrivalDraftForm.js';
import OrderChat from '../src/import/OrderChat.js';
const reply = (operations: any[] = [], more: any = {}) => ({
  reply: '核对结果',
  operations,
  questions: [],
  lookups: [],
  ...more,
});
const op = (field: string, value: string | null, line = 1) => ({
  op: 'set-line',
  field,
  value,
  line,
  reason: '用户明确修改当前纸板',
});

test('原识别数字有歧义时仍可读取并逐项修正，不静默截断单价，也不阻止无关字段修改', async () => {
  const f = await arrivalAssistantFixture();
  try {
    const source = f.ai.source(f.manager.get(f.workspace.id).arrivalSourceId!);
    source.result.lines[0].quantity = '1,000';
    source.result.lines[0].unitPrice = '2.12345';
    f.store.db
      .prepare('UPDATE flow_sources SET document=? WHERE id=?')
      .run(JSON.stringify({ result: source.result }), source.id);
    assert.equal(f.view().draft.lines[0].unitPrice, '2.12345');
    assert(f.view().issues.length);
    f.replies.push(reply([op('notes', '先核对未决数字')]));
    let v = await f.chat('第一项备注改成先核对未决数字');
    assert.equal(v.draft.lines[0].quantity, '1,000');
    f.replies.push(
      reply([op('quantity', '1000'), op('statedQuantity', '1000'), op('unitPrice', '2.1234')]),
    );
    v = await f.chat('确认原单和实收都是1000张，单价更正2.1234');
    assert.equal(v.draft.lines[0].quantity, '1000');
    assert.equal(v.draft.lines[0].unitPrice, '2.1234');
  } finally {
    f.close();
  }
});

test('助手采购匹配复用本供应商真实采购明细，不能串到其他供应商或错误规格', async () => {
  const f = await arrivalAssistantFixture();
  try {
    const p = f.ops.savePurchase(
      {
        supplierId: f.supplier.id,
        orderDate: '2026-10-27',
        status: '已订货',
        lines: [
          {
            name: '虚构采购纸板',
            unit: '张',
            specification: '100x80cm',
            material: 'K=A',
            flute: 'BC',
            length: 100,
            width: 80,
            dimensionUnit: 'cm',
            quantity: '1000',
            stockItemId: f.raw.id,
          },
        ],
      },
      f.actor,
    );
    f.replies.push(
      reply([], { lookups: [{ kind: 'purchases', query: p.number, line: 1 }] }),
      reply([{ op: 'match-purchase', line: 1, id: p.lines[0].id, reason: '用户指定真实采购单' }]),
    );
    const v = await f.chat('第一项匹配采购单' + p.number);
    assert.equal(v.draft.lines[0].purchaseLineId, p.lines[0].id);
    assert.equal(v.draft.lines[0].stockId, f.raw.id);
    assert.equal(f.ops.repo.balance(f.raw.id), 0);
  } finally {
    f.close();
  }
});

test('到货明细复用字段组件，无宽表结构且全部业务字段可编辑；订单助手原文案保留', async () => {
  const f = await arrivalAssistantFixture();
  try {
    const markup = renderToStaticMarkup(
      createElement(ArrivalDraftForm, {
        value: f.view().draft,
        data: { suppliers: [f.supplier], purchases: [], items: [f.raw] },
        locked: false,
        change: () => {},
      }),
    );
    assert(!markup.includes('<table'));
    assert(!markup.includes('oi-lines-scroll'));
    for (const label of [
      '到货供应商',
      '供应商送货单号',
      '到货日期',
      '纸板1名称',
      '纸板1规格型号',
      '纸板1材质',
      '纸板1楞型',
      '纸板1长',
      '纸板1宽',
      '纸板1尺寸单位',
      '纸板1实收数量',
      '纸板1单价',
      '纸板1计价依据',
      '纸板1匹配采购明细',
      '纸板1匹配原材料档案',
      '纸板1原单面积',
      '纸板1备注',
      '纸板1差异原因',
    ])
      assert(markup.includes(label), label);
    const order = renderToStaticMarkup(
      createElement(OrderChat, { locked: false, unsaved: false, send: async () => true }),
    );
    assert(order.includes('订单助手'));
    assert(order.includes('当前订单聊天记录'));
    assert(order.includes('给订单助手的消息'));
  } finally {
    f.close();
  }
});

test('助手真实调用Provider，改数量后精确重算面积、保留原单数据、消息与修改持久化且可撤销', async () => {
  const f = await arrivalAssistantFixture();
  try {
    f.replies.push(reply([op('quantity', '300', 2)]));
    const id = randomUUID(),
      v = await f.chat('第二项实收数量改成300张', id);
    assert.equal(v.draft.lines[1].quantity, '300');
    assert.equal(v.draft.lines[1].statedQuantity, '100');
    assert.equal(v.draft.lines[1].statedArea, '80');
    assert.equal(v.totals.quantity, 400);
    assert.equal(v.totals.area, '320');
    assert(v.changes.some((c: any) => c.field.includes('实收张数')));
    assert.equal(f.store.orders().length, 0);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM stock_movements').get()!.n, 0);
    await f.chat('第二项实收数量改成300张', id);
    assert.equal(f.requests.length, 1);
    f.reopen();
    assert.equal(f.view().draft.lines[1].quantity, '300');
    assert.equal(f.view().messages.length, 2);
    const restored = f.ai.draftAssistant.undo(
      f.manager,
      f.workspace.id,
      { expectedRevision: f.view().workspace.revision },
      f.actor,
    );
    assert.equal(restored.draft.lines[1].quantity, '100');
    assert.equal(restored.totals.area, '160');
  } finally {
    f.close();
  }
});

test('mm/cm按实际尺寸换算不改面积，未知单位不猜测，非法张数/日期/字段原子拒绝', async () => {
  const f = await arrivalAssistantFixture();
  try {
    f.replies.push(reply([op('dimensionUnit', 'mm')]));
    let v = await f.chat('第一项尺寸单位换成毫米');
    assert.equal(v.draft.lines[0].item.length, 1000);
    assert.equal(v.draft.lines[0].item.width, 800);
    assert.equal(v.totals.area, '160');
    for (const invalid of [
      op('quantity', '1.5'),
      op('dimensionUnit', 'm'),
      { op: 'set-header', field: 'date', value: '2026-02-30', reason: '无效日期' },
      { op: 'confirm-stock', quantity: '900' },
    ]) {
      const before = JSON.stringify(f.view().draft);
      f.replies.push(reply([op('notes', '不应部分保存'), invalid]));
      await assert.rejects(() => f.chat('修改字段'));
      assert.equal(JSON.stringify(f.view().draft), before);
    }
    const unknown = structuredClone(f.view().draft);
    unknown.lines[0].item.dimensionUnit = null;
    v = f.ai.draftAssistant.sync(
      f.manager,
      f.workspace.id,
      { expectedRevision: f.view().workspace.revision, draft: unknown },
      f.actor,
    );
    assert.equal(v.totals.unknownArea, 1);
    assert.equal(v.totals.area, '80');
  } finally {
    f.close();
  }
});

test('实时查询并唯一匹配供应商与相同规格原材料，档案不全量外发，规格变化解除过期匹配', async () => {
  const f = await arrivalAssistantFixture();
  try {
    const other = f.ops.saveSupplier(
      { name: '虚构新供应商', notes: 'NEVER-SEND-THIS-NOTE' },
      f.actor,
    );
    f.replies.push(
      reply([], { lookups: [{ kind: 'suppliers', query: '虚构新供应商' }] }),
      reply([{ op: 'match-supplier', id: other.id, reason: '用户选择明确供应商' }]),
    );
    let v = await f.chat('供应商改成虚构新供应商');
    assert.equal(v.draft.supplierId, other.id);
    assert(!JSON.stringify(f.requests).includes('NEVER-SEND-THIS-NOTE'));
    f.replies.push(
      reply([], { lookups: [{ kind: 'materials', query: f.raw.name, line: 1 }] }),
      reply([{ op: 'match-stock', line: 1, id: f.raw.id, reason: '明确匹配实际原材料档案' }]),
    );
    v = await f.chat('第一项匹配虚构匹配纸板甲');
    assert.equal(v.draft.lines[0].stockId, f.raw.id);
    f.replies.push(reply([op('material', 'K=C')]));
    v = await f.chat('第一项材质改为K=C');
    assert.equal(v.draft.lines[0].stockId, null);
    assert.equal(f.ops.repo.balance(f.raw.id), 0);
  } finally {
    f.close();
  }
});

test('查询有歧义时提问且不修改，无查询依据的ID及跨文件来源不能强行匹配', async () => {
  const f = await arrivalAssistantFixture();
  try {
    f.ops.saveSupplier({ name: '相似供应商甲' }, f.actor);
    const other = f.ops.saveSupplier({ name: '相似供应商乙' }, f.actor);
    f.replies.push(
      reply([], { lookups: [{ kind: 'suppliers', query: '相似供应商' }] }),
      reply([], { questions: ['请选择相似供应商甲或乙。'] }),
    );
    const v = await f.chat('匹配相似供应商');
    assert(v.messages.at(-1)!.text.includes('请选择'));
    assert.equal(v.draft.supplierId, f.supplier.id);
    f.replies.push(reply([{ op: 'match-supplier', id: other.id, reason: '不允许直接猜ID' }]));
    await assert.rejects(() => f.chat('看看供应商'), /未唯一匹配/);
    const draft = structuredClone(f.view().draft);
    draft.sourceId = randomUUID();
    assert.throws(
      () =>
        f.ai.draftAssistant.sync(
          f.manager,
          f.workspace.id,
          { expectedRevision: f.view().workspace.revision, draft },
          f.actor,
        ),
      /其他文件/,
    );
  } finally {
    f.close();
  }
});

test('手工修改/模式切换/身份变化使迟到AI结果失效，切换文件不共享助手草稿', async () => {
  const f = await arrivalAssistantFixture();
  try {
    let release!: (v: any) => void;
    const waiting = new Promise((r) => (release = r));
    let begun!: () => void;
    const started = new Promise<void>((r) => (begun = r));
    f.replies.push(async () => {
      begun();
      return waiting;
    });
    const pending = f.chat('第一项数量改为500');
    await started;
    const w = f.manager.get(f.workspace.id);
    f.manager.setMode(w.id, { expectedRevision: w.revision, mode: 'order' });
    release(reply([op('quantity', '500')]));
    await assert.rejects(() => pending, /到货单模式|已变化/);
    const current = f.manager.get(w.id);
    f.manager.setMode(w.id, { expectedRevision: current.revision, mode: 'arrival' });
    assert.equal(f.view().draft.lines[0].quantity, '100');
    const second = await f.upload('另一个文件工作区.png');
    const secondView = f.ai.draftAssistant.view(f.manager, second.id, f.actor);
    assert.equal(secondView.messages.length, 0);
    f.replies.push(reply([op('quantity', '200')]));
    await assert.rejects(() => f.chat('修改数量', randomUUID(), () => null as any), /登录/);
    assert.equal(
      f.ai.draftAssistant.view(f.manager, second.id, f.actor).draft.lines[0].quantity,
      '100',
    );
  } finally {
    f.close();
  }
});

test('到货助手不入库，原保存/确认服务仍事务增加原材料并幂等，确认后助手不能改历史', async () => {
  const f = await arrivalAssistantFixture();
  try {
    f.replies.push(reply([op('quantity', '300')]));
    const result = await f.chat('第一项实收数量300张');
    const service = new FlowService(f.store),
      doc = service.save('arrival', result.draft, f.actor),
      w = f.manager.get(f.workspace.id);
    f.manager.linkArrival(w.id, {
      expectedRevision: w.revision,
      docId: doc.id,
      sourceId: doc.sourceId,
    });
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM stock_movements').get()!.n, 0);
    const preview = service.preview(doc.id, f.actor, 'test'),
      input = { previewId: preview.previewId, requestId: randomUUID(), acknowledged: true };
    service.confirm(doc.id, input, f.actor, 'test');
    service.confirm(doc.id, input, f.actor, 'test');
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM stock_movements').get()!.n, 2);
    assert.equal(f.store.orders().length, 0);
    const items = f.ops.repo.items();
    assert.equal(items.filter((s: any) => s.kind === 'finished').length, 0);
    assert.equal(
      items.reduce((n: number, s: any) => n + s.balanceUnits, 0),
      400000,
    );
    await assert.rejects(() => f.chat('第一项数量改成900'), /已确认/);
  } finally {
    f.close();
  }
});

test('到货助手HTTP鉴权、CSRF、流式响应、错误档案及订单模式拒绝实际联通', async () => {
  const f = await arrivalAssistantFixture(),
    auth = new AuthManager(':memory:'),
    server = createApp(f.store, {
      auth,
      aiSettings: f.settings,
      imports: f.manager,
      receiptAi: f.ai,
    }).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + (server.address() as any).port;
  try {
    const url = base + '/api/ai/imports/' + f.workspace.id + '/arrival/assistant';
    assert.equal((await fetch(url)).status, 403);
    const setup = await fetch(base + '/api/auth/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-ERP-Auth-Token': auth.csrf },
      body: JSON.stringify({ name: '虚构到货助手验收', password: 'fictional-arrival-chat-123' }),
    });
    const headers = {
      Cookie: setup.headers.get('set-cookie')!.split(';')[0],
      'Content-Type': 'application/json',
      'X-ERP-AI-Token': f.manager.csrfToken,
    };
    const current = await fetch(url, { headers }).then((r) => r.json());
    const body = {
      expectedRevision: current.workspace.revision,
      requestId: randomUUID(),
      stream: true,
      message: '数量改成300',
      profile: f.settings.view().active,
    };
    assert.equal(
      (
        await fetch(url + '/chat', {
          method: 'POST',
          headers: { ...headers, 'X-ERP-AI-Token': '' },
          body: JSON.stringify(body),
        })
      ).status,
      403,
    );
    f.replies.push(reply([op('quantity', '300')]));
    const response = await fetch(url + '/chat', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const wire = await response.text();
    assert(wire.includes('event: result'));
    assert(wire.includes('300'));
    assert(!wire.includes('sk-fictional'));
    const view = await fetch(url, { headers }).then((r) => r.json());
    f.replies.push(
      reply([{ op: 'set-line', line: 100, field: 'quantity', value: '200', reason: '无效行' }]),
    );
    const failure = await fetch(url + '/chat', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        ...body,
        expectedRevision: view.workspace.revision,
        requestId: randomUUID(),
      }),
    }).then((r) => r.text());
    assert(failure.includes('event: error'));
    assert(failure.includes('failureId'));
    const currentW = f.manager.get(f.workspace.id);
    f.manager.setMode(currentW.id, { expectedRevision: currentW.revision, mode: 'order' });
    assert.equal((await fetch(url, { headers })).status, 409);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    auth.close();
    f.close();
  }
});
