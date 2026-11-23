// 界面流程的组表（scripts/ui-check/run.mjs 的 groups）：scripts/ui-check/ 下每个 flow-*.mjs 都在某一组里（不然 npm run test:ui 永远不跑），
// 组表里写的流程脚本都存在，一个流程只在一组里。只读组表和目录，不起浏览器、不构建。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { flowFile, groups } from '../../scripts/ui-check/run.mjs';

const TABLE = 'scripts/ui-check/run.mjs 的组表';

/** groups：组表；files：scripts/ui-check/ 下的文件名。每处对不上的写明哪个文件、怎么改 */
function groupProblems(table, files) {
  const owners = new Map();
  for (const g of table) for (const flow of g.flows) owners.set(flowFile(flow), [...(owners.get(flowFile(flow)) ?? []), g.name]);
  const flows = files.filter((f) => /^flow-.+\.mjs$/.test(f));
  return [
    ...flows.filter((f) => !owners.has(f)).map((f) => `${f} 不在${TABLE}里，npm run test:ui 永远不跑它；写进一组`),
    ...[...owners].filter(([f]) => !files.includes(f)).map(([f, gs]) => `${TABLE}里 ${gs.join('、')} 组的 ${f} 不存在；改组表或补上脚本`),
    ...[...owners].filter(([, gs]) => gs.length > 1).map(([f, gs]) => `${f} 同时在 ${gs.join('、')} 组里，会跑两遍；只留一组`),
  ];
}

test('scripts/ui-check/ 下每个流程脚本都在某一组里，组表里写的都存在、只在一组里', () => {
  const files = readdirSync(fileURLToPath(new URL('../../scripts/ui-check/', import.meta.url)));
  assert.deepEqual(groupProblems(groups, files), []);
});

test('流程脚本没进组、组表写了不存在的、一个流程进了两组：都报出来', () => {
  const table = [
    { name: 'a', flows: ['one', 'gone'] },
    { name: 'b', flows: ['one'] },
  ];
  assert.deepEqual(groupProblems(table, ['flow-one.mjs', 'flow-new.mjs', 'lib.mjs']), [
    `flow-new.mjs 不在${TABLE}里，npm run test:ui 永远不跑它；写进一组`,
    `${TABLE}里 a 组的 flow-gone.mjs 不存在；改组表或补上脚本`,
    'flow-one.mjs 同时在 a、b 组里，会跑两遍；只留一组',
  ]);
});

test('组表和流程脚本对得上：不报', () => {
  assert.deepEqual(groupProblems([{ name: 'a', flows: ['one', 'two'] }], ['flow-one.mjs', 'flow-two.mjs', 'lib.mjs', 'run.mjs']), []);
});
