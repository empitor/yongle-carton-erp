// 送货的收货厂区和三格只读收货信息（src/flow/DeliverySiteFields.tsx，待送货编辑窗和安排送货窗共用）：
// 有厂区时说明三格由所选厂区带出、去客户档案改；客户还没有厂区时说先去客户档案新增。虚构数据。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import DeliverySiteFields from '../../src/flow/DeliverySiteFields.js';

const east = { id: 51, name: '虚构东厂', isDefault: true, contact: '王工', phone: '0001', address: '虚构一路', notes: '' };
const shown = (sites: (typeof east)[]) =>
  renderToStaticMarkup(h(DeliverySiteFields, { sites, siteId: null, change: () => undefined }));
const hints = (html: string) => [...html.matchAll(/<small class="form-field-hint">([^<]*)<\/small>/g)].map((m) => m[1]);

test('有厂区时收货厂区下面一句说明：三格由所选厂区带出，要改去客户档案编辑厂区', () => {
  const html = shown([east]);
  assert.deepEqual(hints(html), ['收货联系人、联系方式、收货地址由所选厂区带出，要改请到客户档案里编辑厂区。']);
  // 三格是由厂区带出的只读文字（output），不是看着像能填的输入框
  assert.doesNotMatch(html, /readOnly|readonly/);
  assert.ok(html.includes('<output class="wh-site-value" aria-label="收货地址">虚构一路</output>'));
  assert.equal((html.match(/<output class="wh-site-value"/g) || []).length, 3);
});

test('客户还没有厂区时选择框不能选，说明先在客户档案里新增厂区', () => {
  const html = shown([]);
  assert.deepEqual(hints(html), ['这个客户还没有厂区，先在客户档案里新增厂区。']);
  assert.match(html, /<select[^>]*disabled/);
  assert.equal((html.match(/<output class="wh-site-value" aria-label="[^"]+">—/g) || []).length, 3);
});
