// 客户编辑窗的厂区（src/editors/CustomerSites.tsx、CustomerEditor.tsx）：一句说明、没有默认时单独提醒重新指定，
// 不替人选；底栏说清哪些必填。服务端同一条校验（两个以上厂区要恰好一个默认）在 customer-sites.test.ts。渲染成 HTML。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import CustomerEditor from '../../src/editors/CustomerEditor.js';
import CustomerSites from '../../src/editors/CustomerSites.js';

const site = (name: string, isDefault: boolean) => ({ name, contact: '', phone: '', address: '', notes: '', isDefault });
const NEED_DEFAULT = '还没有默认厂区，请选一个设为默认。';
const shown = (sites: (ReturnType<typeof site> & { id?: number })[]) => renderToStaticMarkup(h(CustomerSites, { sites, change: () => {} }));

test('删掉默认厂区、还剩两个以上时提示重新指定默认，不替人选；有默认或只剩一个时不提示', () => {
  const html = shown([site('虚构东厂', false), site('虚构西厂', false)]);
  assert.ok(html.includes(NEED_DEFAULT));
  assert.doesNotMatch(html, /checked/);
  for (const sites of [[site('虚构东厂', true), site('虚构西厂', false)], [site('虚构东厂', false)], []])
    assert.ok(!shown(sites).includes(NEED_DEFAULT), JSON.stringify(sites));
});

test('厂区那节只有一句说明：客户联系方式和厂区各改各的；有存过的厂区时再说清哪些送货单跟着更新；没默认的提醒单独一块', () => {
  const ALONE = '客户的联系方式和厂区各改各的。';
  const SYNC = '客户的联系方式和厂区各改各的；改了已存厂区的资料，用着它的待送货单会跟着更新，已出库、已取消、已撤销的不变。';
  const hintOf = (html: string) => [...html.matchAll(/<p class="ed-hint">([^<]*)<\/p>/g)].map((m) => m[1]);
  assert.deepEqual(hintOf(shown([{ id: 7, ...site('虚构东厂', true) }])), [SYNC]);
  assert.deepEqual(hintOf(shown([site('虚构东厂', true)])), [ALONE]);
  assert.deepEqual(hintOf(shown([])), [ALONE]);
  const both = shown([{ id: 7, ...site('虚构东厂', false) }, site('虚构西厂', false)]);
  assert.deepEqual(hintOf(both), [SYNC], '说明还是一句，不和“没有默认”连着');
  assert.ok(both.includes('<div class="form-message tone-warning" role="status">' + NEED_DEFAULT + '</div>'));
});

test('厂区卡片头部“默认”和删除图标分在两头（默认那格占满左边），不挨着', () => {
  const html = shown([site('虚构东厂', true)]);
  assert.match(html, /<header class="sales-site-head"><label class="sales-site-default">/);
});

test('客户编辑窗底栏说全必填：客户名称；加了厂区要填厂区名称、选一个默认', () => {
  const html = renderToStaticMarkup(h(CustomerEditor, { close: () => {}, saved: () => {} }));
  assert.match(html, /客户名称必填；加了厂区要填厂区名称、选一个默认，其余可以以后补。/);
  assert.doesNotMatch(html, /只有名称必填/);
});
