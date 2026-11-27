// 客户详情的“厂区”一节（src/records/PartyProductDetails.tsx）：一个厂区一块浅底圆角块（和成品批次共用 InfoBlocks），
// 头部名称和“默认”标记，下面只列填了的几项，不再借相关订单那种一行四列的样式。虚构数据，渲染成 HTML。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CustomerDetail } from '../../src/records/PartyProductDetails.js';

const site = { contact: '', phone: '', address: '', notes: '', isDefault: false };
const row = {
  id: 1, name: '虚构厂区客户', contact: '', phone: '', address: '', notes: '', version: 1,
  createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z',
  sites: [
    { ...site, id: 11, name: '虚构东厂', contact: '王工', phone: '0001', address: '虚构省虚构市虚构区一路一号很长很长的收货地址', isDefault: true },
    { ...site, id: 12, name: '虚构西厂', notes: '门卫登记' },
  ],
};

test('客户详情的厂区一条一块：名称后面“默认”标记，只列填了的联系人、联系方式、地址、备注', () => {
  const html = renderToStaticMarkup(h(CustomerDetail, { row }));
  const blocks = [...html.matchAll(/<li class="kit-block">([\s\S]*?)<\/li>/g)].map((m) => m[1]);
  assert.equal(blocks.length, 2);
  const text = (b: string) => b.replace(/<[^>]+>/g, '|').split('|').filter(Boolean);
  assert.deepEqual(text(blocks[0]), ['虚构东厂', '默认', '联系人', '王工', '联系方式', '0001', '地址', row.sites[0].address]);
  assert.deepEqual(text(blocks[1]), ['虚构西厂', '备注', '门卫登记']);
  assert.doesNotMatch(html, /（默认）/);
  assert.doesNotMatch(html, /sales-order-links/);
});
