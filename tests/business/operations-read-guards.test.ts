// 采购库存的读接口（server/operations/router.ts，接口表 shared/business/operations/operations-api.ts）：哪些要页面凭证、找不到回什么、
// 列表先校验参数再判断归档权限。只有经接口才有的结果；内存库、虚构数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { Store } from '../../server/core/index.js';
import { startHttp } from '../support/http-fixture.js';

async function fixture() {
  const store = new Store(':memory:'),
    h = await startHttp(store);
  const get = (path: string, csrf = true) => h.send(path, undefined, h.cookie, csrf ? {} : { csrf: null });
  return {
    get,
    close: async () => {
      await h.close();
      store.close();
    },
  };
}

test('订货单的读接口要页面凭证（不带回 403），供应商、库存品列表这类读接口登录就行', async () => {
  const f = await fixture();
  try {
    for (const path of ['/order-batches', '/order-batches/1', '/order-batches/by-purchase/1'])
      assert.equal((await f.get(path, false)).status, 403, path);
    assert.equal((await f.get('/order-batches')).status, 200);
    for (const path of ['/suppliers', '/purchases', '/warehouse/items', '/warehouse/movements'])
      assert.equal((await f.get(path, false)).status, 200, path);
  } finally {
    await f.close();
  }
});

test('打开一张不存在的采购单、一个不存在的库存品：404，说明是哪种记录不存在', async () => {
  const f = await fixture();
  try {
    for (const [path, message] of [
      ['/purchases/999', '采购单不存在'],
      ['/warehouse/items/999', '库存品不存在'],
    ]) {
      const r = await f.get(path);
      assert.equal(r.status, 404, path);
      assert.equal(z.object({ message: z.string() }).parse(await r.json()).message, message);
    }
  } finally {
    await f.close();
  }
});

test('列表的查询参数先校验（不合规则 400），再判断能不能看已归档的（archived=all 要超级管理员模式，403）', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.get('/suppliers?kind=bad&archived=all')).status, 400);
    assert.equal((await f.get('/suppliers?archived=all')).status, 403);
    assert.equal((await f.get('/purchases?status=bad&archived=all')).status, 400);
    assert.equal((await f.get('/purchases?archived=all')).status, 403);
  } finally {
    await f.close();
  }
});
