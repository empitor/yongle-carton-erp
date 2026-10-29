import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import ExcelJS from 'exceljs';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { uiCapabilities } from '../shared/ui-capabilities.js';
import { erpPageIds } from '../shared/assistant-navigation.js';
import { userError } from '../shared/user-errors.js';
import { Store } from '../server/db.js';
import { OperationsService } from '../server/operations/service.js';
import { FlowService } from '../server/flow/service.js';
import { ManualProductionCompletion } from '../server/flow/production-completion.js';
import { ProductionCompletion } from '../server/assistant/production-completion.js';
import { productSchema, today } from '../shared/domain.js';
import { actor } from './assistant-fixture.js';
import { toolCatalog, AssistantTools } from '../server/assistant/tools.js';
import { DocumentTemplateSettings } from '../server/documents/settings.js';
import { templateHeaderText } from '../shared/document-templates.js';
import { BusinessDocuments } from '../server/documents/service.js';
import { BusinessDocumentButton } from '../src/BusinessExport.js';
import { executeDevelopmentReset } from '../server/business/reset-execution.js';
import { DevelopmentResetService } from '../server/business/development-reset.js';
import { localAdministratorActor } from '../server/developer-capability.js';
import { AuthManager } from '../server/auth.js';
import { createApp } from '../server/app.js';
function fixture(store = new Store(':memory:')) {
  const ops = new OperationsService(store),
    flow = new FlowService(store),
    completion = new ManualProductionCompletion(store);
  const raw = ops.saveItem({ name: '虚构共享纸板', kind: 'raw', unit: '张' }, actor);
  ops.move(
    raw.id,
    {
      expectedVersion: raw.version,
      requestId: randomUUID(),
      action: 'in',
      quantity: '100',
      date: today(),
      notes: '虚构期初',
      acknowledged: true,
    },
    actor,
  );
  const products = ['虚构纸箱甲', '虚构纸箱乙'].map((name) =>
    store.saveProduct(
      productSchema.parse({
        name,
        length: 300,
        width: 200,
        height: 150,
        dimensionUnit: 'mm',
        material: 'K=A',
        flute: 'B',
      }),
    ),
  );
  const tasks = products.map((p, i) =>
    flow.save(
      'task',
      {
        productId: p.id,
        quantity: String(i ? 2 : 3),
        unit: '只',
        date: today(),
        plannedDate: today(),
        orderIds: [],
      },
      actor,
    ),
  );
  const input = () => ({
    requestId: randomUUID(),
    taskIds: tasks.map((t) => t.id),
    date: today(),
    operator: '虚构生产人员',
    allocation: 'shared-proportional',
    materials: [{ stockId: raw.id, unit: '张', issued: '5', returned: '0' }],
    quantities: tasks.map((t) => ({ taskId: t.id, goodQuantity: t.quantity, scrapQuantity: '0' })),
    createMissingFinished: true,
  });
  const supplier = ops.saveSupplier({ name: '虚构模板供应商' }, actor),
    purchase = ops.savePurchase(
      {
        supplierId: supplier.id,
        orderDate: today(),
        status: '待订货',
        lines: [{ ...raw, stockItemId: raw.id, quantity: '10', unitPrice: '1.2345' }],
      },
      actor,
    );
  return { store, ops, flow, completion, raw, tasks, input, purchase };
}
test('当前注册工具逐项具备人工业务入口或明确技术分类，导航均指向真实页面', () => {
  const tools = toolCatalog.map((t) => t.name);
  for (const name of tools) {
    const coverage = uiCapabilities.filter((c) => (c.tools as readonly string[]).includes(name));
    assert.equal(coverage.length, 1, name + '的覆盖分类必须明确且唯一');
    assert.ok(coverage[0].entry);
    assert.ok(coverage[0].api.length);
  }
  for (const capability of uiCapabilities)
    assert.ok((erpPageIds as string[]).includes(capability.page.split('?')[0].slice(1)));
  assert.match(
    renderToStaticMarkup(
      createElement(BusinessDocumentButton, {
        kind: 'purchase',
        id: 1,
        version: 1,
        status: '待订货',
      }),
    ),
    /订货单 \/ 导出/,
  );
  assert.match(
    renderToStaticMarkup(
      createElement(BusinessDocumentButton, {
        kind: 'delivery',
        id: 1,
        version: 1,
        status: 'confirmed',
      }),
    ),
    /送货单 \/ 导出/,
  );
});
test('可维护模板与业务映射分离、版本冲突及权限保护、人工与AI读取相同模板', async () => {
  assert.equal(templateHeaderText('111111'), 'FFFFFF');
  assert.equal(templateHeaderText('E8EEF0'), '111111');
  const f = fixture();
  try {
    const settings = new DocumentTemplateSettings(f.store),
      before = settings.get();
    const templates = before.templates.map((t) => ({
      ...t,
      companyName: '虚构模板工厂',
      title: t.kind === 'purchase' ? '材料采购订货单' : '客户送货凭证',
      footerNotes: '虚构备注：请按实收签认',
      color: 'CCDDEE',
      fontSize: 11,
      defaultFormat: 'xlsx' as const,
    }));
    assert.throws(
      () => settings.save({ expectedRevision: 0, templates }, { ...actor, permissions: [] }),
      /权限/,
    );
    settings.save({ expectedRevision: 0, templates }, actor);
    assert.throws(
      () => settings.save({ expectedRevision: 0, templates }, actor),
      /模板已在其他页面修改/,
    );
    const tools = new AssistantTools(f.store),
      fromAI = tools.read('documents.templates', {}, actor);
    assert.deepEqual(fromAI, settings.get());
    const docs = new BusinessDocuments(f.store),
      form = docs.form('purchase', f.purchase.id).form;
    assert.equal(form.companyName, '虚构模板工厂');
    assert.equal(form.rows[0][4], '10');
    assert.match(form.notes, /按实收签认/);
    const file = await docs.generate(
      {
        kind: 'purchase',
        id: f.purchase.id,
        format: 'xlsx',
        templateId: 'purchase-default',
        expectedVersion: f.purchase.version,
        requestId: randomUUID(),
      },
      actor,
    );
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(docs.file(file.exportId, actor).buffer as any);
    assert.match(String(book.worksheets[0].getCell('A1').value), /虚构模板工厂 材料采购订货单/);
    assert.equal(file.templateRevision, 1);
    assert.equal(f.store.purchases()[0].businessStatus, '待订货');
    await assert.rejects(
      () =>
        docs.generate(
          {
            kind: 'purchase',
            id: f.purchase.id,
            format: 'docx',
            templateId: 'delivery-default',
            expectedVersion: f.purchase.version,
            requestId: randomUUID(),
          },
          actor,
        ),
      /模板与当前单据类型不一致/,
    );
  } finally {
    f.store.close();
  }
});
test('模板重开后持久保留，业务初始化保留模板、普通账号不能初始化', () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-ui-template-')),
    path = join(dir, 'fictional.sqlite');
  let f = fixture(new Store(path));
  try {
    const s = new DocumentTemplateSettings(f.store),
      v = s.get();
    s.save(
      {
        expectedRevision: 0,
        templates: v.templates.map((t) => ({ ...t, companyName: '虚构持久模板工厂' })),
      },
      actor,
    );
    f.store.close();
    const store = new Store(path);
    try {
      assert.equal(
        new DocumentTemplateSettings(store).get().templates[0].companyName,
        '虚构持久模板工厂',
      );
      assert.throws(
        () => executeDevelopmentReset(store, undefined, { scope: 'business' }, actor),
        /本机/,
      );
      assert.ok(store.purchases().length);
      const owner = localAdministratorActor({ ...actor, role: 'super_admin' });
      assert.throws(
        () => executeDevelopmentReset(store, undefined, { scope: 'all' }, owner),
        /未执行清理/,
      );
      assert.ok(store.purchases().length);
      const counts = new DevelopmentResetService(store).preview('business', owner).tables;
      assert.equal((counts as Record<string, number>).operation_requests, 1); // 仅库存期初请求，模板不会被清理
      const cleared = executeDevelopmentReset(store, undefined, { scope: 'business' }, owner);
      assert.equal(
        cleared.count,
        Object.values(counts).reduce((a, b) => a + b, 0),
      );
      assert.equal(store.purchases().length, 0);
      assert.equal(
        new DocumentTemplateSettings(store).get().templates[0].companyName,
        '虚构持久模板工厂',
      );
      store.saveCustomer({
        name: '虚构部分初始化',
        contact: '',
        phone: '',
        address: '',
        notes: '',
      });
      assert.throws(
        () =>
          executeDevelopmentReset(
            store,
            {
              deleteAllWorkspaces: () => ({
                count: 1,
                ids: ['fictional-ok'],
                failed: ['fictional-failed'],
              }),
            } as any,
            { scope: 'all' },
            owner,
          ),
        /业务数据已清空；已清理1份AI工作区，另有1份失败/,
      );
      assert.equal(store.customers().length, 0);
      assert.ok(
        store.db
          .prepare("SELECT 1 FROM business_audit WHERE action='development-reset-partial'")
          .get(),
      );
    } finally {
      store.close();
    }
  } finally {
    try {
      f.store.close();
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});
test('人工整批完工预览回滚、按共享整张分配、正式结果与AI原服务相同且幂等', () => {
  const a = fixture(),
    b = fixture();
  try {
    const input = a.input(),
      before = a.ops.repo.balance(a.raw.id),
      preview = a.completion.preview(input, actor, 'session');
    assert.equal(preview.verified, false);
    assert.equal(a.ops.repo.balance(a.raw.id), before);
    assert.equal(a.flow.list('production').length, 0);
    assert.equal(a.flow.list('task')[0].status, 'draft');
    assert.equal(a.ops.repo.items().filter((s) => s.kind === 'finished').length, 0);
    const result = a.completion.execute(
        { input, previewDigest: preview.previewDigest },
        actor,
        'session',
      ),
      manual = result.results.map((r: any) => ({
        good: r.goodQuantity,
        scrap: r.scrapQuantity,
        materials: r.materials.map((m: any) => ({ issued: m.issued, returned: m.returned })),
      }));
    const other = new ProductionCompletion(b.store).execute(b.input(), actor, 'session');
    assert.deepEqual(
      manual,
      other.results.map((r: any) => ({
        good: r.goodQuantity,
        scrap: r.scrapQuantity,
        materials: r.materials.map((m: any) => ({ issued: m.issued, returned: m.returned })),
      })),
    );
    assert.equal(a.ops.repo.balance(a.raw.id), 95000);
    assert.equal(a.flow.list('production').length, 2);
    a.completion.execute({ input, previewDigest: preview.previewDigest }, actor, 'session');
    assert.equal(a.flow.list('production').length, 2);
    assert.equal(a.ops.repo.balance(a.raw.id), 95000);
  } finally {
    a.store.close();
    b.store.close();
  }
});
test('整批完工版本变化、错误领料分配、缺少真实产量及库存不足不产生半单', () => {
  const f = fixture();
  try {
    const input = f.input(),
      preview = f.completion.preview(input, actor, 's');
    f.flow.schedule(
      f.tasks[0].id,
      { plannedDate: '2026-11-03', expectedVersion: f.tasks[0].version, requestId: randomUUID() },
      actor,
    );
    assert.throws(
      () => f.completion.execute({ input, previewDigest: preview.previewDigest }, actor, 's'),
      /已更新/,
    );
    assert.throws(
      () =>
        f.completion.preview(
          {
            ...f.input(),
            materials: [{ stockId: f.raw.id, unit: '张', issued: '500', returned: '0' }],
          },
          actor,
          's',
        ),
      /库存不足/,
    );
    assert.equal(f.flow.list('production').length, 0);
    assert.equal(f.ops.repo.balance(f.raw.id), 100000);
    assert.throws(
      () =>
        f.completion.preview({ ...f.input(), quantities: undefined, goodRatePct: 90 }, actor, 's'),
      /须提供实际良品/,
    );
    assert.throws(
      () => f.completion.preview(f.input(), { ...actor, permissions: [] }, 's'),
      /权限/,
    );
  } finally {
    f.store.close();
  }
});
test('面向员工的错误提示包含明细序号与中文字段，保留业务原始错误', () => {
  assert.equal(userError('lines.1.quantity: 数量使用非负数字'), '第2项 数量: 数量使用非负数字');
  assert.match(
    userError('customerId: Invalid input: expected number, received undefined'),
    /客户: 请填写有效数值/,
  );
  assert.equal(
    userError('纸板A库存不足：现有1000张，本次需扣减5000张。'),
    '纸板A库存不足：现有1000张，本次需扣减5000张。',
  );
});
test('人工模板、生产批量入口使用真实HTTP登录及CSRF，预览不会提前扣库存', async () => {
  const f = fixture(),
    auth = new AuthManager(':memory:', Date.now, { localAdministration: true }),
    server = createApp(f.store, { auth }).listen(0, '127.0.0.1');
  try {
    await new Promise<void>((r) => server.on('listening', r));
    const base = 'http://127.0.0.1:' + (server.address() as any).port,
      setup = await fetch(base + '/api/auth/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-erp-auth-token': auth.csrf },
        body: JSON.stringify({
          name: '虚构界面验收管理员',
          password: 'fictional-ui-audit-pass-123',
        }),
      }),
      cookie = setup.headers.get('set-cookie')!.split(';')[0],
      headers = { cookie, 'Content-Type': 'application/json', 'x-erp-auth-token': auth.csrf };
    const customer = f.store.saveCustomer({
      name: '虚构读回客户',
      contact: '',
      phone: '',
      address: '',
      notes: '',
    });
    for (const [path, id] of [
      ['customers', customer.id],
      ['products', f.store.products()[0].id],
    ] as const) {
      const read = await fetch(base + '/api/' + path + '/' + id, { headers: { cookie } });
      assert.equal(read.status, 200);
      assert.equal(((await read.json()) as any).id, id);
    }
    const state = new DocumentTemplateSettings(f.store).get();
    let r = await fetch(base + '/api/documents/templates', {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 0, templates: state.templates }),
    });
    assert.equal(r.status, 403);
    r = await fetch(base + '/api/documents/templates', {
      method: 'POST',
      headers,
      body: JSON.stringify({ expectedRevision: 0, templates: state.templates }),
    });
    assert.equal(r.status, 200);
    const input = f.input();
    r = await fetch(base + '/api/flow/production-completion/preview', {
      method: 'POST',
      headers,
      body: JSON.stringify(input),
    });
    assert.equal(r.status, 200);
    const preview = (await r.json()) as any;
    assert.equal(f.ops.repo.balance(f.raw.id), 100000);
    r = await fetch(base + '/api/flow/production-completion/execute', {
      method: 'POST',
      headers,
      body: JSON.stringify({ input, previewDigest: preview.previewDigest }),
    });
    assert.equal(r.status, 200);
    assert.equal(f.ops.repo.balance(f.raw.id), 95000);
    r = await fetch(base + '/api/management/reset-preview?scope=business', { headers: { cookie } });
    assert.equal(r.status, 200);
    assert.ok(((await r.json()) as any).tables.products > 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    auth.close();
    f.store.close();
  }
});
