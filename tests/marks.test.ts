// 产品的唛头：像产品的备注一样挂在产品上（看、传、删、写一句说明）。唛头不识别。
import { sales, MarkService } from '../server/sales/index.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { Store } from '../server/core/db.js';
import { count } from '../server/core/index.js';
import { startHttp } from './http-fixture.js';
import { fixtureOwner } from './flow-fixture.js';
import { DatabaseMaintenanceService } from '../server/lifecycle/index.js';
import { productSchema } from '../shared/core/domain.js';
import { superActor as fixtureSuperActor } from './actor-fixture.js';

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'erp-marks-'));
  const store = new Store(join(dir, 'erp.sqlite'));
  const http = await startHttp(store, { admin: false }),
    base = http.origin;
  const save = (name: string, customerProductCode: string, l: number, w: number, h: number) =>
    sales(store).createProduct(
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
  const cookie = await http.setup({ name: '虚构唛头验收', password: 'Fictional-marks-pass-123' });
  const api = (path: string, init: RequestInit = {}, token: 'auth' | 'none' = 'auth') => {
    const headers = new Headers({
      Cookie: cookie,
      ...(init.body && typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
      ...(token === 'auth' ? { 'X-ERP-Auth-Token': http.auth.csrf } : {}),
    });
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    return fetch(base + path, { ...init, headers });
  };
  return {
    store,
    base,
    api,
    one,
    async close() {
      await http.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const who = fixtureOwner;
const uploadedMark = z.looseObject({ id: z.number(), version: z.number() });

function disposition(response: Response) {
  const value = response.headers.get('content-disposition');
  assert.ok(value);
  return value;
}

test('手动上传和文件接口：要 CSRF，脚本类文件不内联；编辑说明只收标题和版本，版本冲突被拒；移除后清掉没人用的文件', async () => {
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
    const pdf = uploadedMark.parse(await (await send('虚构.pdf', 'application/pdf')).json());
    const again = uploadedMark.parse(await (await send('虚构.pdf', 'application/pdf')).json());
    assert.equal(again.id, pdf.id);
    const file = await f.api('/api/marks/' + pdf.id + '/file', {}, 'none');
    assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
    assert.match(disposition(file), /^inline/);
    const svg = uploadedMark.parse(await (await send('虚构.svg', 'image/svg+xml')).json());
    const danger = await f.api('/api/marks/' + svg.id + '/file', {}, 'none');
    assert.match(disposition(danger), /^attachment/);
    const stale = await f.api(
      '/api/marks/' + pdf.id,
      {
        method: 'PUT',
        body: JSON.stringify({ title: '新', expectedVersion: pdf.version + 1 }),
      },
      'auth',
    );
    assert.equal(stale.status, 409);
    const extra = await f.api('/api/marks/' + pdf.id, { method: 'PUT', body: JSON.stringify({ title: '新', itemCode: 'X', expectedVersion: pdf.version }) });
    assert.equal(extra.status, 400, '唛头不识别，没有别的栏目');
    const updated = await f.api(
      '/api/marks/' + pdf.id,
      {
        method: 'PUT',
        body: JSON.stringify({ title: '新', expectedVersion: pdf.version }),
      },
      'auth',
    );
    assert.equal(z.looseObject({ title: z.string() }).parse(await updated.json()).title, '新');
    const removed = await f.api(
      '/api/marks/' + svg.id,
      { method: 'DELETE', body: JSON.stringify({ expectedVersion: svg.version }) },
      'auth',
    );
    assert.equal(removed.status, 200);
    assert.equal(count(f.store.db, 'SELECT COUNT(*) FROM mark_files'), 1);
  } finally {
    await f.close();
  }
});

test('不在本机的超级管理员模式删带唛头的产品，唛头和原文件一起清掉', () => {
  const store = new Store(':memory:');
  try {
    const actor = who();
    const superActor = fixtureSuperActor();
    const product = sales(store).createProduct(productSchema.parse({ name: '虚构带唛头产品' }));
    new MarkService(store).add(
      {
        productId: product.id,
        bytes: new Uint8Array([9, 9]),
        name: '虚构.png',
        mime: 'image/png',
        sourceKind: 'manual',
      },
      actor,
    );
    const engine = new DatabaseMaintenanceService(store),
      selection = { module: 'products', items: [{ id: product.id, version: product.version }] },
      { digest } = engine.preview(selection, superActor);
    engine.delete({ ...selection, requestId: randomUUID(), deletionDigest: digest }, superActor, 's');
    assert.equal(sales(store).product(product.id, true), undefined);
    assert.equal(count(store.db, 'SELECT count(*) FROM product_marks'), 0);
    assert.equal(count(store.db, 'SELECT count(*) FROM mark_files'), 0);
  } finally {
    store.close();
  }
});

test('从产品上移除唛头前留快照', () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-review-'));
  const store = new Store(join(dir, 'erp.sqlite'));
  try {
    const actor = who();
    const product = sales(store).createProduct(productSchema.parse({ name: '虚构带唛头产品' }));
    const marks = new MarkService(store);
    const mark = marks.add(
      {
        productId: product.id,
        bytes: new Uint8Array([9, 9]),
        name: '虚构.png',
        mime: 'image/png',
        sourceKind: 'manual',
      },
      actor,
    );
    marks.remove(mark.id, { expectedVersion: mark.version }, actor);
    const snapshots = readdirSync(dir, { recursive: true }).filter((f) =>
      /erp-.*\.sqlite$/.test(String(f)),
    );
    assert.equal(snapshots.length, 1);
    assert.ok(existsSync(join(dir, String(snapshots[0]))));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
