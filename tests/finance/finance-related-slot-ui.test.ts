// 订单、送货、到货详情里的财务段插槽：没有财务查看权限不渲染（也就不下载财务段的包），有权限才渲染。渲染成 HTML 看。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FinanceRelatedFor, SlotProvider } from '../../src/ui/slots.js';
import type { Permission } from '../../shared/core/index.js';

/** 替身财务段：渲染出来就能在 HTML 里看到 */
const FakeFinance = ({ kind, id }: { kind: string; id: number }) => h('section', null, `财务段 ${kind} ${id}`);
const actor = (permissions: Permission[]) => ({ actor: { id: 'a1', name: '虚构账号', permissions } });
const render = (auth: Parameters<typeof FinanceRelatedFor>[0]['auth']) =>
  renderToStaticMarkup(
    h(SlotProvider, { value: { FinanceRelated: FakeFinance } }, h(FinanceRelatedFor, { auth, kind: 'orders', id: 7 })),
  );

test('没有财务查看权限（业务员）或还没读到登录状态：财务段不渲染', () => {
  assert.equal(render(actor(['business:edit', 'import:execute'])), '');
  assert.equal(render(null), '');
});

test('有财务查看权限：渲染插槽里的财务段，参数照传', () => {
  assert.equal(render(actor(['finance:view'])), '<section>财务段 orders 7</section>');
});
