/**
 * 一件事一条链路（AGENTS.md）的自动检查之二：一个动作一个提交处。同一个写地址在 src/ 里只许一个文件发
 * （各模块的 *-api.ts 这类接口文件），两个窗口要办同一件事就共用那个函数。地址怎么取见 tests/checks/module-boundaries-api.ts，
 * 怎么算“发”见 tests/checks/feature-links-scan.ts 的 writeSenders。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { all } from './module-map.js';
import { apiScanner } from './module-boundaries-api.js';
import { serverRouteList } from './server-routes.js';
import { writeSenders } from './feature-links-scan.js';

/** 确实要两个文件发同一个写地址的：地址、文件、为什么。用不上了测试会提醒删 */
const sharedSenders: { route: string; files: string[]; why: string }[] = [];

const routes = serverRouteList();
const api = apiScanner([...new Set(routes.map((r) => '/' + r.path.split('/')[1]))]);

const group = (senders: { route: string; file: string; at: string }[]) => {
  const by = new Map<string, Map<string, string[]>>();
  for (const s of senders) {
    const files = by.get(s.route) ?? by.set(s.route, new Map()).get(s.route);
    files?.set(s.file, [...(files.get(s.file) ?? []), s.at]);
  }
  return by;
};

test('一个动作一个提交处：同一个写地址在前端只有一个文件发', () => {
  const refs = all
    .filter((f) => /^src\/.*\.tsx?$/.test(f))
    .map((file) => ({ file, refs: api.refs(file, readFileSync(file, 'utf8')) }));
  const by = group(writeSenders(refs, routes));
  const shared = new Map(sharedSenders.map((s) => [s.route, s.files]));
  const bad: string[] = [];
  for (const [route, files] of by) {
    const allowed = shared.get(route) ?? [];
    if (files.size > 1 && [...files.keys()].some((f) => !allowed.includes(f)))
      bad.push(route + ' 有 ' + files.size + ' 个文件发：' + [...files].map(([f, at]) => f + '（' + at.join('、') + '）').join('；'));
  }
  for (const s of sharedSenders) if ((by.get(s.route)?.size ?? 0) < 2) bad.push(s.route + ' 已经只有一个文件发，删掉登记');
  assert.deepEqual(bad, []);
});

test('提交处的取法：直接调请求入口算本文件，调别的文件包好的函数算那个文件；读写同地址的只认带内容的调用', () => {
  const head = "import { authorizedRequest } from '../ui/http';\nimport { workspaceAction } from '../import/workspace-api';\n";
  const samples = [
    { file: 'src/records/__sender_probe_1__.ts', text: head + "export const a = (b: unknown) => authorizedRequest('/customers', b, 'POST');" },
    { file: 'src/records/__sender_probe_2__.ts', text: head + "export const r = () => authorizedRequest('/customers', undefined, 'GET');" },
    { file: 'src/records/__sender_probe_3__.ts', text: head + "export const c = (b: unknown) => authorizedRequest('/flow/1/cancel', b, 'POST');" },
    { file: 'src/records/__sender_probe_4__.ts', text: head + "export const l = () => workspaceAction('t', '1', 'undo', { expectedRevision: 1 });" },
  ];
  const got = api.refsMany(samples);
  const senders = writeSenders(
    samples.map((s, i) => ({ ...s, refs: got[i] })),
    routes,
  );
  assert.deepEqual(
    senders.map((s) => s.route + ' ← ' + s.file),
    [
      '/customers ← src/records/__sender_probe_1__.ts',
      '/flow/:id/cancel ← src/records/__sender_probe_3__.ts',
      '/ai/imports/:id/undo ← src/import/workspace-api.ts',
    ],
  );
});

test('提交处的取法认得接口表的写法：call() 按键里的方法算读写，键不写在调用处也记在发请求那一行，两个文件发同一个写地址照样拦', () => {
  const head = "import { call } from '../ui/index';\nconst records = call();\n";
  const samples = [
    { file: 'src/records/__sender_probe_5__.ts', text: head + "export const save = (body: unknown) => records('POST /customers', { body });" },
    { file: 'src/records/__sender_probe_6__.ts', text: head + "export const list = () => records('GET /customers', { query: { q: '虚构' } });" },
    { file: 'src/editors/__sender_probe_7__.ts', text: head + "export const again = (body: unknown) => records('POST /customers', { body });" },
    // 键不直接写在调用处（对象元素、数组元素、函数返回值）：发送记在真正调 records 的那一行
    {
      file: 'src/operations/__sender_probe_8__.ts',
      text:
        head +
        "const keys = { save: 'POST /suppliers' } as const;\nconst list = ['PUT /suppliers/:id'] as const;\nconst keyOf = () => 'POST /purchases' as const;\n" +
        "export const a = (body: unknown) => records(keys['save'], { body });\n" +
        'export const b = (body: unknown) => records(list[0], { params: { id: 1 }, body });\n' +
        'export const c = (body: unknown) => records(keyOf(), { body });',
    },
  ];
  const got = api.refsMany(samples);
  api.release(); // 这个文件最后一次取地址：类型程序约 200 MB，同进程里别的测试文件也用完才放掉
  const senders = writeSenders(
    samples.map((s, i) => ({ ...s, refs: got[i] })),
    routes,
  );
  assert.deepEqual(
    senders.map((s) => s.route + ' ← ' + s.at),
    [
      '/customers ← src/records/__sender_probe_5__.ts:3',
      '/customers ← src/editors/__sender_probe_7__.ts:3',
      '/suppliers ← src/operations/__sender_probe_8__.ts:6',
      '/suppliers/:id ← src/operations/__sender_probe_8__.ts:7',
      '/purchases ← src/operations/__sender_probe_8__.ts:8',
    ],
  );
  assert.equal(group(senders).get('/customers')?.size, 2);
});
