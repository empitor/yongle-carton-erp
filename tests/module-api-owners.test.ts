/**
 * 前端请求后端接口也按模块管：每个前端模块只能请求自己对应的后端模块和它能用的后端模块的地址。
 * 要用别的模块的数据，走 src/ui/slots.tsx 里的服务接口（由那个模块实现、src/slots.ts 装配），不直接请求它的地址。
 * 地址归哪个后端模块按前缀登记（最长前缀算数）；新加的后端地址没登记会被拦下，登记了却没有路由的也拦。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { all, ownerModule } from './module-map.js';
import { apiScanner } from './module-boundaries-api.js';
import { hasRouteUnder } from './server-routes.js';

const apiOwners: [prefix: string, module: string][] = [
  ['/auth', '基础'],
  // 页面报错上报进出错记录库（server/core/diagnostics/page-problems.ts）
  ['/diagnostics', '基础'],
  // 使用手册（server/system/user-manual.ts），“使用说明”页读
  ['/guide', '系统资料'],
  ['/business', '业务汇总'], ['/dashboard', '业务汇总'], ['/customers', '业务汇总'], ['/products', '业务汇总'],
  ['/orders', '业务汇总'], ['/marks', '业务汇总'],
  ['/suppliers', '采购库存'],
  // 采购单、库存品和流水、订货单（含登记到货）回答带单据的内容，在单据流转（server/flow/stock-router.ts）
  ['/purchases', '单据流转'], ['/warehouse', '单据流转'], ['/order-batches', '单据流转'],
  ['/flow', '单据流转'],
  // 删除（server/lifecycle/deletion-router.ts）和六类档案的批量归档、恢复（server/lifecycle/lifecycle-router.ts）在删除归档
  ['/deletions', '删除归档'],
  ['/customers/batch', '删除归档'], ['/products/batch', '删除归档'], ['/orders/batch', '删除归档'],
  ['/suppliers/batch', '删除归档'], ['/purchases/batch', '删除归档'], ['/stock_items/batch', '删除归档'],
  // 送货单原件的上传、列表、读识别结果、AI 识别在识别导入；看原件文件在单据流转（原件表归单据流转）
  ['/flow/sources', '识别导入'], ['/flow/sources/:id/file', '单据流转'],
  ['/documents', '单据导出'],
  ['/finance', '财务'],
  ['/ai/imports', '识别导入'], ['/inbox', '识别导入'],
  ['/ai/settings', 'AI接入'], ['/ai/prompt-modules', 'AI接入'],
  ['/management', '数据管理'],
  // 健康检查（server/app.ts 内联，启动脚本和 shared/core/account-scope.ts 用）；前端模块都不该请求它
  ['/health', '装配'],
  ['/assistant', '助手'],
];
const apiAllow: Record<string, string[]> = {
  '前端-基础': ['基础'],
  '前端-业务': ['基础', '采购库存', '单据流转', '删除归档', '业务汇总'],
  '前端-单据导出': ['单据导出'],
  '前端-系统资料': ['系统资料'],
  '前端-财务': ['基础', '财务'],
  '前端-识别': ['基础', 'AI接入', '采购库存', '单据流转', '业务汇总', '识别导入'],
  // AI 接入没有自己的页面，模型和提示词设置页在数据管理
  '前端-管理': ['基础', 'AI接入', '识别导入', '数据管理'],
  '前端-助手': ['基础', '助手'],
};
const apiOwner = (path: string) =>
  apiOwners
    .filter(([p]) => path === p || path.startsWith(p + '/') || path.startsWith(p + '?'))
    .sort((a, b) => b[0].length - a[0].length)[0]?.[1];

/* 前端请求地址的回归样例：每条一个虚构文件名（磁盘上没有），expect 是取出来的地址，violation 是按 apiOwner、apiAllow 该判的结果 */
type ApiSample = { name: string; file: string; code: string; expect: string[]; violation?: '没登记' | '越界' };

let apiProbeCount = 0;
/** 每条样例各用一个文件名，同一批里不能重名 */
const apiProbe = (dir: string) => dir + '__api_probe_' + ++apiProbeCount + '__.tsx';
const head = `import { call, uploadFile } from '../ui/index';
import { authorizedRequest } from '../ui/http';
import { exportHref } from './fin-api';
import { ExportLink } from './layout';
declare const id: number;
declare const cond: boolean;
`;
/** 财务前端的样例：名字、代码（自动补上 head）、取出的地址、该判的结果 */
const fin = (name: string, code: string, expect: string[], violation?: ApiSample['violation']): ApiSample => ({
  name,
  file: apiProbe('src/finance/'),
  code: head + code,
  expect,
  violation,
});

const apiSamples: ApiSample[] = [
  // ---------- 必须拦住 ----------
  fin('财务前端直接 fetch 没登记的模块', `export const probe = () => fetch('/api/unregistered-module/probe');`, ['/unregistered-module/probe'], '没登记'),
  fin('财务前端先存进变量再请求业务汇总的地址', `export function probe() { const path = '/customers'; return authorizedRequest(path, undefined, 'GET'); }`, ['/customers'], '越界'),
  fin('财务前端模板字符串请求业务汇总', 'export const probe = () => authorizedRequest(`/customers/${id}`, undefined, "GET");', ['/customers/:id'], '越界'),
  fin('财务前端拼出来的 /api 地址（不在请求函数里）', `export const url = '/api/customers/' + id + '/x';`, ['/customers/:id/x'], '越界'),
  fin('请求函数参数里没登记的根前缀（不带 /api 也报）', `export const probe = () => authorizedRequest('/unregistered/x', undefined, 'GET');`, ['/unregistered/x'], '没登记'),
  fin('三元：两边都算', `export const probe = () => authorizedRequest(cond ? '/customers' : '/suppliers', undefined, 'GET');`, ['/customers', '/suppliers'], '越界'),
  fin(
    '开头是字面量联合类型的变量：展开成每个值',
    `export const probe = (kind: 'orders' | 'customers') => authorizedRequest('/' + kind + '/' + id, undefined, 'GET');`,
    ['/customers/:id', '/orders/:id'],
    '越界',
  ),
  fin('放在对象属性里再请求', `const paths = { list: '/customers' };\nexport const probe = () => authorizedRequest(paths.list, undefined, 'GET');`, ['/customers'], '越界'),
  fin(
    '经参数传给本文件的小封装',
    `function load(p: string) { return authorizedRequest(p, undefined, 'GET'); }\nexport const probe = () => load('/customers');`,
    ['/customers'],
    '越界',
  ),
  fin(
    '下载链接是后端地址时按地址算',
    `export const Probe = () => <a href={'/api/customers/' + id + '/export'} download>导出</a>;`,
    ['/customers/:id/export'],
    '越界',
  ),
  fin('window.open 打开单据流转的打印页', `export const probe = () => window.open('/api/flow/' + id + '/print');`, ['/flow/:id/print'], '越界'),
  fin('uploadFile 到别的模块', `export const probe = (f: File) => uploadFile('/api/inbox/upload', f);`, ['/inbox/upload'], '越界'),
  fin(
    '按接口表发（call()）：键里的地址照样算',
    `const records = call();
export const list = () => records('GET /customers');
export const save = () => records('PUT /customers/:id', { params: { id }, body: {} });`,
    ['/customers', '/customers/:id'],
    '越界',
  ),
  fin(
    'call() 的键先存进变量、按动作拼出来、再包一层的都认得',
    `const records = call();
const key = 'GET /orders' as const;
export const a = () => records(key);
export const b = (action: 'confirm' | 'cancel') => records(\`POST /orders/:id/\${action}\`, { params: { id }, body: {} });
const get = (k: 'GET /products') => records(k);
export const c = () => get('GET /products');`,
    ['/orders', '/orders/:id/cancel', '/orders/:id/confirm', '/products'],
    '越界',
  ),
  fin('call() 的键开头没登记也报', `export const probe = () => call()('POST /unregistered-call/x', { body: {} });`, ['/unregistered-call/x'], '没登记'),
  // ---------- 不该误报 ----------
  fin(
    "财务封装补 /finance：exportHref('/flow') 是 /finance/flow，不是单据流转",
    `export const Probe = () => { exportHref('/flow', { period: '2026-01' }); return null; };`,
    ['/finance/flow'],
  ),
  fin('财务封装的参数先存进变量', `export const Probe = () => { const p = '/flow'; return <ExportLink path={p} />; };`, ['/finance/flow']),
  fin(
    'exportHref、ExportLink 补 /finance：拼接的、带查询参数的都算',
    `export const probe = () => exportHref('/vouchers/' + id + '/post');
export const read = () => exportHref('/orders', { page: 1 });
export const href = exportHref('/flow/export', { period: '2026-01' });
export const Probe = () => <ExportLink path="/purchases/export" />;`,
    ['/finance/flow/export', '/finance/orders', '/finance/purchases/export', '/finance/vouchers/:id/post'],
  ),
  fin(
    '地址是封装的第二个参数（第一个是方法）：照样补前缀；封装里写的前缀在它自己那行算一次',
    `function send(method: string, path: string, body?: unknown) { return authorizedRequest('/finance' + path, body, method); }
export const probe = () => send('POST', '/vouchers/' + id + '/post', {});
export const read = () => send('GET', '/orders');`,
    ['/finance', '/finance/orders', '/finance/vouchers/:id/post'],
  ),
  fin(
    '外部地址、页面跳转、静态资源、相对地址、不是“方法 /地址”的字都不算',
    `export const a = () => fetch('https://example.com/api/customers');
export const b = () => fetch('//cdn.example.com/x.js');
export const Probe = () => (
  <>
    <a href="#orders?order=1">订单</a>
    <a href={'#finance-flow?tab=' + id}>台账</a>
    <img src="/favicon.svg" alt="" />
    <img src="/assets/logo-abc123.png" alt="" />
    <script src="/theme-init.js" />
  </>
);
export const c = () => fetch('/vendor/pdf.worker.mjs');
export const d = () => fetch('data:text/plain,hello');
export const e = 'orders/list';
export const f = '/unknown/not-an-api';
export const g = 'GET customers';
export const h = 'GETS /customers';`,
    [],
  ),
  fin(
    '注释和 JSX 文字里的地址不算',
    `// authorizedRequest('/customers', undefined, 'GET')
/* fetch('/api/orders') */
export const Probe = () => <p>/api/customers 是业务的地址</p>;`,
    [],
  ),
  {
    name: '借用别的模块的组件：组件自己请求的地址算在组件所在文件，借用处不算',
    file: apiProbe('src/admin/'),
    code: `import { DatabaseDeleteDialog } from '../recordkit/index';\nexport const Probe = () => <DatabaseDeleteDialog {...({} as any)} />;`,
    expect: [],
  },
];

const api = apiScanner(apiOwners.map(([prefix]) => prefix));
test('前端每个模块只请求自己和能用的后端模块的接口，别的模块的数据走插槽里的服务接口', () => {
  // 地址怎么取见 apiRefs 的说明：先存变量、三元、拼接、经参数传给封装、财务封装补 /finance 都算，请求函数里没登记的开头也报。
  // src 按模块查：没登记的报“没登记”，登记了但这个模块不能用的报越界。
  // 前端-装配（src 根目录、手机导航）能用全部，只查登记；shared 里给前端用的地址（提示词模块的 apiPath、助手能力表里的接口）
  // 看不出最后由哪个前端模块请求，只查登记。
  // 借用别的模块的组件不算越界：地址按字面量所在文件的模块算。
  const bad: string[] = [];
  for (const f of all.filter((x) => /^(src|shared)\/.*\.tsx?$/.test(x))) {
    const from = ownerModule(f).name;
    for (const r of api.refs(f, readFileSync(f, 'utf8'))) {
      const owner = apiOwner(r.path);
      if (!owner) bad.push(f + ':' + r.line + '：' + r.path + ' 没登记属于哪个后端模块（' + r.via + '），在本文件的 apiOwners 按前缀登记');
      else if (f.startsWith('src/') && from !== '前端-装配' && !apiAllow[from]?.includes(owner))
        bad.push(
          f + ':' + r.line + '（' + from + '）→ ' + r.path + '（' + owner + '，' + r.via + '）：' + from + '不能请求' + owner +
            '的地址。别的模块的数据走 src/ui/slots.tsx 的服务接口（由那个模块实现、src/slots.ts 装配），或借用那个模块经入口给的组件、函数',
        );
    }
  }
  assert.deepEqual(bad, []);
});

test('前端请求地址的取法：该拦的拦住，外部地址、页面跳转、静态资源、注释不算', () => {
  const got = api.refsMany(apiSamples.map((s) => ({ file: s.file, text: s.code })));
  for (const [i, s] of apiSamples.entries()) {
    assert.deepEqual([...new Set(got[i].map((r) => r.path))].sort(), [...s.expect].sort(), s.name);
    const from = ownerModule(s.file).name;
    const verdicts = new Set(
      got[i]
        .map((r) => apiOwner(r.path))
        .map((owner) => (!owner ? '没登记' : apiAllow[from]?.includes(owner) ? '' : '越界'))
        .filter(Boolean),
    );
    assert.deepEqual([...verdicts], s.violation ? [s.violation] : [], s.name);
  }
  api.release(); // 上面两条测试用完类型程序（约 200 MB）；同进程里别的测试文件也用完才放掉
});

test('登记的每个地址前缀在服务端都还挂着路由，前端模块的可用表只写登记过的模块', () => {
  assert.deepEqual(
    apiOwners.filter(([p]) => !hasRouteUnder('/api' + p)).map(([p]) => p + '：服务端已经没有这个前缀的路由，从 apiOwners 删掉或改成现在的前缀'),
    [],
  );
  const owners = new Set(apiOwners.map(([, m]) => m));
  assert.deepEqual(
    Object.values(apiAllow).flat().filter((m) => !owners.has(m)).map((m) => m + '：apiOwners 里没有这个模块，从 apiAllow 删掉或先在 apiOwners 登记它的前缀'),
    [],
  );
});
