// Manual browser acceptance only: fictional temporary databases and a mock Provider.
import express from 'express';
import { randomUUID, scryptSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { AuthManager } from '../server/auth.js';
import { createApp } from '../server/app.js';
import { customerSchema, productSchema } from '../shared/domain.js';
import { createOrderWorkflowFixture } from './assistant-workflow-fixture.js';
import { imageFixture } from './import-fixtures.js';
import type { DraftOperation } from '../shared/order-draft.js';
process.env.PORT = '3197';
const f = createOrderWorkflowFixture(),
  authPath = join(f.dir, 'matching-users.sqlite'),
  auth = new AuthManager(authPath);
const db = new DatabaseSync(authPath);
db.prepare(
  'INSERT INTO users(id,name,salt,password_hash,permissions,role) VALUES(?,?,?,?,?,?)',
).run(
  randomUUID(),
  '虚构匹配验收',
  'fictional-matching-salt',
  scryptSync('Fictional-Matching-2026', 'fictional-matching-salt', 64).toString('hex'),
  JSON.stringify(['business:edit', 'import:execute']),
  'admin',
);
db.close();
const actor = {
  id: 'fictional-seed',
  name: '虚构初始化',
  permissions: ['business:edit', 'import:execute'],
  role: 'admin' as const,
};
const customer = f.store.saveCustomer(
  customerSchema.parse({
    name: '虚构匹配客户有限公司',
    contact: '测试甲',
    phone: '000-111',
    address: '虚构一号',
  }),
);
const duplicateCustomers = ['000-222', '000-333'].map((phone) =>
  f.store.saveCustomer(
    customerSchema.parse({
      name: '虚构同名客户有限公司',
      contact: phone === '000-222' ? '测试乙' : '测试丙',
      phone,
    }),
  ),
);
f.store.saveCustomer(customerSchema.parse({ name: '虚构相似公司有限公司' }));
const complete = f.store.saveProduct(
  productSchema.parse({
    name: '虚构匹配纸箱',
    length: 300,
    width: 200,
    height: 150,
    dimensionUnit: 'mm',
    material: '牛卡',
    flute: 'B',
    customerProductCode: 'BOX-1',
  }),
);
const incomplete = f.store.saveProduct(
  productSchema.parse({
    name: '虚构缺资料纸箱',
    length: 400,
    width: 300,
    height: 200,
    dimensionUnit: 'mm',
  }),
);
const twins = [1, 2].map(() =>
  f.store.saveProduct(
    productSchema.parse({
      name: '虚构同型纸箱',
      length: 500,
      width: 300,
      height: 200,
      dimensionUnit: 'mm',
      material: '牛卡',
      flute: 'B',
    }),
  ),
);
async function file(label: string, buyer: string, items: (typeof complete)[], unknownUnit = false) {
  let w = (
    await f.imports.upload(Buffer.concat([imageFixture(), Buffer.from(label)]), label + '.png')
  ).workspace;
  const a = f.settings.view().active!;
  w = f.imports.consent(w.id, {
    expectedRevision: w.revision,
    accepted: true,
    presetId: a.id,
    endpoint: a.endpoint,
    model: a.model,
    apiStyle: a.apiStyle,
  });
  w = await f.imports.analyze(w.id, { expectedRevision: w.revision }, undefined, actor);
  const operations: DraftOperation[] = [
    { op: 'set-header', field: 'buyerName', value: buyer, reason: '虚构样例' },
    {
      op: 'set-header',
      field: 'purchaseOrderNumber',
      value: 'FICTION-' + label,
      reason: '独立订单号',
    },
  ];
  w.draft!.lines.forEach((line, i) => {
    const p = items[i];
    for (const [field, value] of Object.entries({
      productName: p.name,
      specification: `${p.length}×${p.width}×${p.height}`,
      length: String(p.length),
      width: String(p.width),
      height: String(p.height),
      dimensionUnit: unknownUnit ? '' : p.dimensionUnit,
      material: p.material,
      flute: p.flute,
      productCode: p.customerProductCode || '',
    }))
      operations.push({
        op: 'set-line',
        lineId: line.id,
        field: field as any,
        value: value || '',
        reason: '虚构样例',
      });
  });
  return f.imports.edit(w.id, { expectedRevision: w.revision, operations }, 'manual', actor);
}
const exact = await file('01-唯一匹配与资料缺失', customer.name, [complete, incomplete]);
const ambiguous = await file('02-同名客户与同型产品', '虚构同名客户有限公司', [twins[0], complete]);
const unknown = await file('03-相似客户与未知单位', '虚构相似公司', [complete, incomplete], true);
const ids = {
  exact: exact.id,
  ambiguous: ambiguous.id,
  unknown: unknown.id,
  customer: customer.id,
  duplicateCustomers: duplicateCustomers.map((c) => c.id),
  complete: complete.id,
  incomplete: incomplete.id,
  twins: twins.map((p) => p.id),
};
const app = express();
app.get('/__fixture/state', (_req, res) =>
  res.json({
    ids,
    recognitionCalls: f.recognitionCalls(),
    customers: f.store.customers().length,
    products: f.store.products().length,
    orders: f.store.orders().length,
    workspaces: [exact, ambiguous, unknown].map((w) => f.imports.get(w.id)),
  }),
);
app.use(
  createApp(f.store, {
    auth,
    assistant: f.manager,
    imports: f.imports,
    aiSettings: f.settings,
    enableReviewedImports: true,
    importArchiveDirectory: join(f.dir, 'archive'),
  }),
);
const server = app.listen(3197, '127.0.0.1', () =>
  console.log('虚构匹配验收 http://127.0.0.1:3197，初始化识别次数=' + f.recognitionCalls()),
);
process.on('SIGINT', () =>
  server.close(() => {
    auth.close();
    f.close();
    process.exit(0);
  }),
);
