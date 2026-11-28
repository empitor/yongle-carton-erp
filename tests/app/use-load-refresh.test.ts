// useLoad 的第三个参数 refresh（src/ui/data-hooks.ts）：只是它变了算“重读同一份”，旧内容留着、不闪“正在读取…”；
// key 变了才是换了一份。客户详情的“产品”“相关订单”业务数据一变按 refresh 重读（仓库里没有能跑 effect 的渲染器，读法核对源码）。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { loadStatus } from '../../src/ui/data-hooks.js';

test('只有 refresh 变了：不算换了一份（loading 为假、留着旧内容），算重读（reloading 为真）；读完两样都为假', () => {
  assert.deepEqual(loadStatus({ key: '7', revision: 0, refresh: 1 }, '7', 0, 2), { loading: false, reloading: true });
  assert.deepEqual(loadStatus({ key: '7', revision: 0, refresh: 2 }, '7', 0, 2), { loading: false, reloading: false });
  // key 变了照旧是换了一份，refresh 跟着变也一样
  assert.deepEqual(loadStatus({ key: '7', revision: 0, refresh: 1 }, '8', 0, 2), { loading: true, reloading: false });
  // 不传 refresh 的调用方和原来一样
  assert.deepEqual(loadStatus({ key: '7', revision: 0 }, '7', 0), { loading: false, reloading: false });
});

test('客户详情的“产品”“相关订单”：业务版本号作为 refresh 传给 useLoad，不拼进 key', () => {
  for (const [file, component] of [
    ['src/records/PartyProductDetails.tsx', 'CustomerProductList'],
    ['src/records/RelatedOrderList.tsx', 'RelatedOrderList'],
  ]) {
    const source = readFileSync(new URL('../../' + file, import.meta.url), 'utf8');
    const body = source.slice(source.indexOf('function ' + component));
    const call = /useLoad\(([^\n]*)\);/.exec(body)?.[1] ?? '';
    assert.match(call, /, revision$/, component + ' 的 useLoad 最后一个参数要是 revision：' + call);
    assert.doesNotMatch(call.split(',')[0], /revision/, component + ' 的 key 里不要再拼 revision：' + call);
  }
});
