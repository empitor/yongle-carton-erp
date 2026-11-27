// 详情里自己读数据的两节（客户详情的“产品”、各详情的“相关订单”）在业务数据变了以后跟着重读（docs/架构/前端约定.md
// “业务数据变了用 useBusinessRevision 重读”）：存完订单、改了产品归属，开着的客户详情不再显示原来的。
// 仓库里没有能跑 effect 的 DOM 渲染器，这里核对读法：useLoad 的 key 带上 useBusinessRevision 的版本号。浏览器里看过见交接单 修-F6.md。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sections = [
  { file: 'src/records/PartyProductDetails.tsx', component: 'CustomerProductList' },
  { file: 'src/records/RelatedOrderList.tsx', component: 'RelatedOrderList' },
];

test('客户详情的“产品”一节、“相关订单”一节：读数据的 key 带业务版本号，业务数据变了就重读', () => {
  for (const { file, component } of sections) {
    const source = readFileSync(new URL('../../' + file, import.meta.url), 'utf8');
    const start = source.indexOf('function ' + component);
    assert.ok(start >= 0, file + ' 里找不到 ' + component);
    const rest = source.slice(start),
      body = rest.slice(0, rest.search(/\r?\n\}\r?\n/));
    assert.match(body, /const \[revision\] = useBusinessRevision\(\);/, component + ' 要取业务版本号');
    const load = /useLoad\(([^\n]*)/.exec(body)?.[1] ?? '';
    assert.match(load, /revision/, component + ' 的 useLoad key 要带业务版本号：' + load);
  }
});
