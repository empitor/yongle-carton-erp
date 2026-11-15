// 公共件：金额写法、数量角标、字号和圆角档位、可搜索下拉、疑点清单、概览说明、Markdown、提示词编辑区、切回页面重新取数。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { yuan } from '../src/ui/money.js';
import Navigation from '../src/Navigation.js';
import Combobox from '../src/ui/Combobox.js';
import { groupIssues } from '../src/import/ReviewIssues.js';
import { ListSummary } from '../src/ui/ListLayout.js';
import type { PromptPreset, PromptSettingsView } from '../shared/ai/index.js';

test('以分存的金额统一两位小数加千分位，今日页和财务设置不再手写换算', () => {
  assert.equal(yuan(123450), '1,234.50');
  assert.equal(yuan(100000000), '1,000,000.00');
  assert.equal(yuan(-5), '-0.05');
  for (const file of ['src/records/TodayQueue.tsx', 'src/finance/enable.tsx']) {
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /\/ ?100\)\.(toFixed|toLocaleString)\(/, file);
    assert.match(source, /yuan\(/, file);
  }
});

test('数量角标：收件箱和账号申请用中性色，只有 AI 导入用紫色', () => {
  const html = renderToStaticMarkup(
    h(Navigation, {
      page: 'dashboard',
      navigate: () => {},
      inboxCount: 3,
      importCount: 2,
      accounts: true,
      accountRequests: 1,
    }),
  );
  assert.match(html, /class="nav-count">3</);
  assert.match(html, /class="nav-count ai">2</);
  assert.match(html, /class="nav-count">1</);
  const css = readFileSync('src/shell.css', 'utf8');
  const block = (selector: string) => {
    const at = css.indexOf('\n' + selector + ' {');
    assert.ok(at >= 0, selector);
    return css.slice(at, css.indexOf('}', at));
  };
  assert.doesNotMatch(block('.nav-count'), /purple/);
  assert.match(block('.nav-count'), /background: var\(--accent-soft\)/);
  assert.match(block('.nav-count.ai'), /var\(--purple\)/);
  assert.doesNotMatch(block('.erp-nav-item .nav-count'), /purple/);
});

// 页面里写死字号、圆角由 stylelint 拦（npm run lint:css）；这里只查变量本身：字号只有规定的六档，圆角变量只有这几种
test('字号、圆角变量只用规定档位', () => {
  const css = readFileSync('src/ui/tokens.css', 'utf8');
  // --text-xs … --text-2xl 是字号（--text-secondary 是颜色，不算）
  const sizes = [...css.matchAll(/--text-(?:xs|sm|md|lg|\d*xl):([^;]+);/g)].map((m) => m[1].trim());
  assert.deepEqual([...new Set(sizes)].sort(), ['12px', '13px', '14px', '16px', '20px', '24px'].sort());
  const radii = [...new Set([...css.matchAll(/(--r-[\w-]+):/g)].map((m) => m[1]))].sort();
  assert.deepEqual(radii, ['--r-circle', '--r-control', '--r-inner', '--r-panel', '--r-pill', '--r-small']);
});

test('可搜索下拉未选择时才要求必填，已选值显示名称', () => {
  const options = [{ value: '1', label: '虚构客户甲' }];
  const empty = renderToStaticMarkup(
    h(Combobox, { value: '', options, onChange: () => {}, ariaLabel: '客户', required: true }),
  );
  assert.match(empty, /required/);
  const chosen = renderToStaticMarkup(
    h(Combobox, { value: '1', options, onChange: () => {}, ariaLabel: '客户', required: true }),
  );
  assert.doesNotMatch(chosen, /required/);
  assert.match(chosen, /value="虚构客户甲"/);
});

test('疑点清单合并相同提示，必须处理的排在前面', () => {
  const groups = groupIssues(
    [
      { path: 'a', message: '字段待核对' },
      { path: 'b', message: '字段待核对' },
      { path: 'c', message: '金额不符', severity: 'error' },
    ],
    ['模型提示', '字段待核对'],
  );
  assert.deepEqual(
    groups.map((g) => [g.message, g.error, g.count]),
    [
      ['金额不符', true, 1],
      ['字段待核对', false, 2],
      ['模型提示', false, 1],
    ],
  );
});


test('概览：口径说明收起，“另有 N 种没算进去”这类说明和数量单位要显示', () => {
  const html = renderToStaticMarkup(
    h(ListSummary, { items: [{ label: '总面积', value: '1 m²', hint: '按长宽和数量算', note: '另有 1 种尺寸或单位不全，没算进去' }] }),
  );
  assert.match(html, /<small>按长宽和数量算<\/small>/);
  assert.match(html, /<small class="list-summary-note">另有 1 种尺寸或单位不全，没算进去<\/small>/);
});


test('提示词编辑区：不是超级管理员账号时只读，编辑框不能改，复制、恢复、删除、添加条目、保存都不显示；超级管理员照旧', async () => {
  const { default: PromptEditor } = await import('../src/admin/PromptEditor.js');
  const preset: PromptPreset = {
    id: 'p1',
    name: '虚构识别预设',
    entries: [{ id: 'e1', name: '虚构规则', content: '虚构内容', enabled: true }],
  };
  const state: PromptSettingsView = { presets: [preset], activeId: 'p1', revision: 1, csrfToken: 'x' };
  const props = (editable: boolean) => ({
    current: preset,
    setCurrent: () => {},
    state,
    saved: preset,
    dirty: false,
    busy: false,
    editable,
    assistant: false,
    command: () => {},
    save: () => {},
  });
  const view = renderToStaticMarkup(h(PromptEditor, props(false)));
  assert.match(view, /<textarea[^>]*readOnly=""/);
  assert.match(view, /aria-label="提示词预设名称"[^>]*readOnly=""/);
  for (const hidden of ['保存并启用', '添加条目', '预设更多操作', '条目1更多操作', '保存的其他方式'])
    assert.doesNotMatch(view, new RegExp(hidden), '只读时不显示：' + hidden);
  const edit = renderToStaticMarkup(h(PromptEditor, props(true)));
  assert.doesNotMatch(edit, /readOnly/);
  for (const shown of ['保存并启用', '添加条目', '预设更多操作'])
    assert.match(edit, new RegExp(shown), '超级管理员能看到：' + shown);
});

test('使用说明页的 Markdown 显示（src/ui/Markdown.tsx）：使用手册每一节都显示成标题、段落、列表、表格，不留 ** 和表格竖线，站内 .md 链接只显示文字', async () => {
  const { Markdown } = await import('../src/ui/Markdown.js');
  const { readUserManual } = await import('../server/core/user-manual.js');
  const manual = readUserManual();
  let tables = 0;
  for (const section of manual.sections) {
    const html = renderToStaticMarkup(h(Markdown, { source: section.body }));
    assert.doesNotMatch(html, /\*\*/, section.title + ' 还有没转成加粗的 **');
    assert.doesNotMatch(html, /<p>\|/, section.title + ' 有表格没认出来');
    assert.doesNotMatch(html, /href="[^"#h][^"]*"/, section.title + ' 站内文件链接不该成为链接');
    tables += (html.match(/<table>/g) || []).length;
  }
  assert.ok(tables > 0, '使用手册里的表格显示成表格');
  const sample = renderToStaticMarkup(
    h(Markdown, { source: '### 小标题\n1. **第一步：** 点`保存`\n   - 子项\n2. 见[说明](部署与运维.md)和[订单](#orders)\n\n| 列 | 值 |\n|---|---|\n| 甲 | 乙 |' }),
  );
  assert.equal(
    sample,
    '<h3>小标题</h3><ol><li><strong>第一步：</strong> 点<code>保存</code><ul><li>子项</li></ul></li><li>见说明和<a href="#orders">订单</a></li></ol><div class="markdown-table"><table><thead><tr><th>列</th><th>值</th></tr></thead><tbody><tr><td>甲</td><td>乙</td></tr></tbody></table></div>',
  );
});

test('切回页面时重新取数：页面可见才发，离上一次不到间隔的不重复发', async () => {
  const { returnRefresher, RETURN_REFRESH_GAP_MS } = await import('../src/ui/return-refresh.js');
  const should = returnRefresher();
  assert.equal(should(1000, false), false, '页面不可见不发');
  assert.equal(should(1000, true), true);
  assert.equal(should(1000 + RETURN_REFRESH_GAP_MS - 1, true), false, '可见和拿到焦点常常一起来，不重复发');
  assert.equal(should(1000 + RETURN_REFRESH_GAP_MS, true), true);
});
