// “这个产品能不能给这家客户用”只在 shared/core/product-details.ts 定义一处：
// 订单保存、导入预览、标准订单、助手导入匹配四个服务端入口报同一句话；“已经下过单不能改所属客户”服务端和数据管理同一句；
// 这两句话的原文在 server/ shared/ src/ 里只出现在那一份。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sales } from '../../server/sales/index.js';
import { standardOrderDraft } from '../../server/import/standard-order.js';
import { PRODUCT_CUSTOMER_LOCKED, customerSchema, orderSchema, productCustomerIssue, productSchema } from '../../shared/core/index.js';
import { emptyImportMapping } from '../../shared/import/index.js';
import { lockedReason } from '../../src/admin/field-rules.js';
import { createOrderWorkflowFixture, importer } from '../support/assistant-workflow-fixture.js';
import { imageFixture } from '../support/import-fixtures.js';

const messageIs = (expected: string) => (e: unknown) => e instanceof Error && e.message === expected;

test('产品属别家客户：订单、导入预览、标准订单、助手导入匹配四个入口报同一句话', async () => {
  const f = createOrderWorkflowFixture();
  try {
    const buyer = sales(f.store).customers()[0];
    const other = sales(f.store).createCustomer(customerSchema.parse({ name: '虚构别家客户' }));
    const foreign = sales(f.store).createProduct(productSchema.parse({ name: '虚构别家专用箱', customerId: other.id }));
    const expected = productCustomerIssue(foreign, buyer);
    assert.equal(expected, '这个产品是 虚构别家客户 的，要给 聊天验收客户 用请新建一份');

    const order = orderSchema.parse({
      customerId: buyer.id,
      orderDate: '2026-11-01',
      deliveryDate: '2026-11-10',
      status: '已确认',
      lines: [{ productId: foreign.id, quantity: 100, unitPriceCents: 200, unit: '只' }],
    });
    assert.throws(() => sales(f.store).saveOrder(order), messageIs(expected), '订单保存');

    let w = (await f.imports.upload(imageFixture(), '虚构别家产品订单.png')).workspace;
    w = await f.imports.analyze(w.id, { expectedRevision: w.revision }, undefined, importer);
    assert.ok(w.draft, '工作区有识别内容');
    const mapping = emptyImportMapping(w.draft);
    mapping.customer = { mode: 'existing', id: buyer.id, version: buyer.version };
    for (const l of w.draft.lines) mapping.products[l.id] = { mode: 'existing', id: foreign.id, version: foreign.version };
    w = f.imports.mapping(w.id, { expectedRevision: w.revision, mapping }, importer);
    assert.deepEqual(standardOrderDraft(f.store, w)?.issues, [expected], '标准订单');
    await assert.rejects(f.execution.preview(w.id, { expectedRevision: w.revision }, importer), messageIs(expected), '导入预览');

    const wf = f.manager.orderWorkflow;
    assert.ok(wf, '订单导入接上了');
    const ctx = f.ctx();
    await wf.call('order_import.attach', { workspaceId: w.id }, ctx);
    await assert.rejects(wf.call('order_import.match', { line: 1, productId: foreign.id }, ctx), messageIs(expected), '助手导入匹配');
  } finally {
    f.close();
  }
});

test('下过单的产品改所属客户：服务端和数据管理同一句话', () => {
  const f = createOrderWorkflowFixture();
  try {
    const buyer = sales(f.store).customers()[0];
    const other = sales(f.store).createCustomer(customerSchema.parse({ name: '虚构另一家' }));
    const p = sales(f.store).createProduct(productSchema.parse({ name: '虚构已下单箱', customerId: buyer.id }));
    sales(f.store).saveOrder(
      orderSchema.parse({
        customerId: buyer.id,
        orderDate: '2026-11-01',
        deliveryDate: '2026-11-10',
        status: '已确认',
        lines: [{ productId: p.id, quantity: 100, unitPriceCents: 200, unit: '只' }],
      }),
    );
    assert.throws(
      () => sales(f.store).updateProduct(productSchema.parse({ ...p, customerId: other.id }), p.id, p.version),
      messageIs(PRODUCT_CUSTOMER_LOCKED),
    );
    const record = { id: p.id, version: p.version, customerId: buyer.id, ordered: true };
    assert.equal(lockedReason('customerId', {}, '', { module: 'products', record, refs: null }), PRODUCT_CUSTOMER_LOCKED);
  } finally {
    f.close();
  }
});

/** server/ shared/ src/ 下的代码文件（相对项目根目录，正斜杠） */
function codeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = dir + '/' + e.name;
    if (e.isDirectory()) return codeFiles(path);
    return /\.tsx?$/.test(e.name) ? [path] : [];
  });
}

test('两句提示的原文只写在 shared/core/product-details.ts', () => {
  // 属别家客户那句的句式、下过单那句的前半、改之前的旧说法
  const phrases = ['的，要给 ', '不能更改所属客户；', '用请复制一份'];
  const found = ['server', 'shared', 'src']
    .flatMap(codeFiles)
    .filter((file) => {
      const text = readFileSync(join(process.cwd(), file), 'utf8');
      return phrases.some((p) => text.includes(p));
    });
  assert.deepEqual(found, ['shared/core/product-details.ts']);
});
