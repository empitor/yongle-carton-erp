// 公共件：金额写法、数量角标、字号和圆角档位、可搜索下拉、疑点清单、概览说明、Markdown、提示词编辑区、出错和正在读取的提示、列表表格、pdf.js 只在 src/ui 引、切回页面重新取数。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
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
  const { readUserManual } = await import('../server/system/user-manual.js');
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

test('出错提示：红色一块、读屏立刻念；给了关闭就带“关闭提示”按钮，给了动作就排在右边；没有内容不显示', async () => {
  const { FormMessage } = await import('../src/ui/Message.js');
  assert.equal(renderToStaticMarkup(h(FormMessage, { children: '' })), '');
  const plain = renderToStaticMarkup(h(FormMessage, { children: '虚构原因' }));
  assert.equal(plain, '<div class="form-message tone-danger" role="alert">虚构原因</div>');
  const closable = renderToStaticMarkup(h(FormMessage, { close: () => {}, children: '虚构原因' }));
  assert.match(closable, /class="form-message tone-danger has-side"/);
  assert.match(closable, /<button type="button" class="form-message-close" aria-label="关闭提示">/);
  const action = renderToStaticMarkup(
    h(FormMessage, { action: h('button', { type: 'button' }, '重新加载'), children: '虚构原因' }),
  );
  assert.match(action, /has-side[^>]*><span>虚构原因<\/span><button type="button">重新加载<\/button><\/div>/);
  assert.match(renderToStaticMarkup(h(FormMessage, { tone: 'info', children: '虚构说明' })), /tone-info" role="status"/);
});

test('正在读取：一句小字、读屏会念，说明读的是什么', async () => {
  const { Loading, loadingText } = await import('../src/ui/Message.js');
  assert.equal(loadingText(), '正在读取…');
  assert.equal(
    renderToStaticMarkup(h(Loading, { what: '订单' })),
    '<p class="loading-note" role="status">正在读取订单…</p>',
  );
});

/** 前端 src/ui 以外的代码文件 */
const outsideUi = () => {
  const files = readdirSync('src', { recursive: true, encoding: 'utf8' })
    .filter((f) => /\.tsx?$/.test(f) && !f.replaceAll('\\', '/').startsWith('ui/'))
    .map((f) => 'src/' + f.replaceAll('\\', '/'));
  assert.ok(files.length > 100);
  return files;
};

// 出错提示只用 FormMessage、“正在读取”只用 Loading 或 loadingText：别处不再手写这两种样式和这句话
test('出错和正在读取的提示只在 src/ui 写一份', () => {
  for (const file of outsideUi()) {
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /className="(error|form-error|operation-error)"|['"]form-message\b/, file + ' 手写了出错提示的样式，改用 FormMessage');
    assert.doesNotMatch(source, /正在读取/, file + ' 手写了“正在读取”，改用 Loading 或 loadingText');
  }
});

<<<<<<< ours
test('列表表格：表头带列优先级和数字列、开着详情的那一行标出来、勾选列有全选、空着时说一句或不画', async () => {
  const { DataTable } = await import('../src/ui/DataTable.js');
  type Row = { id: number; name: string; amount: number };
  const rows: Row[] = [
    { id: 1, name: '虚构甲', amount: 12345 },
    { id: 2, name: '虚构乙', amount: 0 },
  ];
  const html = renderToStaticMarkup(
    h(DataTable<Row, number>, {
      label: '虚构列表',
      className: 'fin-table',
      cols: [
        { key: 'name', label: '名称', wrap: true, rowNo: true, priority: 'mid', cellClass: 'own', title: (r: Row) => r.name },
        { key: 'amount', label: '金额', money: true },
      ],
      rows,
      onRow: () => {},
      selected: 2,
      check: { key: (r) => r.id, selected: [1, 2], set: () => {}, all: rows, allLabel: '全选虚构', rowLabel: (r) => '选择 ' + r.name },
    }),
  );
  assert.match(html, /role="region"[^>]*aria-label="虚构列表，可左右滚动"/);
  assert.match(html, /<table class="fin-table">/);
  assert.match(html, /<th class="col-mid">名称<\/th><th class="num">金额<\/th>/);
  assert.match(html, /aria-label="全选虚构" title="全选虚构" checked=""/);
  assert.match(html, /<td class="cell-wrap record-no col-mid own" title="虚构甲">虚构甲<\/td><td class="num">123.45<\/td>/);
  assert.match(html, /<tr tabindex="0" class="record-row" aria-selected="false">/);
  assert.match(html, /<tr tabindex="0" class="record-row selected" aria-selected="true">/);
  const empty = (props: { empty?: string | null; emptyNote?: string }) =>
    renderToStaticMarkup(h(DataTable<Row>, { label: '虚构列表', cols: [{ key: 'name', label: '名称' }], rows: [], ...props }));
  assert.match(empty({}), /<strong>这里还没有记录<\/strong>/);
  assert.match(empty({ empty: '没有虚构记录', emptyNote: '换个条件' }), /<strong>没有虚构记录<\/strong><span>换个条件<\/span>/);
  assert.doesNotMatch(empty({ empty: null }), /<tbody><tr/, '页面自己在表格外说的不画空行');
});

// 列表行“点一下或按回车打开详情”和勾选框只在 src/ui/DataTable.tsx 写：别处用 DataTable、DataRow、SelectAll、SelectRow
test('列表行点开详情只在 src/ui 写一份', () => {
  for (const file of outsideUi()) {
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /<tr\s[^<]*?\bon(Click|KeyDown)=/, file + ' 在行上手写了点击或按键，改用 DataTable 或 DataRow');
    assert.doesNotMatch(source, /['"]record-row\b/, file + ' 手写了可点的行，改用 DataTable 或 DataRow');
  }
});

// 打开 PDF、画一页只用 src/ui/pdf.ts 的 openPdf、drawPdfPage：pdf.js 和它的后台线程只在那里引一次（静态、动态、只引类型都算）
test('pdf.js 只在 src/ui 引', () => {
  for (const file of outsideUi())
    assert.doesNotMatch(readFileSync(file, 'utf8'), /['"]pdfjs-dist[/'"]/, file + ' 引了 pdf.js，改用 src/ui 的 openPdf、drawPdfPage');
});

test('切回页面时重新取数：页面可见才发，离上一次不到间隔的不重复发', async () => {
  const { returnRefresher, RETURN_REFRESH_GAP_MS } = await import('../src/ui/return-refresh.js');
  const should = returnRefresher();
  assert.equal(should(1000, false), false, '页面不可见不发');
  assert.equal(should(1000, true), true);
  assert.equal(should(1000 + RETURN_REFRESH_GAP_MS - 1, true), false, '可见和拿到焦点常常一起来，不重复发');
  assert.equal(should(1000 + RETURN_REFRESH_GAP_MS, true), true);
});
