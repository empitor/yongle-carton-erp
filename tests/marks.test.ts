import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/db.js';
import { createApp } from '../server/app.js';
import { AuthManager } from '../server/auth.js';
import { ImportManager } from '../server/import/manager.js';
import { PromptPresetManager } from '../server/ai/prompt-presets.js';
import { MarkAi, markDefaultPreset } from '../server/marks/mark-ai.js';
import { MarkService } from '../server/marks/service.js';
import { MarkImportService } from '../server/marks/mark-import.js';
import { matchMarkToProducts } from '../shared/mark-matching.js';
import { DatabaseMaintenanceService } from '../server/business/database-maintenance.js';
import { localAdministratorActor } from '../server/developer-capability.js';
import { AssistantTools } from '../server/assistant/tools.js';
import { productSchema } from '../shared/domain.js';
import { makeSettings } from './assistant-fixture.js';
import { imageFixture } from './import-fixtures.js';
import { markFieldsSchema, markAnalysisSchema } from '../shared/shipping-mark.js';

test('mark fields preserve text and default unknown facts without guessing', () => {
  const fields = markFieldsSchema.parse({ itemCode: ' TEST-001 ', cartonLength: '12.50' });
  assert.equal(fields.itemCode, ' TEST-001 ');
  assert.equal(fields.cartonLength, '12.50');
  assert.equal(fields.productName, null);
  assert.equal(fields.dimensionUnit, null);
  assert.equal(fields.dimensionBasis, 'unknown');
  assert.equal(markFieldsSchema.safeParse({ unexpected: true }).success, false);
});

test('mark analysis accepts multiple pages and enforces the specified item bounds', () => {
  const item = { page: 1, title: null };
  const analysis = markAnalysisSchema.parse({
    marks: [item, { page: 2, title: 'Fictional mark' }],
    warnings: [],
  });
  assert.deepEqual(
    analysis.marks.map((m) => m.page),
    [1, 2],
  );
  for (const marks of [[], Array.from({ length: 101 }, () => item), [{ ...item, page: -1 }]])
    assert.equal(markAnalysisSchema.safeParse({ marks, warnings: [] }).success, false);
});

let analysisOverride: any = null;
const fakeAnalysis = () => ({
  warnings: ['虚构提醒'],
  marks: [
    {
      page: 1,
      title: null,
      itemCode: 'FAKE-1001',
      cartonLength: '94',
      cartonWidth: '36',
      cartonHeight: '19',
      dimensionUnit: 'cm',
      dimensionBasis: 'outer',
    },
    {
      page: 2,
      title: null,
      itemCode: 'FAKE-DUP',
      cartonLength: '80',
      cartonWidth: '35',
      cartonHeight: '23',
      dimensionUnit: 'cm',
      dimensionBasis: 'outer',
    },
    {
      page: 3,
      title: null,
      cartonLength: '48',
      cartonWidth: '42',
      cartonHeight: '40',
      dimensionUnit: 'cm',
      dimensionBasis: 'inner',
      requirements: '不能打钉',
    },
    { page: 4, title: null, itemCode: 'FAKE-NEW' },
    { page: 5, title: null, itemCode: 'FAKE-NEW' },
  ],
});
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'erp-marks-'));
  const store = new Store(join(dir, 'erp.sqlite'));
  let calls = 0;
  const settings = makeSettings(async () => {
    calls++;
    return {
      status: 200,
      body: {
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: JSON.stringify(analysisOverride || fakeAnalysis()) }],
          },
        ],
      },
    };
  });
  const prompts = new PromptPresetManager(':memory:', markDefaultPreset),
    orderPrompts = new PromptPresetManager(':memory:');
  const ai = new MarkAi(store, settings, prompts);
  const manager = new ImportManager({
    directory: join(dir, 'imports'),
    settings,
    promptPresets: orderPrompts,
  });
  const auth = new AuthManager(':memory:');
  const server = createApp(store, {
    auth,
    aiSettings: settings,
    imports: manager,
    markAi: ai,
  }).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + (server.address() as any).port;
  const save = (name: string, customerProductCode: string, l: number, w: number, h: number) =>
    store.saveProduct(
      productSchema.parse({
        name,
        customerProductCode,
        length: l,
        width: w,
        height: h,
        dimensionUnit: 'mm',
      }),
    );
  const one = save('虚构彩箱甲', 'fake-1001', 940, 360, 190);
  const dupA = save('虚构彩箱乙', 'FAKE-DUP', 800, 350, 230);
  const dupB = save('虚构彩箱丙', 'FAKE-DUP', 800, 350, 230);
  const size = save('虚构彩箱丁', 'OTHER', 480, 420, 400);
  const setup = await fetch(base + '/api/auth/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-ERP-Auth-Token': auth.csrf },
    body: JSON.stringify({ name: '虚构唛头验收', password: 'Fictional-marks-pass-123' }),
  });
  const cookie = setup.headers.get('set-cookie')!.split(';')[0];
  const api = (path: string, init: any = {}, token: 'ai' | 'auth' | 'none' = 'ai') =>
    fetch(base + path, {
      ...init,
      headers: {
        Cookie: cookie,
        ...(init.body && typeof init.body === 'string'
          ? { 'Content-Type': 'application/json' }
          : {}),
        ...(token === 'ai' ? { 'X-ERP-AI-Token': manager.csrfToken } : {}),
        ...(token === 'auth' ? { 'X-ERP-Auth-Token': auth.csrf } : {}),
        ...(init.headers || {}),
      },
    });
  const upload = async () => {
    const w = (await manager.upload(imageFixture(), '虚构唛头.png', true)).workspace;
    return manager.setMode(w.id, { expectedRevision: w.revision, mode: 'mark' });
  };
  return {
    store,
    ai,
    manager,
    auth,
    base,
    api,
    upload,
    one,
    dupA,
    dupB,
    size,
    settings,
    calls: () => calls,
    async close() {
      await new Promise((r) => server.close(r));
      manager.close();
      store.close();
      prompts.close();
      orderPrompts.close();
      settings.close();
      auth.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
const recognize = (f: any, id: string) => {
  const active = f.settings.view().active;
  return f.api('/api/ai/imports/' + id + '/marks/recognize', {
    method: 'POST',
    body: JSON.stringify({
      consent: true,
      stream: false,
      profile: {
        id: active.id,
        endpoint: active.endpoint,
        model: active.model,
        apiStyle: active.apiStyle,
      },
    }),
  });
};

test('唛头识别到挂上产品：唯一对应预选，歧义待确认，待确认不能存，重复提交不多存', async () => {
  const f = await fixture();
  try {
    const w = await f.upload();
    assert.equal((await fetch(f.base + '/api/ai/imports/' + w.id + '/marks')).status, 401);
    assert.equal((await recognize(f, w.id)).status, 200);
    assert.equal(f.calls(), 1);
    let state = await (await f.api('/api/ai/imports/' + w.id + '/marks')).json();
    const by = (page: number) => state.review.items.find((i: any) => i.page === page);
    assert.equal(state.review.items.length, 5);
    assert.deepEqual(by(1).choice, { mode: 'existing', id: f.one.id });
    assert.equal(by(2).choice.mode, 'pending');
    assert.equal(by(3).choice.mode, 'existing', '只有一个产品尺寸相同，自动对应');
    assert.match(state.candidates[by(3).key].map((c: any) => c.reasons.join()).join(), /内径/);
    assert.equal(by(3).fields.requirements, '不能打钉');
    const status = await (await f.api('/api/ai/imports')).json();
    const row = status.workspaces.find((x: any) => x.id === w.id);
    assert.equal(row.markStatus, 'recognized');
    assert.equal(row.markCount, 5);
    let current = f.manager.get(w.id);
    const blocked = await f.api('/api/ai/imports/' + w.id + '/marks/commit', {
      method: 'POST',
      body: JSON.stringify({ expectedRevision: current.revision, requestId: randomUUID() }),
    });
    assert.equal(blocked.status, 400);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM product_marks').get()!.n, 0);
    const items = state.review.items.map((i: any) =>
      i.page === 2
        ? { ...i, choice: { mode: 'existing', id: f.dupB.id } }
        : i.page === 3
          ? { ...i, skip: true }
          : i.page >= 4
            ? { ...i, choice: { mode: 'new', name: 'FAKE-NEW', customerProductCode: 'FAKE-NEW' } }
            : i,
    );
    const saved = await f.api('/api/ai/imports/' + w.id + '/marks', {
      method: 'PUT',
      body: JSON.stringify({ expectedRevision: current.revision, items }),
    });
    assert.equal(saved.status, 200);
    current = f.manager.get(w.id);
    const requestId = randomUUID();
    const commit = () =>
      f.api('/api/ai/imports/' + w.id + '/marks/commit', {
        method: 'POST',
        body: JSON.stringify({ expectedRevision: current.revision, requestId }),
      });
    const first = await commit();
    assert.equal(first.status, 200);
    const results = await first.json();
    assert.equal(results.results.length, 4);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM product_marks').get()!.n, 4);
    // 整份文件只存一份；同料号“新建”只建一个产品
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM mark_files').get()!.n, 1);
    assert.equal(f.store.products().filter((p: any) => p.name === 'FAKE-NEW').length, 1);
    const again = await commit();
    assert.deepEqual((await again.json()).results, results.results);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM product_marks').get()!.n, 4);
    assert.equal((await recognize(f, w.id)).status, 409);
    assert.equal(f.calls(), 1);
    // 唛头只是资料：不产生订单和库存
    assert.equal(f.store.orders(true).length, 0);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM stock_movements').get()!.n, 0);
    const related = await (await f.api('/api/products/' + f.one.id + '/marks', {}, 'none')).json();
    assert.equal(related[0].page, 1);
    assert.equal(related[0].fields.itemCode, 'FAKE-1001');
    state = await (await f.api('/api/ai/imports/' + w.id + '/marks')).json();
    assert.ok(state.review.committed);
  } finally {
    await f.close();
  }
});

test('手动上传和文件接口：要 CSRF，脚本类文件不内联，版本冲突被拒，移除后清掉没人用的文件', async () => {
  const f = await fixture();
  try {
    const url = '/api/products/' + f.one.id + '/marks';
    assert.equal((await fetch(f.base + url)).status, 401);
    const send = (name: string, type: string, token: 'auth' | 'none' = 'auth') =>
      f.api(
        url + '/upload?name=' + encodeURIComponent(name),
        {
          method: 'POST',
          body: new TextEncoder().encode(name),
          headers: { 'Content-Type': type },
        },
        token,
      );
    assert.equal((await send('虚构.pdf', 'application/pdf', 'none')).status, 403);
    const pdf = await (await send('虚构.pdf', 'application/pdf')).json();
    const again = await (await send('虚构.pdf', 'application/pdf')).json();
    assert.equal(again.id, pdf.id);
    const file = await f.api('/api/marks/' + pdf.id + '/file', {}, 'none');
    assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
    assert.match(file.headers.get('content-disposition')!, /^inline/);
    const svg = await (await send('虚构.svg', 'image/svg+xml')).json();
    const danger = await f.api('/api/marks/' + svg.id + '/file', {}, 'none');
    assert.match(danger.headers.get('content-disposition')!, /^attachment/);
    const stale = await f.api(
      '/api/marks/' + pdf.id,
      {
        method: 'PUT',
        body: JSON.stringify({ title: '新', fields: pdf.fields, expectedVersion: pdf.version + 1 }),
      },
      'auth',
    );
    assert.equal(stale.status, 409);
    const updated = await f.api(
      '/api/marks/' + pdf.id,
      {
        method: 'PUT',
        body: JSON.stringify({ title: '新', fields: pdf.fields, expectedVersion: pdf.version }),
      },
      'auth',
    );
    assert.equal((await updated.json()).title, '新');
    const removed = await f.api(
      '/api/marks/' + svg.id,
      { method: 'DELETE', body: JSON.stringify({ expectedVersion: svg.version }) },
      'auth',
    );
    assert.equal(removed.status, 200);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM mark_files').get()!.n, 1);
  } finally {
    await f.close();
  }
});

test('唛头模式不能走订单识别和正式导入；物理删除产品连带清掉唛头；助手只能读', async () => {
  const f = await fixture();
  try {
    const who: any = localAdministratorActor({
      id: 'a',
      name: '虚构管理员',
      role: 'super_admin',
      permissions: ['business:edit'],
      superAdminMode: true,
      superAdminUntil: Date.now() + 60000,
    } as any);
    const w = await f.upload();
    await assert.rejects(
      f.manager.analyze(w.id, { expectedRevision: w.revision, stream: false }),
      /不是|唛头|模式/,
    );
    const marks = new MarkService(f.store);
    const mark = marks.add(
      {
        productId: f.size.id,
        bytes: new Uint8Array([9, 9]),
        name: '虚构.png',
        mime: 'image/png',
        fields: {},
        sourceKind: 'manual',
      },
      who,
    );
    const tools = new AssistantTools(f.store);
    assert.equal(tools.read('marks.list', { productId: f.size.id }, who)[0].id, mark.id);
    const service = new DatabaseMaintenanceService(f.store);
    const selection = {
      module: 'products',
      items: [{ id: f.size.id, version: f.store.product(f.size.id)!.version }],
    };
    const plan = service.preview(selection as any, who);
    service.delete(
      { ...selection, requestId: randomUUID(), deletionDigest: plan.digest } as any,
      who,
      's',
    );
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM product_marks').get()!.n, 0);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM mark_files').get()!.n, 0);
  } finally {
    await f.close();
  }
});

test('唛头自动对应：料号优先，其次名称，再次尺寸；同一档多个就不选', () => {
  const box = (id: number, extra: any = {}) => ({ id, name: '虚构箱' + id, length: 80, width: 60, height: 40, dimensionUnit: 'cm', ...extra });
  const top = (fields: any, products: any[]) => matchMarkToProducts(fields, products).filter((c) => c.recommended).map((c) => c.id);
  const size = { cartonLength: '80', cartonWidth: '60', cartonHeight: '40', dimensionUnit: 'cm' };
  assert.deepEqual(top(size, [box(1)]), [1], '尺寸唯一');
  assert.deepEqual(top(size, [box(1), box(2)]), [], '两款尺寸相同不选');
  assert.deepEqual(top({ ...size, productName: '虚构箱2' }, [box(1), box(2)]), [2], '名称分得开');
  assert.deepEqual(top({ ...size, itemCode: 'A-1' }, [box(1, { customerProductCode: 'A-1' }), box(2)]), [1], '料号优先');
  assert.deepEqual(top({ itemCode: 'A-1' }, [box(1, { markCodes: ['A-1'] }), box(2)]), [1], '以前挂过的料号');
  assert.deepEqual(top({ ...size, productName: '虚构箱1', cartonHeight: '41' }, [box(1)]), [], '名称对但尺寸冲突不选');
  assert.deepEqual(top(size, [box(1, { dimensionUnit: null })]), [1], '产品没写单位但数字一样');
  assert.deepEqual(top({ ...size, dimensionUnit: 'mm' }, [box(1)]), [], '单位都写了又不同不算');
  assert.deepEqual(top({ productName: '英文名' }, [box(1)]), [], '什么都对不上');
});

test('全部对应上就自动挂到产品，不用再点；对不上的等人选', async () => {
  const f = await fixture();
  try {
    const w = await f.upload();
    assert.equal((await recognize(f, w.id)).status, 200);
    const marks = new MarkImportService(f.manager, f.ai);
    assert.equal(f.manager.markReview(w.id)!.committed, null, '这份有对不上的款，等人选');
    assert.ok(marks.summary(w.id).pending.length > 0);
  } finally {
    await f.close();
  }
  // 模型这次只认出能唯一对应的一款：不用点就挂上
  analysisOverride = { warnings: [], marks: [fakeAnalysis().marks[0]] };
  const g = await fixture();
  try {
    const w = await g.upload();
    assert.equal((await recognize(g, w.id)).status, 200);
    const marks = new MarkImportService(g.manager, g.ai);
    const summary = marks.summary(w.id);
    assert.equal(summary.attached.length, 1);
    assert.equal(summary.attached[0].productId, g.one.id);
    assert.equal(summary.pending.length, 0);
    const related = await (await g.api('/api/products/' + g.one.id + '/marks', {}, 'none')).json();
    assert.equal(related.length, 1);
    assert.equal(g.store.orders(true).length, 0);
  } finally {
    analysisOverride = null;
    await g.close();
  }
});
