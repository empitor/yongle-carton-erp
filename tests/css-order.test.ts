// 样式的加载顺序只在 src/main.tsx 写一处（顺序就是优先级）：
// - 页面里不 import 样式，src/ 下每份样式都在 main.tsx 里引入一次；
// - 同一主题分成几份（x.css、x-2.css、x-3.css）时按序号排；
// - main.tsx 里“// 排在 a、b 之后”写的是这一份要压过的文件，那几份必须排在它前面（调顺序时这条会拦住）。
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import test from 'node:test';

const src = 'src';
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
  );
const all = files(src).map((f) => relative(src, f).split(sep).join(posix.sep));
const imports = (text: string) =>
  [...text.matchAll(/^\s*import\s+['"]([^'"]+\.css)['"]/gm)].map((m) => m[1]);
const main = readFileSync(join(src, 'main.tsx'), 'utf8');
const listed = imports(main).map((f) => f.replace(/^\.\//, ''));

test('样式只在 main.tsx 引入，页面里 import 会让结果取决于先打开哪个页面', () => {
  const offenders = all
    .filter((f) => /\.(ts|tsx)$/.test(f) && f !== 'main.tsx')
    .filter((f) => imports(readFileSync(join(src, f), 'utf8')).length);
  assert.deepEqual(offenders.map((f) => f + '：删掉这里的样式 import，改在 src/main.tsx 引入'), []);
});

test('每份样式都在 main.tsx 里引入，且只引入一次', () => {
  assert.equal(new Set(listed).size, listed.length, '有样式引入了两次');
  const styles = all.filter((f) => f.endsWith('.css'));
  assert.deepEqual(styles.filter((f) => !listed.includes(f)).map((f) => f + '：没在 src/main.tsx 引入，按它要压过的样式排好位置加一行 import'), []);
  assert.deepEqual(listed.filter((f) => !styles.includes(f)).map((f) => f + '：src/main.tsx 引入的样式已经不在了，删掉这行 import'), []);
});

test('同一主题的几份按序号排', () => {
  const wrong = listed.flatMap((f, i) => {
    const m = f.match(/^(.*)-(\d+)\.css$/);
    if (!m) return [];
    const prev = Number(m[2]) === 2 ? m[1] + '.css' : m[1] + '-' + (Number(m[2]) - 1) + '.css';
    return listed.includes(prev) && listed.indexOf(prev) < i ? [] : [f + ' 应排在 ' + prev + ' 后面'];
  });
  assert.deepEqual(wrong, []);
});

test('“排在……之后”写的文件都排在前面', () => {
  const lines = main.split('\n');
  const wrong: string[] = [];
  lines.forEach((line, i) => {
    const m = line.match(/^\/\/ 排在 (.+) 之后$/);
    if (!m) return;
    const self = imports(lines[i + 1] ?? '')[0]?.replace(/^\.\//, '');
    assert.ok(self, '第 ' + (i + 1) + ' 行的说明下面要紧跟一行样式 import');
    for (const before of m[1].split('、'))
      if (!listed.includes(before) || listed.indexOf(before) > listed.indexOf(self))
        wrong.push(self + ' 要排在 ' + before + ' 后面');
  });
  assert.deepEqual(wrong, []);
});
