// 业务数据变了（业务版本号、退货版本号）重读的调用方：版本号作为 useLoad 的第三个参数 refresh（useRecordData 是第四个），
// 不拼进 key——拼进去，一变就当换了一份，先闪读取中、旧内容也不留。读法见 use-load-refresh.test.ts（仓库里没有能跑 effect 的渲染器，核对源码）。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

/** 取出 name( 开头那一次调用的各个顶层参数（按括号、引号配对，不被嵌套的逗号带偏） */
function callArguments(source: string, name: string, from = 0): string[] {
  const start = source.indexOf(name + '(', from);
  assert.ok(start >= 0, '找不到 ' + name + '(');
  const args: string[] = [];
  let depth = 0,
    quote = '',
    last = start + name.length + 1;
  for (let i = last; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
    } else if (c === "'" || c === '"' || c === '`') quote = c;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) {
      if (depth === 0) {
        const tail = source.slice(last, i).trim();
        if (tail) args.push(tail);
        return args;
      }
      depth--;
    } else if (c === ',' && depth === 0) {
      args.push(source.slice(last, i).trim());
      last = i + 1;
    }
  }
  throw new Error(name + '( 没有配上右括号');
}

const read = (file: string) => readFileSync(new URL('../../' + file, import.meta.url), 'utf8');

/** [文件, 调用名, 从哪段文字之后找, refresh 在第几个参数（从 0 数）, refresh 的样子, key 里不许有的字] */
const callers: [string, string, string, number, RegExp, RegExp][] = [
  ['src/flow/useFlowList.ts', 'useLoad', '', 2, /^revision$/, /revision/],
  ['src/warehouse/useWarehouseData.ts', 'useLoad', 'const main', 2, /^revision$/, /revision/],
  ['src/warehouse/useWarehouseData.ts', 'useLoad', 'const archived', 2, /^revision$/, /revision/],
  ['src/flow/FlowDocView.tsx', 'useLoad', 'function useFlowRecord', 2, /revision/i, /revision|version/i],
  ['src/flow/ArrivalReturns.tsx', 'useLoad', '', 2, /^revision$/, /revision/],
  ['src/operations/BatchCard.tsx', 'useLoad', '', 2, /^revision$/, /revision/],
  ['src/records/DashboardPage.tsx', 'useLoad', 'function OverviewSection', 2, /^revision$/, /revision/],
  ['src/records/MovementsPage.tsx', 'useRecordData', '', 3, /^p\.revision$/, /revision/],
  ['src/records/purchase-page-data.ts', 'useRecordData', '', 3, /^p\.revision$/, /revision/],
  ['src/records/StockPage.tsx', 'useRecordData', '', 3, /^p\.revision$/, /revision/],
  ['src/records/SuppliersPage.tsx', 'useRecordData', '', 3, /^p\.revision$/, /revision/],
];

for (const [file, name, after, index, refresh, notInKey] of callers) {
  test(file + (after ? '（' + after + '）' : '') + '：版本号当 refresh 传，不拼进 key', () => {
    const source = read(file);
    const args = callArguments(source, name, after ? source.indexOf(after) : 0);
    assert.equal(args.length, index + 1, '参数个数不对：' + args.length);
    assert.match(args[index], refresh, 'refresh 位置：' + args[index]);
    assert.doesNotMatch(args[0], notInKey, 'key 里不要再拼版本号：' + args[0]);
  });
}

test('useRecordData 把 refresh 原样传给 useLoad', () => {
  const source = read('src/records/useRecordPage.ts');
  const body = source.slice(source.indexOf('export function useRecordData'));
  assert.match(body, /refresh\?: unknown\) \{/);
  assert.deepEqual(callArguments(body, 'useLoad'), ['key', 'load', 'refresh']);
});
