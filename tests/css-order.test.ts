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

test('样式只在 main.tsx 引入，页面里 import 会让结果取决于先打开哪个页面', () => {
  const offenders = all
    .filter((f) => /\.(ts|tsx)$/.test(f) && f !== 'main.tsx')
    .filter((f) => imports(readFileSync(join(src, f), 'utf8')).length);
  assert.deepEqual(offenders, []);
});

test('design.css 最后加载，所有样式文件都已引入', () => {
  const listed = imports(readFileSync(join(src, 'main.tsx'), 'utf8')).map((f) => f.replace(/^\.\//, ''));
  assert.equal(listed.at(-1), 'design.css');
  assert.deepEqual([...listed].sort(), all.filter((f) => f.endsWith('.css')).sort());
});
