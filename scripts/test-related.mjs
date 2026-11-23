// 只跑和改动有关的测试：改代码过程中用，收尾再跑一次完整的 npm test。
// 用法：
//   npm run test:related                    看 git 里改过、新加的文件
//   npm run test:related -- server/core/storage/db.ts    指定文件
//   npm run test:related -- --list          只列出会跑哪些测试，不跑
//   npm run test:related -- --depth 3       放宽“有关”的范围（默认 2）
// “有关”指测试 import 的文件、或这些文件再 import 的文件（默认两层；模块的 index.ts、pages.ts 只是转一手，不算一层）里有改动的文件，
// 或者测试里按路径读了它（检查源码写法的测试），或者改的就是测试本身。
// 两层以外也可能受影响（比如 server/core/storage/db.ts 几乎人人间接在用），所以收尾必须跑完整的 npm test。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { suites } from './run-tests.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const rel = (p) => relative(root, p).replaceAll('\\', '/');
const args = process.argv.slice(2);
const listOnly = args.includes('--list');
const depthAt = args.indexOf('--depth');
const maxDepth = depthAt >= 0 ? Number(args.splice(depthAt, 2)[1]) : 2;
let changed = args.filter((a) => !a.startsWith('-')).map((a) => rel(join(root, a)));
if (!changed.length) {
  const git = spawnSync('git', ['-c', 'core.quotePath=false', 'status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8' });
  changed = git.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => l.slice(3).split(' -> ').pop().replace(/^"|"$/g, ''))
    .filter((f) => !f.startsWith('docs/'));
}

// 和 npm test 同一份列法（连子目录）；发布检查平时不在 npm test 里，改到发布、补丁、备份脚本时也一起挑出来
const { main, serial, release } = suites(root);
const testFiles = [...main, ...serial, ...release];
// 解析 import：静态 from、动态 import()、new URL('...', import.meta.url)
const importRe = /(?:from\s*|import\s*\(\s*|import\s+|new URL\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
const resolveFrom = (file, spec) => {
  const base = normalize(join(root, dirname(file), spec));
  for (const candidate of [base, base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'), base.replace(/\.mjs$/, '.mts'), base + '.ts', base + '.tsx', join(base, 'index.ts')])
    if (existsSync(candidate) && !candidate.endsWith('\\') && /\.[cm]?[jt]sx?$/.test(candidate)) return rel(candidate);
  return null;
};
const graph = new Map();
const deps = (file) => {
  if (graph.has(file)) return graph.get(file);
  const out = new Set();
  graph.set(file, out);
  let text = '';
  try {
    text = readFileSync(join(root, file), 'utf8');
  } catch {
    return out;
  }
  for (const m of text.matchAll(importRe)) {
    const target = resolveFrom(file, m[1]);
    if (target) out.add(target);
  }
  return out;
};
const isInterface = (f) => /^(server|shared|src)\/[a-z]+\/(index|pages)\.ts$/.test(f);
const closure = (file) => {
  const seen = new Set([file]);
  let layer = [file];
  for (let depth = 0; depth < maxDepth && layer.length; depth++) {
    const next = [];
    // 跨模块都走接口文件，它只是转一手：放回本层接着展开，不占层数
    for (let i = 0; i < layer.length; i++)
      for (const d of deps(layer[i]))
        if (!seen.has(d)) {
          seen.add(d);
          (isInterface(d) ? layer : next).push(d);
        }
    layer = next;
  }
  return seen;
};
const picked = testFiles.filter((t) => {
  if (changed.includes(t)) return true;
  const reach = closure(t);
  if (changed.some((c) => reach.has(c))) return true;
  const text = readFileSync(join(root, t), 'utf8');
  // 按路径读文件的写法：路径前后是引号或“/”，避免 nul 这种短名字被当成 null 的一部分
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return changed.some((c) => new RegExp('[\'"`/]' + escape(c) + '[\'"`]').test(text));
});
// 测试夹具改了，用到它的测试都算有关（上面的 import 闭包已包含）
console.log('改动：' + (changed.join('、') || '无'));
console.log(`有关的测试 ${picked.length} / ${testFiles.length} 个文件` + (picked.length ? '：\n  ' + picked.join('\n  ') : ''));
if (listOnly || !picked.length) process.exit(0);
// 交给 npm test 同一个跑法（分组、模块只加载一次；串行组最后单独跑）
const run = spawnSync(process.execPath, [join(root, 'scripts/run-tests.mjs'), ...picked], { cwd: root, stdio: 'inherit' });
process.exit(run.status ?? 1);
