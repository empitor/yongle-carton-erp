// npm run test:coverage 跑完后的覆盖检查：各组 lcov 合并（一行在哪组跑到过都算），
// 列出 server/、shared/ 里行覆盖低于 80%、没在 scripts/test-exemptions.mjs 登记原因的文件。
// 没有一条测试加载过的文件不在 lcov 里，按 0% 算；只有类型、编译后没有代码的文件不算。
// 登记了原因、但已经达标或文件没了的也让检查失败（登记表要跟着删）。
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

export const MIN_LINES = 80;
export const COVERED_DIRS = ['server', 'shared'];

/** 几份 lcov 文本 → { 文件: Map(行号 → 跑到次数) }，同一文件在几组里出现时按行取最大 */
export function mergeLcov(texts, root) {
  const files = {};
  const base = root.replaceAll('\\', '/').toLowerCase();
  for (const text of texts) {
    let lines = null;
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (line.startsWith('SF:')) {
        const path = line.slice(3).replaceAll('\\', '/');
        const rel = path.toLowerCase().startsWith(base) ? path.slice(base.length) : path;
        lines = files[rel] ??= new Map();
      } else if (line.startsWith('DA:') && lines) {
        const [no, hits] = line.slice(3).split(',').map(Number);
        lines.set(no, Math.max(lines.get(no) ?? 0, hits));
      } else if (line === 'end_of_record') lines = null;
    }
  }
  return files;
}

/** 每个文件的行覆盖百分比（没有可执行行的算 100） */
export const lineRates = (merged) =>
  Object.fromEntries(
    Object.entries(merged).map(([f, lines]) => {
      const hit = [...lines.values()].filter((n) => n > 0).length;
      return [f, lines.size ? (hit / lines.size) * 100 : 100];
    }),
  );

const sources = (root, dir) =>
  readdirSync(join(root, dir), { recursive: true })
    .map((f) => (dir + '/' + f).replaceAll('\\', '/'))
    .filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.d.ts'));

/** 编译后还有代码（不是只有类型声明） */
const hasCode = (root, file) =>
  ts
    .transpileModule(readFileSync(join(root, file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, removeComments: true } })
    .outputText.replace('export {};', '')
    .trim() !== '';

/** 低于门槛的文件：unregistered 没登记，stale 登记了但已达标或文件没了 */
export function lowCoverage(root, rates, exempt) {
  const all = COVERED_DIRS.flatMap((d) => sources(root, d)).filter((f) => f in rates || hasCode(root, f));
  const low = all.map((f) => ({ file: f, rate: rates[f] ?? 0, loaded: f in rates })).filter((x) => x.rate < MIN_LINES);
  const lowSet = new Set(low.map((x) => x.file));
  return {
    unregistered: low.filter((x) => !exempt[x.file]).sort((a, b) => a.rate - b.rate),
    registered: low.filter((x) => exempt[x.file]),
    stale: Object.keys(exempt).filter((f) => !lowSet.has(f)),
  };
}

/** 打印低覆盖文件；返回要让检查失败的个数：没登记的，加上登记了但已达标或文件没了的 */
export function reportCoverage(root, lcovTexts, exempt) {
  const merged = mergeLcov(lcovTexts, root);
  const { unregistered, registered, stale } = lowCoverage(root, lineRates(merged), exempt);
  if (unregistered.length) {
    console.log(`${COVERED_DIRS.join('/、')}/ 里行覆盖低于 ${MIN_LINES}%、没登记原因的文件 ${unregistered.length} 个（补测试，或在 scripts/test-exemptions.mjs 登记原因）：`);
    for (const x of unregistered) {
      console.log(`  ${x.rate.toFixed(1).padStart(5)}%  ${x.file}${x.loaded ? '' : '（没有测试加载过）'}`);
      if (x.loaded) console.log('    未覆盖行：' + [...merged[x.file]].filter(([, hits]) => hits === 0).map(([line]) => line).join(', '));
    }
  } else console.log(`${COVERED_DIRS.join('/、')}/ 里没有行覆盖低于 ${MIN_LINES}% 又没登记的文件。`);
  if (registered.length) console.log(`登记过原因的低覆盖文件 ${registered.length} 个，不报。`);
  if (stale.length) console.log('登记了但已经达标或文件没了，这一轮算失败；从 scripts/test-exemptions.mjs 删掉：\n  ' + stale.join('\n  '));
  return unregistered.length + stale.length;
}
