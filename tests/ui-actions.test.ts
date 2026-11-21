// 全站一套“主 / 次 / 更多”（src/ui/Actions.tsx）：页头、详情头部、勾选条排法不同，规则同一份。只渲染。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ActionBar, MenuItem } from '../src/ui/Actions.js';
import { PageHeading } from '../src/ui/ListLayout.js';
import SelectionBar from '../src/ui/SelectionBar.js';

const noop = () => {};
/** 一段 HTML 里按出现先后列出按钮、链接和分隔线 */
const order = (html: string) =>
  [...html.matchAll(/<(button|a|hr|input)\b[^>]*>([^<]*)/g)].map((m) => (m[1] === 'hr' ? '—' : m[1] === 'input' ? '条件' : m[2]));

test('页头：右边从左到右是条件、“更多”、一个次要、一个主按钮；危险项在“更多”分隔线下面', () => {
  const html = renderToStaticMarkup(
    h(
      PageHeading,
      {
        title: '虚构页',
        primary: { label: '虚构主', onClick: noop },
        secondary: { label: '虚构次', onClick: noop },
        more: [{ label: '虚构删除', danger: true, onClick: noop }, null, false, { label: '虚构导出', onClick: noop }],
        moreLabel: '虚构页的更多操作',
      },
      h('input', { type: 'month' }),
    ),
  );
  assert.deepEqual(order(html), ['条件', '虚构导出', '—', '虚构删除', '虚构次', '虚构主']);
  assert.match(html, /aria-label="虚构页的更多操作"/);
  assert.match(html, /<button type="button" class="secondary">虚构次<\/button><button type="button" class="primary">虚构主<\/button>/);
  assert.match(html, /class="danger-text">虚构删除/);
});

test('页头：没有按钮也没有条件时不画按钮区；藏起来的不出', () => {
  const html = renderToStaticMarkup(h(PageHeading, { title: '虚构页', primary: { label: '虚构主', hidden: true }, more: [] }));
  assert.doesNotMatch(html, /page-actions/);
});

test('页头的链接按钮用 button 底样式，导出项是直接下载的链接', () => {
  const html = renderToStaticMarkup(
    h(PageHeading, {
      title: '虚构页',
      primary: { label: '虚构补税率', href: '#虚构' },
      more: [{ label: '虚构导出', href: '/虚构.xlsx', download: true }],
    }),
  );
  assert.match(html, /<a class="button primary" href="#虚构">虚构补税率<\/a>/);
  assert.match(html, /<a role="menuitem" href="\/虚构.xlsx" download="">虚构导出<\/a>/);
});

test('详情头部：主、次在左，多的主降为次要，次要超过两个进“更多”，危险项挪到“更多”最下面', () => {
  const html = renderToStaticMarkup(
    h(ActionBar, {
      primary: [{ label: '虚构甲' }, { label: '虚构乙' }, { label: '虚构撤销', danger: true }],
      secondary: [{ label: '虚构丙' }, { label: '虚构丁' }, { label: '虚构打印', href: '#打印', external: true }],
      more: [{ label: '虚构历史' }, { label: '虚构取消', danger: true }],
    }),
  );
  assert.deepEqual(order(html), ['虚构甲', '虚构乙', '虚构丙', '虚构丁', '虚构打印', '虚构历史', '—', '虚构取消', '虚构撤销']);
  assert.match(html, /<a role="menuitem" href="#打印" target="_blank" rel="noreferrer">虚构打印<\/a>/);
  assert.equal(renderToStaticMarkup(h(ActionBar, { primary: [{ label: '虚构', hidden: true }] })), '');
});

test('勾选条：次要、主、“更多”、清除选择', () => {
  const html = renderToStaticMarkup(
    h(SelectionBar, {
      count: 2,
      primary: { label: '虚构主' },
      secondary: { label: '虚构次' },
      more: [{ label: '虚构删除', danger: true }, { label: '虚构归档' }],
      onClear: noop,
    }),
  );
  assert.deepEqual(order(html), ['虚构次', '虚构主', '虚构归档', '—', '虚构删除', '清除选择']);
});

test('菜单项：读屏名可以和显示的字不同，危险项红字', () => {
  const html = renderToStaticMarkup(h(MenuItem, { label: '归档文件 虚构.pdf', danger: true, onClick: noop, children: '归档' }));
  assert.equal(html, '<button type="button" role="menuitem" class="danger-text" aria-label="归档文件 虚构.pdf">归档</button>');
});
