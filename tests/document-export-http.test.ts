// 单据导出的接口（server/documents/router.ts）：登录和页面凭证、下载、交付回执、过期 410、预览不留记录、保存模板要页面凭证。内存库、虚构数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { purgeExportFiles } from '../server/documents/export-records.js';
import { actor } from './assistant-fixture.js';
import { startHttp } from './http-fixture.js';
import { setup } from './document-fixture.js';
import { Store } from '../server/core/db.js';
import { count as countRows } from '../server/core/sql.js';
import { DocumentTemplateSettings } from '../server/documents/settings.js';

const allowedOrigin = 'http://127.0.0.1:3001';
/** 导出接口回的文件：下载地址、编号、摘要、大小 */
const exportedFile = z.looseObject({ url: z.string(), exportId: z.string(), sha256: z.string(), size: z.number() });
/** 查导出状态：交付时间（没交付是 null）、文件还在不在 */
const exportStatus = z.looseObject({ deliveredAt: z.string().nullable(), fileExpired: z.boolean() });
/** 出错的回答：错误代码和中文说明 */
const failure = z.looseObject({ code: z.string().optional(), message: z.string() });
/** 这个登录 Cookie 的页面凭证（/api/auth/state） */
async function csrfOf(origin: string, cookie: string) {
  return z.looseObject({ csrf: z.string() }).parse(await (await fetch(origin + '/api/auth/state', { headers: { cookie } })).json()).csrf;
}

test('导出接口要登录和页面凭证；文件完整下载、交了回执才改状态', async () => {
  const f = setup(),
    h = await startHttp(f.store, { admin: false });
  try {
    const origin = h.origin;
    let r = await fetch(origin + '/api/documents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(f.exp('purchase', f.purchase.id)),
    });
    assert.ok(r.status === 401 || r.status === 403);
    const cookie = await h.setup({ name: '虚构导出管理员', password: 'Fictional-export-pass-123' });
    const headers = {
      'Content-Type': 'application/json',
      Origin: allowedOrigin,
      cookie,
      'x-erp-auth-token': await csrfOf(origin, cookie),
    };
    r = await fetch(origin + '/api/documents', {
      method: 'POST',
      headers,
      body: JSON.stringify(f.exp('purchase', f.purchase.id)),
    });
    assert.equal(r.status, 200);
    const file = exportedFile.parse(await r.json());
    r = await fetch(origin + file.url, { method: 'HEAD', headers: { cookie } });
    assert.equal(r.status, 200);
    r = await fetch(origin + '/api/documents/' + file.exportId, { headers: { cookie } });
    assert.equal(exportStatus.parse(await r.json()).deliveredAt, null);
    r = await fetch(origin + '/api/documents/' + file.exportId + '/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ sha256: file.sha256 }),
    });
    assert.equal(r.status, 403);
    r = await fetch(origin + file.url, { headers: { cookie } });
    assert.equal(r.status, 200);
    const bytes = await r.arrayBuffer();
    assert.equal(bytes.byteLength, file.size);
    assert.equal(f.current().businessStatus, '待订货');
    r = await fetch(origin + '/api/documents/' + file.exportId + '/complete', {
      method: 'POST',
      headers,
      body: JSON.stringify({ sha256: file.sha256 }),
    });
    assert.equal(r.status, 200);
    assert.equal(f.current().businessStatus, '已订货');
    r = await fetch(origin + '/api/flow/daily?kind=delivery&date=2026-10-29', {
      headers: { cookie },
    });
    assert.equal(r.status, 200);
    assert.equal(z.looseObject({ summary: z.looseObject({ pending: z.number() }) }).parse(await r.json()).summary.pending, 0);
  } finally {
    h.server.closeAllConnections();
    await h.close();
    f.store.close();
  }
});

test('导出接口：排不下的（Word、Excel 都是）给出具体中文原因，不留导出记录、不改采购单', async () => {
  const f = setup(),
    h = await startHttp(f.store);
  try {
    const { origin, cookie } = h;
    const headers = { 'Content-Type': 'application/json', Origin: allowedOrigin, cookie, 'x-erp-auth-token': await csrfOf(origin, cookie) };
    const longPurchase = f.ops.savePurchase(
      {
        ...f.current(),
        version: f.current().version,
        lines: f
          .current()
          .lines.map((l) => ({
            ...l,
            stockItemId: null,
            specification: '虚构长规格说明'.repeat(280),
          })),
      },
      actor,
      f.purchase.id,
    );
    const exportsBefore = countRows(f.store.db, 'SELECT COUNT(*) n FROM document_exports');
    for (const format of ['docx', 'xlsx']) {
      const r = await fetch(origin + '/api/documents', {
        method: 'POST',
        headers,
        body: JSON.stringify(f.exp('purchase', longPurchase.id, { format })),
      });
      assert.equal(r.status, 400);
      const error = failure.parse(await r.json());
      assert.equal(error.code, 'document_layout_overflow');
      assert.match(error.message, new RegExp(longPurchase.number));
      assert.match(error.message, /第 1 行明细“规格及尺寸”.*缩短内容或换更大的纸张/);
    }
    assert.equal(countRows(f.store.db, 'SELECT COUNT(*) n FROM document_exports'), exportsBefore);
    assert.equal(f.current().version, longPurchase.version);
  } finally {
    h.server.closeAllConnections();
    await h.close();
    f.store.close();
  }
});

test('过期的导出文件经真实下载地址返回 410 和中文说明', async () => {
  const f = setup(),
    h = await startHttp(f.store);
  try {
    const { origin, cookie } = h,
      csrf = await csrfOf(origin, cookie);
    let r = await fetch(origin + '/api/documents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: allowedOrigin, cookie, 'x-erp-auth-token': csrf },
      body: JSON.stringify(f.exp('purchase', f.purchase.id, { markOrdered: false })),
    });
    assert.equal(r.status, 200);
    const file = exportedFile.parse(await r.json());
    assert.equal(purgeExportFiles(f.store, 0, new Date(Date.now() + 1000)), 1);
    r = await fetch(origin + file.url, { headers: { cookie } });
    assert.equal(r.status, 410);
    assert.match(failure.parse(await r.json()).message, /文件已过期.*请重新导出/);
    r = await fetch(origin + '/api/documents/' + file.exportId, { headers: { cookie } });
    assert.equal(r.status, 200);
    const status = exportStatus.parse(await r.json());
    assert.equal(status.deliveredAt, null, '过期的下载不算交付');
    assert.equal(status.fileExpired, true, '查状态能看出文件已过期');
  } finally {
    h.server.closeAllConnections();
    await h.close();
    f.store.close();
  }
});

test('预览 Word 排版经真实地址只回文件内容：不写导出记录和审计、不改状态，要页面凭证', async () => {
  const f = setup(),
    h = await startHttp(f.store);
  try {
    const { origin, cookie } = h,
      csrf = await csrfOf(origin, cookie);
    const draft = f.saveDelivery();
    const count = (sql: string) => countRows(f.store.db, sql);
    const snapshot = () => [
      count('SELECT COUNT(*) n FROM document_exports'),
      count('SELECT COUNT(*) n FROM business_audit'),
      count('SELECT COUNT(*) n FROM number_sequences'),
      f.current().version,
      f.current().businessStatus,
      f.flow.get(draft.id).version,
      f.flow.get(draft.id).status,
    ];
    const before = snapshot();
    const preview = (body: unknown, token: string | null = csrf) =>
      fetch(origin + '/api/documents/preview-file', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: allowedOrigin,
          cookie,
          ...(token ? { 'x-erp-auth-token': token } : {}),
        },
        body: JSON.stringify(body),
      });
    for (const body of [
      { kind: 'purchase', purchaseIds: [f.purchase.id] },
      { kind: 'delivery', id: draft.id, shipping: true },
    ]) {
      const r = await preview(body);
      assert.equal(r.status, 200, JSON.stringify(body));
      assert.match(String(r.headers.get('content-type')), /wordprocessingml/);
      const bytes = Buffer.from(await r.arrayBuffer());
      assert.equal(bytes.subarray(0, 2).toString(), 'PK', '是 Word 文件');
    }
    assert.equal((await preview({ kind: 'purchase', purchaseIds: [f.purchase.id] }, null)).status, 403, '没有页面凭证拒绝');
    assert.equal((await preview({ kind: 'delivery', id: draft.id, requestId: randomUUID() })).status, 400);
    assert.deepEqual(snapshot(), before, '导出记录、审计、号、单据都没动');
  } finally {
    h.server.closeAllConnections();
    await h.close();
    f.store.close();
  }
});

test('保存单据模板（POST /api/documents/templates）：不带页面凭证 403，带了照常保存', async () => {
  const store = new Store(':memory:'),
    h = await startHttp(store);
  try {
    const body = { expectedRevision: 0, templates: new DocumentTemplateSettings(store).get().templates };
    assert.equal((await h.post('/documents/templates', body, null)).status, 403);
    assert.equal((await h.post('/documents/templates', body)).status, 200);
  } finally {
    await h.close();
    store.close();
  }
});
