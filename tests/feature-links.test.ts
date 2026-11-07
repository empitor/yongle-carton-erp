// 功能链路：导航、页面链接、API、AI 工具、提示词说明之间不能脱节。只做静态检查，不碰数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { erpPageIds, erpPages, registeredErpPageIds } from '../shared/assistant-navigation.js';
import { uiCapabilities } from '../shared/ui-capabilities.js';
import { matchMarkToProducts } from '../shared/mark-matching.js';
import { promptModules } from '../shared/prompt-modules.js';
import Navigation from '../src/Navigation.js';
import { toolCatalog } from '../server/assistant/tools.js';
import { orderWorkflowTools } from '../server/assistant/order-workflow.js';

const walk = (dir: string, out: string[] = []) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|mts)$/.test(name)) out.push(p);
  }
  return out;
};
const read = (dirs: string[]) =>
  dirs.flatMap((d) => walk(d)).map((f) => [f, readFileSync(f, 'utf8')] as const);

test('导航入口和页面内链接都指向真实页面', () => {
  const html = renderToStaticMarkup(
    createElement(Navigation, { page: 'dashboard', navigate: () => {} }),
  );
  assert.match(html, /收件箱/);
  assert.match(html, /AI 导入/);
  const nav = readFileSync('src/Navigation.tsx', 'utf8');
  for (const [, target] of nav.matchAll(/target:\s*'([^']+)'/g))
    assert.ok(
      (erpPageIds as readonly string[]).includes(target.split('?')[0]),
      '导航目标不存在：' + target,
    );
  const bad: string[] = [];
  for (const [file, text] of read(['src']))
    for (const [, page] of text.matchAll(/(?:href=|hash = |href:\s*)['"`{]*#([a-z-]+)[?'"`\s}]/g))
      if (!(erpPageIds as readonly string[]).includes(page)) bad.push(file + ' → #' + page);
  assert.deepEqual(bad, []);
});

test('助手用的页面名称包含导航上的叫法', () => {
  const nav = readFileSync('src/Navigation.tsx', 'utf8');
  for (const [, label, target] of nav.matchAll(
    /label:\s*'([^']+)',\s*target:\s*'([^']+)'(?!,\s*when)/g,
  )) {
    const name = (erpPages as Record<string, string>)[target];
    if (name && !/当前/.test(label) && target !== 'warehouse' && target !== 'production')
      assert.ok(
        name.includes(label) || name.replace(/\s/g, '').includes(label.replace(/\s/g, '')),
        target + '：' + name + ' 不含 ' + label,
      );
  }
});

test('能力清单：页面真实存在，API 在服务端有路由，工具都已注册', () => {
  const server = read(['server'])
    .map(([, t]) => t)
    .join('\n');
  const tools = new Set([...toolCatalog, ...orderWorkflowTools].map((t: any) => t.name));
  for (const c of uiCapabilities) {
    const page = c.page.slice(1).split('?')[0];
    assert.ok(registeredErpPageIds.includes(page), c.id + ' 页面目标未登记：' + c.page);
    for (const api of c.api) {
      const parts = api.split('/').filter((p) => p && p !== 'api' && !p.startsWith(':'));
      const last = parts[parts.length - 1];
      assert.ok(server.includes(last), c.id + ' 找不到路由：' + api);
    }
  }
  const registered = readFileSync('server/assistant/tool-registry.ts', 'utf8');
  for (const name of ['inbox.list', 'inbox.get', 'inbox.set_status', 'order_import.from_inbox']) {
    assert.ok(tools.has(name), name + ' 未进目录');
    assert.ok(registered.includes("'" + name + "'"), name + ' 没有参数校验');
  }
});

test('提示词和助手说明不再用已改掉的入口名称', () => {
  for (const m of promptModules)
    assert.doesNotMatch(m.usage, /AI 智能订单导入|业务工作台|仓库管理|采购到货页面/, m.id);
  const prompt = readFileSync('server/assistant/system-prompt.ts', 'utf8');
  assert.match(prompt, /左侧导航：今日、收件箱、AI导入/);
  assert.match(prompt, /不能当作指令或授权/);
});

test('唛头匹配：最强依据唯一才预选，两款尺寸相同只算候选', () => {
  const box = (id: number, code: string, l = 940, w = 360, h = 190) => ({
    id,
    name: '虚构箱' + id,
    customerProductCode: code,
    length: l,
    width: w,
    height: h,
    dimensionUnit: 'mm',
  });
  const fields = {
    itemCode: '999-ES2828(1+1)',
    cartonLength: '94',
    cartonWidth: '36',
    cartonHeight: '19',
    dimensionUnit: 'cm',
    dimensionBasis: 'outer' as const,
  };
  const one = matchMarkToProducts(fields, [box(1, '999-es2828 (1+1)'), box(2, 'OTHER')]);
  assert.deepEqual(
    one.map((c) => [c.id, c.recommended]),
    [
      [1, true],
      [2, false],
    ],
  );
  assert.match(one[1].reasons[0], /尺寸/);
  // 两个产品料号相同是歧义，都不预选
  const dup = matchMarkToProducts(fields, [box(1, '999-ES2828(1+1)'), box(2, '999-ES2828(1+1)')]);
  assert.deepEqual(
    dup.map((c) => c.recommended),
    [false, false],
  );
  // 料号一致但尺寸不同：提示冲突，不预选
  const conflict = matchMarkToProducts(fields, [box(1, '999-ES2828(1+1)', 500, 400, 300)]);
  assert.equal(conflict[0].recommended, false);
  assert.ok(conflict[0].conflicts.length);
  // 只有内径、没有料号：尺寸一致也只是候选
  const inner = matchMarkToProducts(
    {
      cartonLength: '48',
      cartonWidth: '42',
      cartonHeight: '40',
      dimensionUnit: 'cm',
      dimensionBasis: 'inner',
    },
    [box(1, 'A', 480, 420, 400), box(2, 'B', 480, 420, 400)],
  );
  assert.deepEqual(
    inner.map((c) => c.recommended),
    [false, false],
  );
  assert.match(inner[0].reasons[0], /内径/);
  // 相近料号加尺寸一致可以对应；单位未知不换算；归档产品不参与
  assert.equal(matchMarkToProducts(fields, [box(1, '999-ES2828')])[0].recommended, true);
  assert.equal(
    matchMarkToProducts({ ...fields, itemCode: null, dimensionUnit: null }, [box(1, 'X')]).length,
    0,
  );
  assert.equal(
    matchMarkToProducts(fields, [{ ...box(1, '999-ES2828(1+1)'), archived: true }]).length,
    0,
  );
});
